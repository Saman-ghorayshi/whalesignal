// tests/sprint4.test.js — Sprint 4: directional templates, plumbing valve,
// /netflow, /graph, wallet flow stats. All pure-function coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropPlumbing, DEFAULT_INTERNAL_FLOOR, extractCandidatesBTC } from "../src/scanner.js";
import { renderNetflowJSON, renderGraphJSON, flowDirection, renderWalletJSON } from "../src/bot.js";
import { templateAnalysis } from "../src/analyst.js";

// ─── scanner: plumbing valve ──────────────────────────────────────────

test("dropPlumbing: drops exchange_internal under the floor, keeps everything else", () => {
  const rows = [
    { tx_hash: "a", tx_type: "exchange_internal", usd_value: 1_000_000 },  // plumbing → drop
    { tx_hash: "b", tx_type: "exchange_internal", usd_value: 9_000_000 },  // big treasury op → keep
    { tx_hash: "c", tx_type: "exchange_inflow", usd_value: 500_000 },      // directional → keep
    { tx_hash: "d", tx_type: "wallet_to_wallet", usd_value: 600_000 },     // keep
  ];
  const out = dropPlumbing(rows, DEFAULT_INTERNAL_FLOOR);
  assert.deepEqual(out.map((r) => r.tx_hash), ["b", "c", "d"]);
});

test("dropPlumbing: floor=0 disables the valve; missing usd treated as 0", () => {
  const rows = [{ tx_hash: "a", tx_type: "exchange_internal", usd_value: 100 }];
  assert.equal(dropPlumbing(rows, 0).length, 1);
  assert.equal(dropPlumbing([{ tx_hash: "b", tx_type: "exchange_internal" }]).length, 0);
  assert.equal(dropPlumbing(null).length, 0);
});

// ─── scanner: BTC largest-single-output semantics (regression guard) ──

const BTC_MARKET = { btc: { price: 60_000 } };

test("extractCandidatesBTC: exchange sweep with many outputs yields ONE candidate per leg, not a fake giant", () => {
  const block = {
    height: 1,
    time: 1_700_000_000,
    tx: [{
      hash: "sweep",
      inputs: [{ prev_out: { addr: "coldwallet" } }],
      out: [
        { addr: "user1", value: 6 * 1e8 },     // 6 BTC = $360K
        { addr: "user2", value: 9 * 1e8 },     // 9 BTC = $540K
        { addr: "coldwallet", value: 100 * 1e8 }, // change — skipped
      ],
    }],
  };
  const out = extractCandidatesBTC(block, BTC_MARKET);
  assert.equal(out.length, 1);
  assert.equal(out[0].to_address, "user2");      // largest non-change output
  assert.equal(out[0].amount, 9);                // NOT 115 BTC
  assert.equal(out[0].usd_value, 540_000);
});

// ─── /netflow renderer ────────────────────────────────────────────────

test("renderNetflowJSON: net inflow > 5% of gross → bearish_pressure", () => {
  const totals = [
    { chain: "btc", symbol: "BTC", inflow_usd: 80_000_000, outflow_usd: 10_000_000, inflow_count: 40, outflow_count: 5 },
  ];
  const p = renderNetflowJSON(totals, [], 24, null);
  assert.equal(p.ok, true);
  assert.equal(p.totals.inflow_usd, 80_000_000);
  assert.equal(p.totals.net_inflow_usd, 70_000_000);
  assert.equal(p.totals.bias, "bearish_pressure");
  assert.match(p.totals.interpretation, /bearish/i);
  assert.equal(p.by_chain.length, 1);
  assert.equal(p.by_chain[0].net_inflow_usd, 70_000_000);
});

test("renderNetflowJSON: net outflow → bullish_pressure", () => {
  const totals = [
    { chain: "eth", symbol: "ETH", inflow_usd: 5_000_000, outflow_usd: 60_000_000, inflow_count: 4, outflow_count: 30 },
  ];
  const p = renderNetflowJSON(totals, [], 168, "eth");
  assert.equal(p.totals.bias, "bullish_pressure");
  assert.equal(p.chain, "eth");
  assert.equal(p.window_hours, 168);
  assert.match(p.totals.interpretation, /accumulation/i);
});

test("renderNetflowJSON: balanced when |net| under 5% of gross; empty window handled", () => {
  const balanced = renderNetflowJSON(
    [{ chain: "btc", symbol: "BTC", inflow_usd: 10_000_000, outflow_usd: 10_500_000, inflow_count: 2, outflow_count: 2 }],
    [], 24, null
  );
  assert.equal(balanced.totals.bias, "balanced");
  const empty = renderNetflowJSON([], [], 24, null);
  assert.equal(empty.ok, true);
  assert.equal(empty.totals.bias, "balanced");
  assert.equal(empty.totals.inflow_usd, 0);
  assert.match(empty.totals.interpretation, /No directional/i);
});

