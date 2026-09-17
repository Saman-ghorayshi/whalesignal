#!/usr/bin/env node
// tools/laptop/research.mjs — the laptop-layer research harness (run for as
// long as you like; it is idempotent and network-light).
//
// Pulls the graded ledger from the public API, enriches each graded
// directional event with price-path features (RSI, EMA gap, realized vol,
// size band), then reports:
//   1. per-feature hit-rates (does each confluence feature actually predict?)
//   2. a logistic fit over the features → SUGGESTED confluence weights
//
// Output: docs/data/research/feature_report.json (commit it — the dashboard
// can render the calibration), plus a printed table. The weights it suggests
// are NOT auto-applied: review, then
//   npx wrangler kv key put "config:flow_weights" '<json>' --remote
// and production picks them up per event (the adaptive loop, RESEARCH.md §3).
//
// Usage: node tools/laptop/research.mjs [--api URL] [--out FILE]

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { volSpikeClass } from "../../src/worker-utils.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_API = "https://whalesignal-bot.sthidontknow.workers.dev";
const DAY = 86_400_000;

// ─── data plumbing ────────────────────────────────────────────────────

async function fetchLedger(api) {
  const events = [];
  for (const signal of ["bullish", "bearish"]) {
    for (let page = 1; page <= 30; page++) {
      const res = await fetch(`${api}/history?limit=100&page=${page}&signal=${signal}`);
      if (!res.ok) throw new Error(`history ${signal} p${page}: HTTP ${res.status}`);
      const j = await res.json();
      events.push(...(j.alerts || []));
      if ((j.alerts || []).length < 100) break;
    }
  }
  return events;
}

