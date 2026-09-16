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