test("renderNetflowJSON: merges per-exchange legs and reports net per exchange", () => {
  const perExchange = [
    { chain: "btc", exchange: "Binance", inflow_usd: 30_000_000, outflow_usd: 5_000_000, inflow_count: 10, outflow_count: 2 },
    { chain: "btc", exchange: "Coinbase", inflow_usd: 1_000_000, outflow_usd: 20_000_000, inflow_count: 1, outflow_count: 8 },
  ];
  const p = renderNetflowJSON([], perExchange, 24, null);
  const binance = p.by_exchange.find((e) => e.exchange === "Binance");
  const coinbase = p.by_exchange.find((e) => e.exchange === "Coinbase");
  assert.equal(binance.net_inflow_usd, 25_000_000);
  assert.equal(coinbase.net_inflow_usd, -19_000_000);
  assert.equal(binance.events, 12);
});

// ─── /graph renderer ──────────────────────────────────────────────────

const WALLET_ROWS = [
  { address: "0xAAA", chain: "eth", label: "Binance Hot Wallet", type: "exchange" },
  { address: "0xaaa", chain: "eth", label: "Binance Hot Wallet", type: "exchange" },
  { address: "bc1qwhale", chain: "btc", label: null, type: "whale" },
];

test("renderGraphJSON: builds chain-scoped nodes with labels and aggregated edges", () => {
  const edges = [
    { chain: "eth", from_address: "0xaaa", to_address: "0xBBB", volume: 5_000_000, cnt: 2, inflow_cnt: 2, outflow_cnt: 0, last_seen: 111 },
    { chain: "btc", from_address: "bc1qwhale", to_address: "bc1qbinance", volume: 12_000_000, cnt: 1, inflow_cnt: 1, outflow_cnt: 0, last_seen: 222 },
  ];
  const p = renderGraphJSON(edges, WALLET_ROWS, { windowHours: 24, chain: null, minUsd: 0 });
  assert.equal(p.ok, true);
  assert.equal(p.nodes.length, 4); // eth:0xaaa, eth:0xBBB, btc:bc1qwhale, btc:bc1qbinance
  const binanceNode = p.nodes.find((n) => n.id === "eth:0xaaa");
  assert.equal(binanceNode.label, "Binance Hot Wallet"); // lowercase evm fallback matches
  assert.equal(binanceNode.type, "exchange");
  const btcNode = p.nodes.find((n) => n.id === "btc:bc1qwhale");
  assert.equal(btcNode.type, "whale");
  const unlabeled = p.nodes.find((n) => n.id === "btc:bc1qbinance");
  assert.equal(unlabeled.label, null);
  assert.equal(unlabeled.type, "unknown");
  // node volume accumulates from its edges
  assert.equal(binanceNode.volume, 5_000_000);
  assert.equal(p.edges[0].source, "eth:0xaaa");
  assert.equal(p.edges[0].volume_usd, 5_000_000);
  assert.equal(p.max_edge_volume, 12_000_000);
});

test("renderGraphJSON: empty window still returns a valid payload", () => {
  const p = renderGraphJSON([], [], { windowHours: 24, chain: "btc", minUsd: 1_000_000 });
  assert.equal(p.ok, true);
  assert.equal(p.nodes.length, 0);
  assert.equal(p.edges.length, 0);
  assert.equal(p.chain, "btc");
});

// ─── wallet flow direction ────────────────────────────────────────────

test("flowDirection: accumulator / distributor / balanced / null", () => {
  assert.equal(flowDirection({ deposited_to_exchange: 1_000_000, withdrawn_from_exchange: 9_000_000 }).direction, "accumulator");
  assert.equal(flowDirection({ deposited_to_exchange: 9_000_000, withdrawn_from_exchange: 1_000_000 }).direction, "distributor");
  assert.equal(flowDirection({ deposited_to_exchange: 5_000_000, withdrawn_from_exchange: 5_500_000 }).direction, "balanced");
  assert.equal(flowDirection({ deposited_to_exchange: 0, withdrawn_from_exchange: 0 }), null);
  assert.equal(flowDirection(null), null);
  const acc = flowDirection({ deposited_to_exchange: 1_000_000, withdrawn_from_exchange: 9_000_000 });
  assert.equal(acc.net_exchange_usd, 8_000_000);
});

test("renderWalletJSON: additive flow + top_counterparties fields", () => {
  const profile = { address: "0xw", chain: "eth", label: "Whale One", type: "whale", reputation: null, tx_count: 4, total_volume: 20_000_000, first_seen: 1, last_seen: 2 };
  const flow = { deposited_to_exchange: 2_000_000, withdrawn_from_exchange: 8_000_000, sent_total: 12_000_000, received_total: 8_000_000, events: 4 };
  const counterparties = [
    { counterparty: "0xbinance", volume: 9_000_000, cnt: 3, last_seen: 999 },
  ];
  const p = renderWalletJSON(profile, [], flow, counterparties);
  assert.equal(p.ok, true);
  assert.equal(p.flow.direction, "accumulator");
  assert.equal(p.flow.net_exchange_usd, 6_000_000);
  assert.equal(p.top_counterparties[0].address, "0xbinance");
  assert.equal(p.top_counterparties[0].volume_usd, 9_000_000);
  // legacy shape untouched
  assert.deepEqual(p.recent_txs, []);
  // 404 shape unchanged
  assert.equal(renderWalletJSON(null, []).ok, false);
});

