// tests/sprint5.test.js — free-forever rollups: accumulator folding and
// statement generation. Pure-function coverage; runtime flush is best-effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newRollupAcc, accWhale, rollupStatements, autoPauseState } from "../src/scanner.js";

const HOUR = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000);

test("accWhale: totals, hourly buckets, and per-symbol counters", () => {
  const acc = newRollupAcc(HOUR);
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 1_000_000, tx_type: "wallet_to_wallet", from_address: "a", to_address: "b" });
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 2_000_000, tx_type: "exchange_inflow", from_address: "a", to_address: "BINANCE1" }, "Binance");
  assert.equal(acc.totals.whales, 2);
  assert.equal(acc.totals.volume, 3_000_000);
  assert.equal(acc.totals.tick_max_usd, 2_000_000);
  const h = acc.hours.get("btc");
  assert.equal(h.events, 2);
  assert.equal(h.volume_usd, 3_000_000);
  assert.equal(h.inflow_usd, 2_000_000);
  assert.equal(h.inflow_count, 1);
  assert.equal(acc.symbols.get("BTC").count, 2);
  assert.equal(acc.symbols.get("BTC").volume, 3_000_000);
});

test("accWhale: exchange flow buckets use the label, edges fold inflow/outflow flags", () => {
  const acc = newRollupAcc(HOUR);
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 5_000_000, tx_type: "exchange_inflow", from_address: "whale1", to_address: "BINANCE1" }, "Binance");
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 3_000_000, tx_type: "exchange_outflow", from_address: "BINANCE1", to_address: "whale1" }, "Binance");
  const x = acc.exflow.get("btc|Binance");
  assert.equal(x.inflow_usd, 5_000_000);
  assert.equal(x.outflow_usd, 3_000_000);
  assert.equal(x.inflow_count, 1);
  assert.equal(x.outflow_count, 1);
  // edges are DIRECTED: whale→exchange (deposit) and exchange→whale
  // (withdrawal) are separate edges with opposite meanings — the graph
  // colors them differently.
  assert.equal(acc.edges.size, 2);
  const dep = acc.edges.get('btc|whale1|BINANCE1');
  assert.equal(dep.volume_usd, 5_000_000);
  assert.equal(dep.inflow_cnt, 1);
  const wd = acc.edges.get('btc|BINANCE1|whale1');
  assert.equal(wd.volume_usd, 3_000_000);
  assert.equal(wd.outflow_cnt, 1);
  // self-transfers never become edges
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 1_000_000, tx_type: "wallet_to_wallet", from_address: "same", to_address: "same" });
  assert.equal(acc.edges.size, 2);
});

test("accWhale: unlabeled exchange flow falls back to a truncated address", () => {
  const acc = newRollupAcc(HOUR);
  accWhale(acc, { chain: "eth", symbol: "ETH", usd_value: 900_000, tx_type: "exchange_inflow", from_address: "0xw", to_address: "0x1234567890abcdef1234" }, null);
  const x = acc.exflow.get("eth|0x1234567890…");
  assert.ok(x, "should bucket under the truncated label");
  assert.equal(x.inflow_count, 1);
});

test("rollupStatements: one batch with counters, hours, exflows, edges, symbols", () => {
  const acc = newRollupAcc(HOUR);
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 1_000_000, tx_type: "exchange_inflow", from_address: "w", to_address: "BINANCE1" }, "Binance");
  const stmts = rollupStatements(acc);
  const sqls = stmts.map((s) => s.sql);
  // 2 counters (totals + largest) + 1 hourly + 1 exflow + 1 edge + 2 symbol counters
  assert.equal(stmts.length, 7);
  assert.match(sqls[0], /total_whales/);
  assert.match(sqls[1], /largest_transfer/);
  assert.ok(sqls.some((s) => /hourly_stats/.test(s)));
  assert.ok(sqls.some((s) => /exchange_netflow_hourly/.test(s)));
  assert.ok(sqls.some((s) => /flow_edges_hourly/.test(s)));
  // every statement carries its binds
  for (const s of stmts) assert.ok(Array.isArray(s.binds));
  const totals = stmts[0];
  assert.deepEqual(totals.binds, [1, 1_000_000]);
  // empty accumulator still yields the two counter statements (0-delta)
  const empty = rollupStatements(newRollupAcc(HOUR));
  assert.equal(empty.length, 2);
  assert.deepEqual(empty[0].binds, [0, 0]);
});

test("autoPauseState: guard pause active until until-passes, then expired", () => {
  const now = 10_000;
  assert.deepEqual(autoPauseState({ until: 20_000, reason: "d1_read_cap" }, now), { active: true, expired: false });
  assert.deepEqual(autoPauseState({ until: 5_000, reason: "d1_read_cap" }, now), { active: false, expired: true });
  assert.deepEqual(autoPauseState(null, now), { active: false, expired: false });
  assert.deepEqual(autoPauseState({}, now), { active: false, expired: false });
});

