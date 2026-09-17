#!/usr/bin/env node
// tools/backtest.mjs — replay the directional signal ledger against real
// historical prices and report accuracy overall, by confidence bucket, by
// signal, and by symbol. This is the edge-measurement tool: the paper
// trader should only ever be as trusted as what this file reports.
//
// Data sources (all free, zero D1 read budget):
//   events — the public /history API (signal=bullish|bearish, paginated)
//   prices — CoinGecko daily market_chart, cached to docs/data/prices/
//
// Usage:
//   node tools/backtest.mjs                 # use cached prices if present
//   node tools/backtest.mjs --refresh       # force price re-fetch
//   node tools/backtest.mjs --json out.json # also write a JSON report
//
// Honesty rules:
//   - grades use the SAME 1% threshold as the live grading worker
//   - events without a resolvable price are counted as skipped, not hidden
//   - accuracy on <30 graded calls is noise; the report says so

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { taSnapshot } from "../src/ta.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRICE_CACHE = join(HERE, "..", "docs", "data", "prices", "btc_eth_daily.json");
const DEFAULT_API = "https://whalesignal-bot.sthidontknow.workers.dev";
const THRESHOLD_PCT = 1.0;
const DAY_MS = 86_400_000;

// ─── prices ───────────────────────────────────────────────────────────

