#!/usr/bin/env node
// tools/laptop/train.mjs — per-regime confluence weight fitting.
//
// Slices the graded ledger by the TA regime at call time (bull_trend/
// overbought = bull tape; bear_trend/oversold = bear tape; choppy), fits
// the logistic feature model per slice, and prints the suggested
// config:flow_weights JSON per regime. With a young ledger it will say
// "not enough data" per slice — that is the honest answer until the
// ledger matures. Run monthly; apply only when a slice has 30+ graded.
//
// Usage:  node tools/laptop/train.mjs [--api URL]

import { fetchLedger, fetchPrices, buildFeatureRows, logisticFit } from "./research.mjs";

const DEFAULT_API = "https://whalesignal-bot.sthidontknow.workers.dev";
const args = process.argv.slice(2);
const apiIdx = args.indexOf("--api");
const api = apiIdx >= 0 ? args[apiIdx + 1] : DEFAULT_API;

console.error("[train] pulling ledger + prices…");
const [events, prices] = await Promise.all([fetchLedger(api), fetchPrices()]);
const rows = buildFeatureRows(events, prices);

// regime groups (mirrors the TA engine's semantics)
const GROUPS = {
  bull: ["bull_trend", "overbought"],
  bear: ["bear_trend", "oversold"],
  choppy: ["choppy", "unknown"],
};

// map fit coefficients → confluence weight suggestions. Conservative:
// only the tape weight scales with the model's trend coefficient, and
// only when the slice has enough data for the fit to mean anything.
function suggest(fit) {
  if (!fit.enough_data || fit.n < 30) return { enough_data: false, n: fit.n };
  const trendStrength = Math.max(0, Math.min(0.12, Math.abs(fit.weights.ema_gap_adj) * 0.02 + 0.05));
  return {
    enough_data: true,
    n: fit.n,
    train_accuracy: fit.train_accuracy,
    flow_weights: { tape: +trendStrength.toFixed(3) },
  };
}

const out = { generated_at: Date.now(), regimes: {} };
for (const [name, regimes] of Object.entries(GROUPS)) {
  const slice = rows.filter((r) => regimes.includes(r.regime));
  const fit = logisticFit(slice);
  out.regimes[name] = suggest(fit);
  console.log(`${name}: ${out.regimes[name].enough_data
    ? `n=${out.regimes[name].n}, train acc ${out.regimes[name].train_accuracy}% → config:flow_weights_${name} ${JSON.stringify(out.regimes[name].flow_weights)}`
    : `not enough data (n=${out.regimes[name].n}, need 30+)`}`);
}
console.error("\napply (only slices with enough data):");
console.error(`  npx wrangler kv key put "config:flow_weights" '<json>' --remote`);
console.error("production merges fitted weights over the defaults per event (RESEARCH.md §3).");