async function fetchPrices() {
  const out = {};
  for (const [coin, id] of [["btc", "bitcoin"], ["eth", "ethereum"]]) {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=90`, { headers: { "User-Agent": "whalesignal-research/1.0" } });
    if (!res.ok) throw new Error(`coingecko ${coin}: HTTP ${res.status}`);
    const j = await res.json();
    out[coin] = (j.prices || []).map(([ts, price]) => ({ ts, price }));
  }
  return out;
}

function priceAt(series, ts) {
  if (!series?.length) return null;
  let best = null;
  for (const p of series) { if (p.ts <= ts) best = p; else break; }
  if (!best || ts - best.ts > 1.5 * DAY) return null;
  return best.price;
}

// ─── TA features (mirrors src/ta.js — laptop copy for offline use) ────

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return ag === 0 ? 50 : 100;
  return Math.round((100 - 100 / (1 + ag / al)) * 100) / 100;
}

function ema(closes, n) {
  if (closes.length < n) return null;
  const k = 2 / (n + 1);
  let e = closes.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (let i = n; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function regimeAt(series, ts) {
  const upto = series.filter((p) => p.ts <= ts).slice(-400);
  if (upto.length < 51) return { regime: "unknown", rsi14: null, emaGap: null };
  const closes = upto.map((p) => p.price);
  const r = rsi(closes, 14);
  const f = ema(closes, 20), s = ema(closes, 50);
  const last = closes[closes.length - 1];
  let regime = "choppy";
  if (r <= 30) regime = "oversold";
  else if (r >= 70) regime = "overbought";
  else if (f > s && last > f) regime = "bull_trend";
  else if (f < s && last < f) regime = "bear_trend";
  return { regime, rsi14: r, emaGap: s ? Math.round(((f - s) / s) * 100 * 100) / 100 : null };
}

// realized vol over the 24h AFTER detection (for the vol-spike angle)
function realizedVol(series, ts) {
  const upto = series.filter((p) => p.ts >= ts && p.ts <= ts + DAY).map((p) => p.price);
  if (upto.length < 6) return null;
  const rets = [];
  for (let i = 1; i < upto.length; i++) rets.push(Math.log(upto[i] / upto[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.round((Math.sqrt(varr * 24) * 100) * 100) / 100; // dailyized %
}

// ─── feature matrix ───────────────────────────────────────────────────

export function buildFeatureRows(events, prices) {
  const rows = [];
  for (const e of events) {
    const chain = String(e.chain || "").toLowerCase() === "eth" ? "eth" : "btc";
    const series = prices[chain];
    const p1 = priceAt(series, e.detected_at);
    const p2 = priceAt(series, e.detected_at + DAY);
    if (!p1 || !p2) continue; // outside price coverage — skip, count later
    const movePct = ((p2 - p1) / p1) * 100;
    let outcome = null;
    if (Math.abs(movePct) >= 1) outcome = (e.signal === "bullish") === (movePct > 0) ? "correct" : "wrong";
    else outcome = "no_move";
    const { regime, rsi14, emaGap } = regimeAt(series, e.detected_at);
    rows.push({
      signal: e.signal,
      symbol: e.symbol,
      chain,
      confidence: e.confidence ?? null,
      usd: e.usd_value ?? null,
      detected_at: e.detected_at,
      regime,
      rsi14,
      emaGap,
      hour_utc: new Date(e.detected_at).getUTCHours(),
      vol24: realizedVol(series, e.detected_at),
      movePct: Math.round(movePct * 100) / 100,
      outcome,
    });
  }
  return rows;
}

export function hitRates(rows) {
  const agg = {};
  const add = (key) => {
    agg[key] = agg[key] || { graded: 0, correct: 0, wrong: 0 };
    agg[key].graded++;
    if (rows.outcome === "correct") agg[key].correct++;
    if (rows.outcome === "wrong") agg[key].wrong++;
  };
  return { add, agg };
}

/** Per-flow-class historical P(24h realized vol >= 2%) — the Herremans-style
 *  direction-agnostic signal. Published to config:vol_spikes for alerts. */
export function volSpikeClasses(rows) {
  const m = {};
  for (const r of rows) {
    if (r.vol24 == null) continue;
    const k = volSpikeClass(r.chain, r.tx_type, r.usd);
    m[k] = m[k] || { n: 0, spikes: 0 };
    m[k].n++;
    if (r.vol24 >= 2) m[k].spikes++;
  }
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { n: v.n, pct: Math.round((v.spikes / v.n) * 100) }]).filter(([, v]) => v.n >= 5));
}

export function summarize(rows) {
  const rate = (list) => {
    const dir = list.filter((r) => r.outcome === "correct" || r.outcome === "wrong");
    const c = dir.filter((r) => r.outcome === "correct").length;
    return { graded: list.length, directional: dir.length, correct: c, rate: dir.length ? Math.round((c / dir.length) * 100) : null };
  };
  const group = (key) => {
    const m = {};
    for (const r of rows) { const k = String(r[key] ?? "unknown"); (m[k] = m[k] || []).push(r); }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, rate(v)]));
  };
  return {
    overall: rate(rows),
    by_confidence: group("confidence"),
    by_regime: group("regime"),
    by_signal: group("signal"),
    by_symbol: group("symbol"),
    by_tx_type: group("tx_type"),
    vol_spike_rate: (() => {
      const withVol = rows.filter((r) => r.vol24 != null);
      const spikes = withVol.filter((r) => r.vol24 >= 2).length;
      return withVol.length ? Math.round((spikes / withVol.length) * 100) : null;
    })(),
  };
}

// ─── logistic fit (zero-dependency) ───────────────────────────────────

export function logisticFit(rows, { iters = 4000, lr = 0.1 } = {}) {
  const data = rows
    .filter((r) => (r.outcome === "correct" || r.outcome === "wrong") &&
      r.rsi14 != null && r.emaGap != null && r.usd != null)
    .map((r) => {
      const dirNum = r.signal === "bullish" ? 1 : -1;
      return {
        y: r.outcome === "correct" ? 1 : 0,
        x: [
          1,                                        // bias
          (r.rsi14 - 50) / 50 * dirNum,             // RSI distance, direction-adjusted
          Math.max(-5, Math.min(5, r.emaGap / 5)) * dirNum, // EMA gap, clipped
          Math.log10(r.usd) - 6,                    // log size ($1M → 0)
        ],
      };
    });
  if (data.length < 20) return { enough_data: false, n: data.length };
  const w = [0, 0, 0, 0];
  const sig = (z) => 1 / (1 + Math.exp(-z));
  for (let it = 0; it < iters; it++) {
    const grad = [0, 0, 0, 0];
    for (const d of data) {
      const p = sig(w.reduce((s, wi, i) => s + wi * d.x[i], 0));
      const err = p - d.y;
      for (let i = 0; i < 4; i++) grad[i] += err * d.x[i];
    }
    for (let i = 0; i < 4; i++) w[i] -= (lr / data.length) * grad[i];
  }
  let correct = 0;
  for (const d of data) {
    const p = sig(w.reduce((s, wi, i) => s + wi * d.x[i], 0));
    if ((p >= 0.5 ? 1 : 0) === d.y) correct++;
  }
  return {
    enough_data: true,
    n: data.length,
    weights: { bias: +w[0].toFixed(3), rsi_adj: +w[1].toFixed(3), ema_gap_adj: +w[2].toFixed(3), log_size: +w[3].toFixed(3) },
    train_accuracy: Math.round((correct / data.length) * 100),
    note: "train accuracy on the ledger itself — the honest number comes from out-of-sample weeks, not this fit",
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const invoked = import.meta.url === pathToFileURL(process.argv[1]).href || args.includes("--run");
if (invoked) {
  const apiIdx = args.indexOf("--api");
  const api = apiIdx >= 0 ? args[apiIdx + 1] : DEFAULT_API;
  console.error("[research] pulling graded ledger…");
  const events = await fetchLedger(api);
  console.error(`[research] ${events.length} directional events`);
  console.error("[research] pulling 90d hourly prices…");
  const prices = await fetchPrices();
  const rows = buildFeatureRows(events, prices);
  const summary = summarize(rows);
  const volSpikes = volSpikeClasses(rows);
  const fit = logisticFit(rows);
  const report = { generated_at: Date.now(), events: events.length, feature_rows: rows.length, summary, logistic: fit, vol_spikes: volSpikes };
  const outDir = join(HERE, "..", "..", "docs", "data", "research");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "feature_report.json");
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log("═══ WhaleSignal feature research ═══");
  console.log(`events ${summary.overall.graded}  directional ${summary.overall.directional}  accuracy ${summary.overall.rate == null ? "—" : summary.overall.rate + "%"}`);
  for (const [k, v] of Object.entries(summary.by_regime)) console.log(`  regime ${k.padEnd(11)} rate ${v.rate == null ? "—" : v.rate + "%"}  (n=${v.directional})`);
  for (const [k, v] of Object.entries(summary.by_confidence)) console.log(`  conf    ${k.padEnd(11)} rate ${v.rate == null ? "—" : v.rate + "%"}  (n=${v.directional})`);
  if (summary.vol_spike_rate != null) console.log(`  vol-spike (≥2% dailyized) rate: ${summary.vol_spike_rate}%`);
  console.log(`logistic fit: ${fit.enough_data ? `n=${fit.n}, train acc ${fit.train_accuracy}%, weights ${JSON.stringify(fit.weights)}` : `not enough data (n=${fit.n}, need 20+)`}`);
  console.error(`report → ${outFile}`);
}
