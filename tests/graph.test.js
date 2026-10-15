// tests/graph.test.js
// Tests forensic pattern detection, graph payload construction, and bot endpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWalletPatterns, buildGraphPayload } from "../src/graph-analyst.js";
import { fetchHandler } from "../src/bot.js";

const TARGET_WALLET = "0x1111111111111111111111111111111111111111";
const CP_WALLET_A   = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CP_WALLET_B   = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CP_WALLET_C   = "0xcccccccccccccccccccccccccccccccccccccccc";
const CP_WALLET_D   = "0xdddddddddddddddddddddddddddddddddddddddd";
const BINANCE_ADDR  = "0x28c6c06298d514de13c02684fa65b7c0c1f723e4";

test("analyzeWalletPatterns detects wash trading loops between two wallets", () => {
  const txs = [
    {
      from_address: TARGET_WALLET,
      to_address: CP_WALLET_A,
      usd_value: 2_000_000,
      tx_type: "wallet_to_wallet",
      symbol: "ETH",
      detected_at: 1_700_000_000_000,
    },
    {
      from_address: CP_WALLET_A,
      to_address: TARGET_WALLET,
      usd_value: 1_900_000,
      tx_type: "wallet_to_wallet",
      symbol: "ETH",
      detected_at: 1_700_001_000_000,
    },
  ];

  const analysis = analyzeWalletPatterns(txs, TARGET_WALLET);
  assert.equal(analysis.wash_loops.length, 1);
  assert.equal(analysis.wash_loops[0].counterparty, CP_WALLET_A);
  assert.ok(analysis.wash_loops[0].match_ratio >= 0.90);
  assert.ok(analysis.deception_score >= 30);
  assert.ok(analysis.flags.includes("SUSPECTED_WASH_TRADING"));
});

test("analyzeWalletPatterns detects peeling chains / layering to single-use addresses", () => {
  const txs = [
    { from_address: TARGET_WALLET, to_address: CP_WALLET_A, usd_value: 1_000_000, tx_type: "wallet_to_wallet" },
    { from_address: TARGET_WALLET, to_address: CP_WALLET_B, usd_value: 1_000_000, tx_type: "wallet_to_wallet" },
    { from_address: TARGET_WALLET, to_address: CP_WALLET_C, usd_value: 1_000_000, tx_type: "wallet_to_wallet" },
    { from_address: TARGET_WALLET, to_address: CP_WALLET_D, usd_value: 1_000_000, tx_type: "wallet_to_wallet" },
  ];

  const analysis = analyzeWalletPatterns(txs, TARGET_WALLET);
  assert.equal(analysis.is_peeling_chain, true);
  assert.ok(analysis.flags.includes("PEELING_CHAIN_LAYERING"));
  assert.ok(analysis.deception_score >= 25);
});

test("analyzeWalletPatterns detects smart accumulation during extreme fear", () => {
  const txs = [
    {
      from_address: BINANCE_ADDR,
      to_address: TARGET_WALLET,
      usd_value: 5_000_000,
      tx_type: "exchange_outflow",
      symbol: "BTC",
    },
  ];

  const market = { fear_greed: 18, fear_greed_label: "Extreme Fear" };
  const analysis = analyzeWalletPatterns(txs, TARGET_WALLET, market);

  assert.equal(analysis.behavioral_profile, "smart_accumulator");
  assert.ok(analysis.flags.includes("ACCUMULATION_DURING_EXTREME_FEAR"));
  assert.match(analysis.intent_summary, /Smart Money/i);
});

test("analyzeWalletPatterns detects panic selling during extreme fear", () => {
  const txs = [
    {
      from_address: TARGET_WALLET,
      to_address: BINANCE_ADDR,
      usd_value: 8_000_000,
      tx_type: "exchange_inflow",
      symbol: "ETH",
    },
  ];

  const market = { fear_greed: 22, fear_greed_label: "Extreme Fear" };
  const analysis = analyzeWalletPatterns(txs, TARGET_WALLET, market);

  assert.equal(analysis.behavioral_profile, "panic_seller");
  assert.ok(analysis.flags.includes("PANIC_DEPOSIT_DURING_FEAR"));
  assert.match(analysis.intent_summary, /Fear capitulation/i);
});

test("analyzeWalletPatterns correlates breaking news catalysts", () => {
  const txs = [
    {
      from_address: TARGET_WALLET,
      to_address: BINANCE_ADDR,
      usd_value: 10_000_000,
      tx_type: "exchange_inflow",
      symbol: "USDT",
    },
  ];

  const news = [
    { title: "SEC initiates urgent review of crypto ETF issuers" },
  ];

  const analysis = analyzeWalletPatterns(txs, TARGET_WALLET, null, news);
  assert.ok(analysis.news_catalysts.length > 0);
  assert.equal(analysis.news_catalysts[0].keyword, "sec");
  assert.ok(analysis.flags.some((f) => f.includes("NEWS_CATALYST_ALIGNMENT")));
});

