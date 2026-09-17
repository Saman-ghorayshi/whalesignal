#!/usr/bin/env node
// tools/laptop/retro.mjs — RETRO-ANALYSIS: re-score the ENTIRE historical
// flow database with today's confluence model and grade the results
// against real prices.
//
// Why this matters: the live grading ledger only contains events since the
// model went live (~1 day). But the whales table holds 100K+ historical
// flows — inflows/outflows the CURRENT model would have flagged, priced at
// their own detection moment. This tool replays the model over that
// history and answers the question the young ledger can't: "would today's
// model have been right, across every market regime of the past 90 days?"
//
// Caveats (honest):
//   - news/derivatives features are unavailable retroactively → the model
//     runs without them (flow + behavior + TA regime only). The report
//     labels this mode.
//   - historical events were stored under the OLD extraction (pre
//     largest-output) — BTC direction attribution is noisier on old rows.
//   - grading uses the same vol-adaptive 24h window as production.
//
// Usage: node tools/laptop/retro.mjs [--api URL] [--out FILE] [--min-usd 1000000] [--max-pages 400]

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { flowConfidence } from "../../src/analyst.js";
import { volThreshold } from "../../src/bot.js";
import { volSpikeClass } from "../../src/worker-utils.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_API = "https://whalesignal-bot.sthidontknow.workers.dev";
const DAY = 86_400_000;

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? (isNaN(Number(args[i + 1])) ? args[i + 1] : Number(args[i + 1])) : def;
};

async function fetchAllFlows(api, { maxPages = 400, minUsd = 0, delayMs = 250 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${api}/history?limit=100&page=${page}&min_usd=${minUsd}`);
    if (!res.ok) throw new Error(`history p${page}: HTTP ${res.status}`);
    const j = await res.json();
    const alerts = j.alerts || [];
    rows.push(...alerts);
    if (alerts.length < 100) break;
    if (page % 10 === 0) console.error(`  … ${rows.length} rows (page ${page})`);
    await new Promise((r) => setTimeout(r, delayMs)); // polite: shared free API
  }
  return rows;
}

async function fetchPrices() {
  const out = {};
  for (const [coin, id] of [["btc", "bitcoin"], ["eth", "ethereum"]]) {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=90`, { headers: { "User-Agent": "whalesignal-retro/1.0" } });
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
  if (upto.length < 51) return "unknown";
  const closes = upto.map((p) => p.price);
  const r = rsi(closes, 14), f = ema(closes, 20), s = ema(closes, 50);
  const last = closes[closes.length - 1];
  if (r <= 30) return "oversold";
  if (r >= 70) return "overbought";
  if (f > s && last > f) return "bull_trend";
  if (f < s && last < f) return "bear_trend";
  return "choppy";
}

const STABLES = new Set(["USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDP"]);

function simulateFlow(flow, prices, threshold) {
  const chain = String(flow.chain || "").toLowerCase() === "eth" ? "eth" : "btc";
  const series = prices[chain];
  const sym = String(flow.symbol || "").toUpperCase();
  const isIn = flow.tx_type === "exchange_inflow";
  const isStable = STABLES.has(sym);
  if (flow.tx_type !== "exchange_inflow" && flow.tx_type !== "exchange_outflow") return null;
  const bullish = isStable ? isIn : !isIn;
  const taRegime = regimeAt(series, flow.detected_at);
  const { confidence, features } = flowConfidence({
    bullish,
    taRegime,
    hugeUnlabeled: (flow.usd_value || 0) >= 100_000_000,
  });
  const p1 = priceAt(series, flow.detected_at);
  const p2 = priceAt(series, flow.detected_at + DAY);
  if (!p1 || !p2) return { chain, sym, signal: bullish ? "bullish" : "bearish", confidence, taRegime, outcome: "skipped", movePct: null, features, usd: flow.usd_value, detected_at: flow.detected_at };
  const movePct = ((p2 - p1) / p1) * 100;
  let outcome = "no_move";
  if (Math.abs(movePct) >= threshold) outcome = (bullish ? movePct > 0 : movePct < 0) ? "correct" : "wrong";
  return { chain, sym, signal: bullish ? "bullish" : "bearish", confidence, taRegime, outcome, movePct: Math.round(movePct * 100) / 100, features, usd: flow.usd_value, detected_at: flow.detected_at };
}

const invoked = import.meta.url === pathToFileURL(process.argv[1]).href || args.includes("--run");
if (invoked) {
  const api = arg("--api", DEFAULT_API);
  const minUsd = arg("--min-usd", 1_000_000);
  const out = arg("--out", join(HERE, "..", "..", "docs", "data", "research", "retro_report.json"));

  console.error("[retro] pulling prices…");
  const prices = await fetchPrices();
  const thresholds = {
    btc: volThreshold(prices.btc.slice(-168)),
    eth: volThreshold(prices.eth.slice(-168)),
  };
  console.error(`[retro] vol thresholds: BTC ${thresholds.btc}% / ETH ${thresholds.eth}%`);
  console.error("[retro] pulling historical flows (this can take ~10 min)…");
  const flows = await fetchAllFlows(api, { minUsd, maxPages: arg("--max-pages", 400) });
  console.error(`[retro] ${flows.length} historical flows pulled — simulating…`);

  const simulated = [];
  for (const f of flows) {
    const r = simulateFlow(f, prices, thresholds[String(f.chain).toLowerCase()] || 1.0);
    if (r) simulated.push(r);
  }

  const directional = simulated.filter((r) => r.outcome === "correct" || r.outcome === "wrong");
  const correct = directional.filter((r) => r.outcome === "correct").length;
  const group = (key) => {
    const m = {};
    for (const r of directional) { const k = String(r[key] ?? "unknown"); (m[k] = m[k] || []).push(r); }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => {
      const c = v.filter((r) => r.outcome === "correct").length;
      return [k, { directional: v.length, rate: Math.round((c / v.length) * 100) }];
    }));
  };
  const highConf = directional.filter((r) => (r.confidence || 0) >= 0.65);
  const highCorrect = highConf.filter((r) => r.outcome === "correct").length;

  const report = {
    generated_at: Date.now(),
    mode: "retro (flow + behavior + TA only — no news/derivatives available historically)",
    flows_pulled: flows.length,
    flows_simulated: simulated.length,
    directional: directional.length,
    accuracy: directional.length ? Math.round((correct / directional.length) * 100) : null,
    high_confidence: { directional: highConf.length, rate: highConf.length ? Math.round((highCorrect / highConf.length) * 100) : null },
    by_regime: group("taRegime"),
    by_signal: group("signal"),
    by_symbol: group("sym"),
    thresholds,
  };
  console.log("═══ WhaleSignal RETRO-ANALYSIS ═══");
  console.log(`simulated: ${report.flows_simulated}   directional: ${report.directional}   accuracy: ${report.accuracy == null ? "—" : report.accuracy + "%"}`);
  console.log(`high-confidence (≥0.65): ${report.high_confidence.directional} calls → ${report.high_confidence.rate == null ? "—" : report.high_confidence.rate + "%"}`);
  for (const [k, v] of Object.entries(report.by_regime)) console.log(`  regime ${k.padEnd(11)} ${String(v.directional).padStart(5)} calls  ${v.rate}%`);
  for (const [k, v] of Object.entries(report.by_signal)) console.log(`  ${k.padEnd(8)} ${String(v.directional).padStart(5)} calls  ${v.rate}%`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.error(`report → ${out}`);
}