// ─── accountability engine: grading, buckets, scoreboard ─────────────
import { gradeSignal, confidenceBucket, renderScoreboard, renderWalletJSON } from "../src/bot.js";

test("gradeSignal: bullish/bearish × move direction matrix", () => {
  assert.equal(gradeSignal("bullish", 100, 102), "correct");   // +2%
  assert.equal(gradeSignal("bullish", 100, 98), "wrong");      // −2%
  assert.equal(gradeSignal("bearish", 100, 98), "correct");
  assert.equal(gradeSignal("bearish", 100, 102), "wrong");
  assert.equal(gradeSignal("bullish", 100, 100.5), "no_move"); // <1%
  assert.equal(gradeSignal("bearish", 100, 100.9), "no_move");
  assert.equal(gradeSignal("bullish", null, 102), "no_data");
  assert.equal(gradeSignal("bullish", 100, null), "no_data");
  assert.equal(gradeSignal("bullish", 0, 102), "no_data");
  assert.equal(gradeSignal("neutral", 100, 102), "no_data");
  // threshold is configurable
  assert.equal(gradeSignal("bullish", 100, 100.5, 0.3), "correct");
});

test("confidenceBucket: high ≥0.75, mid ≥0.60, low below", () => {
  assert.equal(confidenceBucket(0.82), "high");
  assert.equal(confidenceBucket(0.75), "high");
  assert.equal(confidenceBucket(0.7), "mid");
  assert.equal(confidenceBucket(0.6), "mid");
  assert.equal(confidenceBucket(0.55), "low");
  assert.equal(confidenceBucket(null), "low");
});

test("renderScoreboard: rates, calls, and the honesty footer", () => {
  const text = renderScoreboard({
    graded24: 14, correct24: 9, wrong24: 3, nomove24: 2,
    accuracy: { total: 48, correct: 31 },
    topCalls: [{
      usd_value: 425_289_098, symbol: "BTC", signal: "bearish", confidence: 0.6,
      prediction_outcome: "correct", price_at_detect: 75_000, price_at_eval: 73_650,
    }],
  });
  assert.match(text, /Graded last 24h: 14/);
  assert.match(text, /Running accuracy: 65%/);
  assert.match(text, /✅ CORRECT/);
  assert.match(text, /-1.8% in 24h/);
  assert.match(text, /No cherry-picking/);
  const empty = renderScoreboard({ graded24: 0, correct24: 0, wrong24: 0, nomove24: 0, accuracy: null, topCalls: [] });
  assert.match(empty, /first grades land/);
});

test("renderWalletJSON: track_record appears once graded, absent at 0", () => {
  const profile = { address: "0xw", chain: "eth", label: "W", type: "whale", reputation: null, tx_count: 4, total_volume: 1, first_seen: 1, last_seen: 2 };
  const withTrack = renderWalletJSON(profile, [], null, [], { graded: 8, correct: 5 });
  assert.deepEqual(withTrack.track_record, { graded: 8, correct: 5, rate: 63 });
  const ungraded = renderWalletJSON(profile, [], null, [], { graded: 0, correct: 0 });
  assert.equal(ungraded.track_record, null);
});

// ─── market cache fallback (CoinGecko → Coinbase, never clobber good cache) ──
import { buildMarketCache } from "../src/scanner.js";

test("buildMarketCache: coingecko data wins, coinbase fills gaps, nulls never clobber", () => {
  const cg = { bitcoin: { usd: 60_000, usd_24h_change: -2.1 }, ethereum: { usd: 3_000, usd_24h_change: 1.0 } };
  const full = buildMarketCache({ cg, btcSpot: 1, ethSpot: 2, fg: { data: [{ value: "69", value_classification: "Greed" }] } });
  assert.equal(full.btc.price, 60_000);
  assert.equal(full.eth.price, 3_000);
  assert.equal(full.wbtc.price, 60_000);
  assert.equal(full.fear_greed, 69);

  // coingecko 429 → coinbase spot fills in
  const fallback = buildMarketCache({ cg: null, btcSpot: 61_000, ethSpot: 3_100 });
  assert.equal(fallback.btc.price, 61_000);
  assert.equal(fallback.eth.price, 3_100);
  assert.equal(fallback.btc.change_24h, null, "no 24h change from spot fallback");

  // both sources dead → null (caller must NOT overwrite the KV cache)
  assert.equal(buildMarketCache({ cg: null, btcSpot: null, ethSpot: null }), null);

  // partial: only BTC available still yields a usable cache
  const partial = buildMarketCache({ cg: null, btcSpot: 61_000, ethSpot: null });
  assert.equal(partial.btc.price, 61_000);
  assert.equal(partial.eth.price, null);
});