test("analyzeWalletPatterns detects rapid structuring splits", () => {
  const now = 1_700_000_000_000;
  const txs = [
    { from_address: TARGET_WALLET, to_address: CP_WALLET_A, usd_value: 2_000_000, tx_type: "wallet_to_wallet", detected_at: now },
    { from_address: TARGET_WALLET, to_address: CP_WALLET_B, usd_value: 2_100_000, tx_type: "wallet_to_wallet", detected_at: now + 600_000 },
    { from_address: TARGET_WALLET, to_address: CP_WALLET_C, usd_value: 1_950_000, tx_type: "wallet_to_wallet", detected_at: now + 1_200_000 },
  ];

  const analysis = analyzeWalletPatterns(txs, TARGET_WALLET);
  assert.equal(analysis.is_structuring, true);
  assert.ok(analysis.flags.includes("RAPID_STRUCTURING_SPLIT"));
});

test("buildGraphPayload constructs correct nodes and directed links", () => {
  const txs = [
    {
      from_address: TARGET_WALLET,
      to_address: CP_WALLET_A,
      usd_value: 3_000_000,
      symbol: "BTC",
      chain: "btc",
    },
    {
      from_address: CP_WALLET_A,
      to_address: BINANCE_ADDR,
      usd_value: 3_000_000,
      symbol: "BTC",
      chain: "btc",
    },
  ];

  const walletMap = new Map([
    [BINANCE_ADDR, { label: "Binance 14", type: "exchange" }],
  ]);

  const graph = buildGraphPayload(txs, walletMap, TARGET_WALLET);

  assert.equal(graph.root_address, TARGET_WALLET);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.links.length, 2);
  assert.equal(graph.total_graph_volume_usd, 6_000_000);

  const binanceNode = graph.nodes.find((n) => n.id === BINANCE_ADDR);
  assert.ok(binanceNode);
  assert.equal(binanceNode.label, "Binance 14");
  assert.equal(binanceNode.type, "exchange");

  const link = graph.links.find((l) => l.source === TARGET_WALLET && l.target === CP_WALLET_A);
  assert.ok(link);
  assert.equal(link.usd_value, 3_000_000);
});

test("analyzeWalletPatterns tolerates empty and null inputs safely", () => {
  const empty = analyzeWalletPatterns([], null);
  assert.equal(empty.deception_score, 0);
  assert.equal(empty.behavioral_profile, "neutral_trader");
  assert.equal(empty.metrics.unique_counterparties, 0);

  const nulls = analyzeWalletPatterns(null, null);
  assert.equal(nulls.deception_score, 0);
});

test("GET /graph/:addr returns 200 with graph nodes and links", async () => {
  const mockDB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (sql.includes("FROM whales")) {
                return {
                  results: [
                    {
                      id: 1,
                      chain: "eth",
                      tx_hash: "0x123",
                      from_address: TARGET_WALLET,
                      to_address: CP_WALLET_A,
                      amount: 1000,
                      symbol: "ETH",
                      usd_value: 3_000_000,
                      tx_type: "wallet_to_wallet",
                      detected_at: 1_700_000_000_000,
                    },
                  ],
                };
              }
              if (sql.includes("FROM wallets")) {
                return { results: [] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };

  const req = new Request(`https://whalesignal-bot.example.workers.dev/graph/${TARGET_WALLET}`);
  const resp = await fetchHandler(req, { DB: mockDB }, {});
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.root_address, TARGET_WALLET);
  assert.equal(data.nodes.length, 2);
  assert.equal(data.links.length, 1);
});

test("GET /patterns/:addr returns 200 with forensic deception analysis", async () => {
  const mockDB = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return {
                results: [
                  {
                    id: 1,
                    chain: "eth",
                    from_address: TARGET_WALLET,
                    to_address: CP_WALLET_A,
                    usd_value: 2_000_000,
                    tx_type: "wallet_to_wallet",
                    detected_at: 1_700_000_000_000,
                  },
                  {
                    id: 2,
                    chain: "eth",
                    from_address: CP_WALLET_A,
                    to_address: TARGET_WALLET,
                    usd_value: 1_900_000,
                    tx_type: "wallet_to_wallet",
                    detected_at: 1_700_001_000_000,
                  },
                ],
              };
            },
          };
        },
      };
    },
  };

  const mockKV = {
    async get(key) {
      if (key === "market_cache") return JSON.stringify({ fear_greed: 25 });
      return null;
    },
  };

  const req = new Request(`https://whalesignal-bot.example.workers.dev/patterns/${TARGET_WALLET}`);
  const resp = await fetchHandler(req, { DB: mockDB, KV: mockKV }, {});
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.address, TARGET_WALLET);
  assert.equal(data.wash_loops.length, 1);
  assert.ok(data.deception_score >= 30);
});

