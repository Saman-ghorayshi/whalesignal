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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRICE_CACHE = join(HERE, "..", "docs", "data", "prices", "btc_eth_daily.json");
const DEFAULT_API = "https://whalesignal-bot.sthidontknow.workers.dev";
const THRESHOLD_PCT = 1.0;
const DAY_MS = 86_400_000;

// ─── prices ───────────────────────────────────────────────────────────

async function fetchPriceSeries(coin, days = 90) {
  const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const res = await fetch(url, { headers: { "User-Agent": "whalesignal-backtest/1.0" } });
  if (!res.ok) throw new Error(`coingecko ${coin}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.prices || []).map(([ts, price]) => ({ ts, price }));
}

export async function loadPrices({ refresh = false } = {}) {
  if (!refresh && existsSync(PRICE_CACHE)) {
    const cached = JSON.parse(readFileSync(PRICE_CACHE, "utf8"));
    const ageDays = (Date.now() - cached.fetched_at) / DAY_MS;
    if (ageDays < 2) return cached;
    console.error(`[backtest] price cache is ${ageDays.toFixed(1)}d old — refreshing`);
  }
  const [btc, eth] = await Promise.all([fetchPriceSeries("bitcoin"), fetchPriceSeries("ethereum")]);
  const out = { fetched_at: Date.now(), btc, eth };
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
    note: acc(graded).directional < 30
      ? "fewer than 30 graded directional calls — this is noise, not an edge"
      : null,
  };
  return out;
}

function avg(arr) {
  return arr.length ? Math.round((arr.reduce((s, n) => s + n, 0) / arr.length) * 100) / 100 : null;
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
  L.push("by symbol:");
  for (const [s, v] of Object.entries(summary.by_symbol)) {
    L.push(`  ${s.padEnd(5)} directional ${String(v.directional).padStart(4)}  rate ${v.rate == null ? "—" : v.rate + "%"}`);
  }
  return L.join("\n");
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}` || args.includes("--run")) {
  const refresh = args.includes("--refresh");
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  const apiIdx = args.indexOf("--api");
  const api = apiIdx >= 0 ? args[apiIdx + 1] : DEFAULT_API;

  console.error("[backtest] loading prices…");
  const prices = await loadPrices({ refresh });
  console.error("[backtest] fetching directional events from the public API…");
  const events = await fetchDirectionalEvents(api);
  const graded = events.map((e) => {
    const g = gradeEvent(e, prices);
    return { signal: e.signal, symbol: e.symbol, confidence: e.confidence, detected_at: e.detected_at, ...g, bucket: confidenceBucket(e.confidence) };
  });
  const summary = summarize(graded);
  console.log(renderReport(summary));
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ generated_at: Date.now(), summary, graded }, null, 2));
    console.error(`[backtest] JSON report → ${jsonOut}`);
  }
}