// ─── directional templates (sprint 4 regression guard) ────────────────

test("templateAnalysis: every exchange inflow/outflow now yields a directional signal", () => {
  const cases = [
    { tx: { tx_type: "exchange_inflow", usd_value: 6_000_000, symbol: "BTC" }, market: null, expected: "bearish" },
    { tx: { tx_type: "exchange_outflow", usd_value: 6_000_000, symbol: "BTC" }, market: null, expected: "bullish" },
    { tx: { tx_type: "exchange_inflow", usd_value: 6_000_000, symbol: "BTC" }, market: { fear_greed: 20, fear_greed_label: "Fear" }, expected: "bearish" },
    { tx: { tx_type: "exchange_outflow", usd_value: 6_000_000, symbol: "BTC" }, market: { fear_greed: 80, fear_greed_label: "Greed" }, expected: "bullish" },
  ];
  for (const c of cases) {
    const r = templateAnalysis(c.tx, c.market, []);
    assert.equal(r?.signal, c.expected, `${c.tx.tx_type} with market=${c.market ? c.market.fear_greed : "null"} → ${c.expected}`);
  }
});

// ─── D1 payload cache (read-budget survival) ──────────────────────────
import { cachedPayload } from "../src/bot.js";

function fakeCacheEnv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { reads: 0, writes: 0 };
  const env = {
    calls, store,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                calls.reads++;
                if (!/FROM stats_cache/.test(sql)) throw new Error("unexpected query");
                const row = store.get(args[0]);
                return row ? { payload: row.payload, updated_at: row.updated_at } : null;
              },
              async run() {
                calls.writes++;
                const k = args[0];
                const existing = store.get(k);
                if (/ON CONFLICT/.test(sql) || !existing) {
                  store.set(k, { payload: args[1], updated_at: args[2] });
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
  return env;
}

test("cachedPayload: first call computes, second within TTL serves the cache", async () => {
  const env = fakeCacheEnv();
  let computes = 0;
  const compute = async () => ({ n: ++computes });
  const a = await cachedPayload(env, "k1", compute, 60_000);
  const b = await cachedPayload(env, "k1", compute, 60_000);
  assert.equal(a.n, 1);
  assert.equal(b.n, 1, "second call must come from cache");
  assert.equal(computes, 1);
});

test("cachedPayload: after TTL it recomputes and overwrites", async () => {
  const env = fakeCacheEnv();
  let computes = 0;
  const compute = async () => ({ n: ++computes });
  await cachedPayload(env, "k2", compute, 1); // ttl 1ms
  await new Promise((r) => setTimeout(r, 5));
  const again = await cachedPayload(env, "k2", compute, 1);
  assert.equal(again.n, 2);
});

test("cachedPayload: when compute throws, stale cache is served instead of failing", async () => {
  const env = fakeCacheEnv();
  await cachedPayload(env, "k3", async () => ({ good: true }), 1);
  await new Promise((r) => setTimeout(r, 5));
  const stale = await cachedPayload(env, "k3", async () => { throw new Error("read cap"); }, 1);
  assert.equal(stale.good, true, "stale payload must be served during an outage");
  await assert.rejects(() => cachedPayload(env, "k4", async () => { throw new Error("boom"); }, 1000));
});

// ─── cap-guard hardening: quantized params + pause merge ─────────────
import { quantizeWindow, quantizeGraphParams } from "../src/bot.js";
import { autoPauseState } from "../src/scanner.js";

test("quantizeWindow: arbitrary values snap to fixed tiers so cache keys can't explode", () => {
  assert.equal(quantizeWindow(24), 24);
  assert.equal(quantizeWindow(25), 24);
  assert.equal(quantizeWindow(60), 72);
  assert.equal(quantizeWindow(1), 24);
  assert.equal(quantizeWindow(9999), 720);
  assert.equal(quantizeWindow("garbage"), 24);
});

test("quantizeGraphParams: min_usd and limit snap to tiers", () => {
  assert.deepEqual(quantizeGraphParams(2_500_000, 37), { minUsd: 1_000_000, limit: 30 });
  assert.deepEqual(quantizeGraphParams(0, 99999), { minUsd: 0, limit: 150 });
  assert.deepEqual(quantizeGraphParams("x", "y"), { minUsd: 0, limit: 10 });
});

test("autoPauseState: guard pause active until until-passes, then expired", () => {
  const now = 10_000;
  assert.deepEqual(autoPauseState({ until: 20_000, reason: "d1_read_cap" }, now), { active: true, expired: false });
  assert.deepEqual(autoPauseState({ until: 5_000, reason: "d1_read_cap" }, now), { active: false, expired: true });
  assert.deepEqual(autoPauseState(null, now), { active: false, expired: false });
  assert.deepEqual(autoPauseState({}, now), { active: false, expired: false });
});