test("Telegram channel_post updates are completely ignored without spamming", async () => {
  const req = new Request("https://whalesignal-bot.example.workers.dev/tg/fake_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      update_id: 12345,
      channel_post: {
        message_id: 100,
        chat: { id: -100293847, title: "Whale Signals", type: "channel" },
        text: "Some announcement",
      },
    }),
  });

  const resp = await fetchHandler(req, { BOT_TOKEN: "fake_token" }, {});
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.ignored, "channel_post");
});

test("analyzeWalletPatterns is honest about low data: unknown risk, no clean bill of health", () => {
  const txs = [
    { from_address: TARGET_WALLET, to_address: CP_WALLET_A, usd_value: 800_000, tx_type: "wallet_to_wallet", detected_at: 1_700_000_000_000 },
    { from_address: TARGET_WALLET, to_address: CP_WALLET_B, usd_value: 1_200_000, tx_type: "wallet_to_wallet", detected_at: 1_700_001_000_000 },
    { from_address: CP_WALLET_C, to_address: TARGET_WALLET, usd_value: 900_000, tx_type: "wallet_to_wallet", detected_at: 1_700_002_000_000 },
  ];
  const r = analyzeWalletPatterns(txs, TARGET_WALLET);
  assert.equal(r.deception_score, 0);
  assert.equal(r.deception_risk, "unknown", "0/100 from 3 txs is absence of data");
  assert.ok(!r.flags.includes("ORGANIC_ONCHAIN_FLOW"), "no clean bill of health on thin history");
  assert.ok(r.flags.includes("INSUFFICIENT_HISTORY"));
  assert.match(r.intent_summary, /insufficient/i);
});

test("analyzeWalletPatterns still reports positive detections on small windows", () => {
  const txs = [
    { from_address: TARGET_WALLET, to_address: CP_WALLET_A, usd_value: 2_000_000, tx_type: "wallet_to_wallet", detected_at: 1_700_000_000_000 },
    { from_address: CP_WALLET_A, to_address: TARGET_WALLET, usd_value: 1_900_000, tx_type: "wallet_to_wallet", detected_at: 1_700_001_000_000 },
  ];
  const r = analyzeWalletPatterns(txs, TARGET_WALLET);
  assert.ok(r.wash_loops.length >= 1, "detections are not suppressed by low-data honesty");
  assert.notEqual(r.deception_risk, "unknown");
});

test("analyzeWalletPatterns gives a real low-risk verdict with enough clean history", () => {
  const cps = [CP_WALLET_A, CP_WALLET_B, CP_WALLET_C, CP_WALLET_D];
  const txs = [];
  for (let i = 0; i < 12; i++) {
    // one-way sends to rotating counterparties, varied amounts — no loops,
    // no peeling (counterparties repeat), no structuring (amounts vary widely)
    txs.push({
      from_address: TARGET_WALLET,
      to_address: cps[i % cps.length],
      usd_value: 600_000 + (i % 5) * 900_000,
      tx_type: "wallet_to_wallet",
      detected_at: 1_700_000_000_000 + i * 86_400_000, // spread over days
    });
  }
  const r = analyzeWalletPatterns(txs, TARGET_WALLET);
  assert.equal(r.deception_score, 0);
  assert.equal(r.deception_risk, "low");
  assert.ok(r.flags.includes("ORGANIC_ONCHAIN_FLOW"));
});

test("news catalyst matching uses word boundaries", () => {
  const one = (title) =>
    analyzeWalletPatterns(
      [{ from_address: TARGET_WALLET, to_address: CP_WALLET_A, usd_value: 1, tx_type: "wallet_to_wallet" }],
      TARGET_WALLET, null, [{ title }]
    ).news_catalysts;
  assert.equal(one("Urban renewal project approved downtown").length, 0, "'ban' must not match 'urban'");
  assert.equal(one("Tethered swimming areas closed").length, 0, "'tether' must not match 'tethered'");
  assert.equal(one("SEC sues exchange")[0].keyword, "sec");
  assert.equal(one("Binance lists new token")[0].keyword, "binance");
  assert.equal(one("rate cut expectations rise")[0].keyword, "rate cut", "multi-word keywords work");
});