async function fetchPriceSeries(coin, days = 90) {
  // no interval param → CoinGecko auto-granularity: HOURLY for ≤90 days.
  // Daily candles were too coarse to grade 24h calls fairly.
  const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: { "User-Agent": "whalesignal-backtest/1.0" } });
  if (!res.ok) throw new Error(`coingecko ${coin}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.prices || []).map(([ts, price]) => ({ ts, price }));
}

export async function loadPrices({ refresh = false } = {}) {
  if (!refresh && existsSync(PRICE_CACHE)) {
    const cached = JSON.parse(readFileSync(PRICE_CACHE, "utf8"));
    const ageH = (Date.now() - cached.fetched_at) / 3_600_000;
    if (ageH < 12 && cached.granularity === "hourly") return cached;
    console.error(`[backtest] price cache stale/wrong-granularity — refreshing`);
  }
  const [btc, eth] = await Promise.all([fetchPriceSeries("bitcoin"), fetchPriceSeries("ethereum")]);
  const out = { fetched_at: Date.now(), granularity: "hourly", btc, eth };
  mkdirSync(dirname(PRICE_CACHE), { recursive: true });
  writeFileSync(PRICE_CACHE, JSON.stringify(out));
  return out;
}

/**
 * Price at (or nearest before) a timestamp. Returns null outside the
 * series' coverage — grading against a stale last-known price would
 * fabricate outcomes, so uncovered events are skipped, never guessed.
 */
export function priceAt(series, ts) {
  if (!series?.length) return null;
  let best = null;
  for (const p of series) {
    if (p.ts <= ts) best = p;
    else break;
  }
  if (!best) return null; // before the series starts
  if (ts - best.ts > 1.5 * DAY_MS) return null; // beyond the series end
  return best;
}

// ─── grading (mirrors the live worker's semantics) ────────────────────

export function gradeEvent(event, prices, thresholdPct = THRESHOLD_PCT) {
  const series = String(event.chain || "").toLowerCase() === "eth" ? prices.eth : prices.btc;
  const p1 = priceAt(series, event.detected_at);
  const p2 = priceAt(series, event.detected_at + DAY_MS);
  if (!p1 || !p2 || !(p1.price > 0)) return { outcome: "skipped", movePct: null };
  const movePct = ((p2.price - p1.price) / p1.price) * 100;
  if (Math.abs(movePct) < thresholdPct) return { outcome: "no_move", movePct };
  const correct = event.signal === "bullish" ? movePct > 0 : movePct < 0;
  return { outcome: correct ? "correct" : "wrong", movePct };
}

export function confidenceBucket(conf) {
  const c = Number(conf) || 0;
  if (c >= 0.75) return "high";
  if (c >= 0.6) return "mid";
  return "low";
}

// ─── summarize (pure, unit-tested) ────────────────────────────────────

export function summarize(graded) {
  const total = graded.length;
  const acc = (rows) => {
    const dir = rows.filter((r) => r.outcome === "correct" || r.outcome === "wrong");
    const correct = dir.filter((r) => r.outcome === "correct").length;
    return { graded: rows.length, directional: dir.length, correct,
             rate: dir.length ? Math.round((correct / dir.length) * 100) : null };
  };
  const buckets = {};
  for (const b of ["high", "mid", "low"]) buckets[b] = acc(graded.filter((r) => r.bucket === b));
  const bySignal = {};
  for (const s of ["bullish", "bearish"]) {
    const rows = graded.filter((r) => r.signal === s);
    bySignal[s] = { ...acc(rows), avgMovePct: avg(rows.map((r) => r.movePct).filter((m) => m != null)) };
  }
  const byRegime = {};
  for (const r of graded) {
    byRegime[r.regime] = byRegime[r.regime] || [];
    byRegime[r.regime].push(r);
  }
  const bySymbol = {};
  for (const r of graded) {
    bySymbol[r.symbol] = bySymbol[r.symbol] || [];
    bySymbol[r.symbol].push(r);
  }
  const out = {
    total_events: total,
    overall: acc(graded),
    by_confidence: buckets,
    by_signal: bySignal,
    by_symbol: Object.fromEntries(Object.entries(bySymbol).map(([s, rows]) => [s, acc(rows)])),
    by_regime: Object.fromEntries(Object.entries(byRegime).map(([s, rows]) => [s, acc(rows)])),
    note: acc(graded).directional < 30
      ? "fewer than 30 graded directional calls — this is noise, not an edge"
      : null,
  };
  return out;
}

function avg(arr) {
  return arr.length ? Math.round((arr.reduce((s, n) => s + n, 0) / arr.length) * 100) / 100 : null;
}

/**
 * Market baseline: over the price series, what fraction of non-overlapping
 * 24h windows moved ≥+1% (up), ≤−1% (down), or flat? In a pure uptrend ALL
 * bullish calls "look" right without any skill — the edge metric compares
 * call accuracy against these base rates.
 */
export function baselineStats(series, thresholdPct = THRESHOLD_PCT) {
  if (!series?.length) return null;
  let up = 0, down = 0, flat = 0, n = 0;
  for (let i = 0; i + 24 < series.length; i += 24) {
    const p1 = series[i].price, p2 = series[i + 24].price;
    if (!(p1 > 0)) continue;
    const move = ((p2 - p1) / p1) * 100;
    n++;
    if (move >= thresholdPct) up++;
    else if (move <= -thresholdPct) down++;
    else flat++;
  }
  if (!n) return null;
  return { windows: n, up_pct: Math.round((up / n) * 100), down_pct: Math.round((down / n) * 100), flat_pct: Math.round((flat / n) * 100) };
}

/**
 * Pure: attach market-baseline edges to a summary. bullish edge = bullish
 * accuracy − market up-rate; bearish edge = bearish accuracy − market
 * down-rate. Positive edge = actual skill beyond just riding the trend.
 */
export function withBaseline(summary, baseline) {
  if (!baseline) return { ...summary, market_baseline: null, edge: null };
  const b = summary.by_signal || {};
  const edge = {
    bullish: b.bullish?.rate != null ? b.bullish.rate - baseline.up_pct : null,
    bearish: b.bearish?.rate != null ? b.bearish.rate - baseline.down_pct : null,
  };
  return { ...summary, market_baseline: baseline, edge };
}

// ─── event fetching (public API only) ─────────────────────────────────

export async function fetchDirectionalEvents(api = DEFAULT_API, maxPages = 20) {
  const events = [];
  for (const signal of ["bullish", "bearish"]) {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`${api}/history?limit=100&page=${page}&signal=${signal}`);
      if (!res.ok) throw new Error(`history ${signal} p${page}: HTTP ${res.status}`);
      const j = await res.json();
      const alerts = j.alerts || [];
      events.push(...alerts);
      if (alerts.length < 100) break;
    }
  }
  return events;
}

// ─── CLI ──────────────────────────────────────────────────────────────

function renderReport(summary) {
  const L = [];
  const o = summary.overall;
  L.push("═══ WhaleSignal backtest — directional calls vs. real prices ═══");
  L.push(`events: ${summary.total_events}   directional: ${o.directional}   accuracy: ${o.rate == null ? "n/a" : o.rate + "%"} (${o.correct}/${o.directional})`);
  if (summary.market_baseline) {
    const b = summary.market_baseline;
    L.push(`market baseline (24h windows): +1% up ${b.up_pct}% · −1% down ${b.down_pct}% · flat ${b.flat_pct}%`);
    if (summary.edge) {
      const e = summary.edge;
      L.push(`EDGE vs baseline: bullish ${e.bullish == null ? "—" : (e.bullish > 0 ? "+" : "") + e.bullish + "pp"} · bearish ${e.bearish == null ? "—" : (e.bearish > 0 ? "+" : "") + e.bearish + "pp"}   (positive = skill beyond riding the trend)`);
    }
  }
  if (summary.note) L.push(`⚠ ${summary.note}`);
  L.push("");
  L.push("by confidence:");
  for (const [b, s] of Object.entries(summary.by_confidence)) {
    L.push(`  ${b.padEnd(5)} graded ${String(s.graded).padStart(4)}  directional ${String(s.directional).padStart(4)}  rate ${s.rate == null ? "—" : s.rate + "%"}`);
  }
  L.push("by signal:");
  for (const [s, v] of Object.entries(summary.by_signal)) {
    L.push(`  ${s.padEnd(8)} directional ${String(v.directional).padStart(4)}  rate ${v.rate == null ? "—" : v.rate + "%"}  avg 24h move after call: ${v.avgMovePct == null ? "—" : v.avgMovePct + "%"}${s === "bullish" ? " (positive is good)" : " (negative is good)"}`);
  }
  L.push("by market regime at call time:");
  for (const [s, v] of Object.entries(summary.by_regime || {})) {
    L.push("  " + s.padEnd(12) + " directional " + String(v.directional).padStart(4) + "  rate " + (v.rate == null ? "—" : v.rate + "%"));
  }
  L.push("by symbol:");
  for (const [s, v] of Object.entries(summary.by_symbol)) {
    L.push(`  ${s.padEnd(5)} directional ${String(v.directional).padStart(4)}  rate ${v.rate == null ? "—" : v.rate + "%"}`);
  }
  return L.join("\n");
}

const args = process.argv.slice(2);
const invoked = import.meta.url === pathToFileURL(process.argv[1]).href || args.includes("--run");
if (invoked) {
  const refresh = args.includes("--refresh");
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  const apiIdx = args.indexOf("--api");
  const api = apiIdx >= 0 ? args[apiIdx + 1] : DEFAULT_API;

  console.error("[backtest] loading prices…");
  const prices = await loadPrices({ refresh });
  console.error("[backtest] fetching directional events from the public API…");
  const events = await fetchDirectionalEvents(api);
  const seriesFor = (e) => (String(e.chain || '').toLowerCase() === 'eth' ? prices.eth : prices.btc);
  const graded = events.map((e) => {
    const g = gradeEvent(e, prices);
    const s = seriesFor(e);
    const upto = s ? s.filter((p) => p.ts <= e.detected_at).slice(-400) : [];
    const regime = upto.length >= 51 ? taSnapshot(upto).regime : 'unknown';
    return { signal: e.signal, symbol: e.symbol, confidence: e.confidence, detected_at: e.detected_at, regime, ...g, bucket: confidenceBucket(e.confidence) };
  });
  const summary0 = summarize(graded);
  const baseline = baselineStats(prices.btc);
  const summary = withBaseline(summary0, baseline);
  console.log(renderReport(summary));
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ generated_at: Date.now(), summary, graded }, null, 2));
    console.error(`[backtest] JSON report → ${jsonOut}`);
  }
}
