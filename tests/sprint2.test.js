// tests/sprint2.test.js — Sprint 2: /stats, /history, /wallet endpoints
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatsJSON, renderHistoryJSON, renderWalletJSON, fetchHandler } from "../src/bot.js";

// ─── renderStatsJSON (pure) ───────────────────────────────────────────

const STATS = {
  total_whales: 42,
  total_volume: 580_000_000,
  count_24h: 8,
  count_7d: 15,
  largest_transfer: 18_000_000,
  bullish: 10,
  bearish: 20,
  neutral: 12,
};

const BY_SYMBOL = [
  { symbol: "BTC", count: 20, volume: 300_000_000 },
  { symbol: "ETH", count: 15, volume: 200_000_000 },
  { symbol: "USDT", count: 7, volume: 80_000_000 },
];

const HOURLY = [
  { hour_bucket: 1_700_000_000_000, count: 3, volume: 50_000_000 },
  { hour_bucket: 1_700_003_600_000, count: 5, volume: 80_000_000 },
];

const MARKET = {
  btc: { price: 67_000, change_24h: -2.3 },
  eth: { price: 3_200, change_24h: -1.8 },
  fear_greed: 28, fear_greed_label: "Fear",
};

test("renderStatsJSON builds the full stats payload", () => {
  const out = renderStatsJSON(STATS, BY_SYMBOL, HOURLY, MARKET);
  assert.equal(out.ok, true);
  assert.equal(out.total_whales, 42);
  assert.equal(out.total_volume, 580_000_000);
  assert.equal(out.count_24h, 8);
  assert.equal(out.count_7d, 15);
  assert.equal(out.largest_transfer, 18_000_000);
  assert.equal(out.signals.bullish, 10);
  assert.equal(out.signals.bearish, 20);
  assert.equal(out.signals.neutral, 12);
  assert.equal(out.top_symbols.length, 3);
  assert.equal(out.top_symbols[0].symbol, "BTC");
  assert.equal(out.top_symbols[0].count, 20);
  assert.equal(out.hourly.length, 2);
  assert.equal(out.hourly[0].count, 3);
  assert.equal(out.market.btc_price, 67_000);
  assert.equal(out.market.fear_greed, 28);
});

test("renderStatsJSON handles empty stats (ok=false)", () => {
  const out = renderStatsJSON({}, [], [], null);
  assert.equal(out.ok, false);
  assert.equal(out.total_whales, 0);
  assert.equal(out.total_volume, 0);
  assert.equal(out.signals.bullish, 0);
  assert.equal(out.top_symbols.length, 0);
  assert.equal(out.hourly.length, 0);
  assert.equal(out.market, null);
});

test("renderStatsJSON tolerates null inputs", () => {
  const out = renderStatsJSON(null, null, null, null);
  assert.equal(out.ok, false);
  assert.equal(out.total_whales, 0);
});

// ─── renderHistoryJSON (pure) ─────────────────────────────────────────

const HISTORY_ROWS = [
  {
    id: 1, chain: "eth", tx_hash: "0xabc", from_address: "0x0001aaaa...0001",
    to_address: "0x28c6c06298d514de13c02684fa65b7c0c1f723e4",
    amount: 1500, symbol: "ETH", usd_value: 5_200_000, tx_type: "exchange_outflow",
    detected_at: 1_721_280_000_000, interesting_score: 72,
    signal: "bullish", headline: "Whale withdrew 1500 ETH", confidence: 0.78,
  },
  {
    id: 2, chain: "btc", tx_hash: "0xdef", from_address: "0x0002bbbb...0002",
    to_address: "0x28c6c06298d514de13c02684fa65b7c0c1f723e4",
    amount: 190, symbol: "BTC", usd_value: 12_000_000, tx_type: "exchange_inflow",
    detected_at: 1_721_280_060_000, interesting_score: 85,
    signal: "bearish", headline: "Whale moved 190 BTC to Binance", confidence: 0.71,
  },
];

test("renderHistoryJSON builds paginated payload", () => {
  const out = renderHistoryJSON(HISTORY_ROWS, 1, 20, 42);
  assert.equal(out.ok, true);
  assert.equal(out.page, 1);
  assert.equal(out.limit, 20);
  assert.equal(out.total, 42);
  assert.equal(out.alerts.length, 2);
  assert.equal(out.alerts[0].id, 1);
  assert.equal(out.alerts[0].chain, "ETH");
  assert.equal(out.alerts[0].interesting_score, 72);
  assert.equal(out.alerts[0].signal, "bullish");
  assert.equal(out.alerts[1].chain, "BTC");
  assert.equal(out.alerts[1].interesting_score, 85);
});

test("renderHistoryJSON handles empty rows", () => {
  const out = renderHistoryJSON([], 1, 20, 0);
  assert.equal(out.ok, true);
  assert.equal(out.alerts.length, 0);
  assert.equal(out.total, 0);
});

test("renderHistoryJSON clamps page/limit to valid ranges", () => {
  const out = renderHistoryJSON([], -1, 200, 0);
  assert.equal(out.page, 1);
  assert.equal(out.limit, 100);
});

// ─── renderWalletJSON (pure) ──────────────────────────────────────────

const PROFILE = {
  address: "0x28c6c06298d514de13c02684fa65b7c0c1f723e4",
  chain: "eth", label: "Binance Hot Wallet 14", type: "exchange",
  reputation: null, tx_count: 182, total_volume: 8_400_000_000,
  first_seen: 1_680_000_000_000, last_seen: 1_721_280_000_000,
};

const WALLET_TXS = [
  {
    id: 1, chain: "eth", tx_hash: "0xabc", from_address: "0x28c6c06298d514de13c02684fa65b7c0c1f723e4",
    to_address: "0x0001aaaa", amount: 500, symbol: "ETH", usd_value: 1_700_000,
    tx_type: "exchange_outflow", detected_at: 1_721_280_000_000, interesting_score: 60,
    signal: "bullish", headline: "Whale withdrew 500 ETH from Binance", confidence: 0.72,
  },
  {
    id: 2, chain: "eth", tx_hash: "0xdef", from_address: "0x0002bbbb",
    to_address: "0x28c6c06298d514de13c02684fa65b7c0c1f723e4",
    amount: 200, symbol: "ETH", usd_value: 680_000,
    tx_type: "exchange_inflow", detected_at: 1_721_270_000_000, interesting_score: 55,
    signal: "neutral", headline: "ETH deposited to Binance", confidence: 0.50,
  },
];

test("renderWalletJSON builds full wallet profile", () => {
  const out = renderWalletJSON(PROFILE, WALLET_TXS);
  assert.equal(out.ok, true);
  assert.equal(out.address, "0x28c6c06298d514de13c02684fa65b7c0c1f723e4");
  assert.equal(out.chain, "eth");
  assert.equal(out.label, "Binance Hot Wallet 14");
  assert.equal(out.type, "exchange");
  assert.equal(out.tx_count, 182);
  assert.equal(out.total_volume, 8_400_000_000);
  assert.equal(out.recent_txs.length, 2);
  // tx 1: wallet is the sender → direction=out
  assert.equal(out.recent_txs[0].direction, "out");
  assert.equal(out.recent_txs[0].counterpart, "0x0001aaaa");
  // tx 2: wallet is the receiver → direction=in
  assert.equal(out.recent_txs[1].direction, "in");
  assert.equal(out.recent_txs[1].counterpart, "0x0002bbbb");
  assert.equal(out.recent_txs[0].interesting_score, 60);
});

test("renderWalletJSON handles null profile (not in database)", () => {
  const out = renderWalletJSON(null, []);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "wallet not in database");
  assert.equal(out.txs.length, 0);
});

test("renderWalletJSON handles profile with null/missing fields", () => {
  const sparse = { address: "0x1", chain: "btc" };
  const out = renderWalletJSON(sparse, []);
  assert.equal(out.ok, true);
  assert.equal(out.label, null);
  assert.equal(out.type, "unknown");
  assert.equal(out.reputation, null);
  assert.equal(out.tx_count, 0);
  assert.equal(out.total_volume, 0);
  assert.equal(out.first_seen, null);
  assert.equal(out.recent_txs.length, 0);
});

// ─── fetchHandler routes (stub env) ────────────────────────────────────

// Stub D1 that can return different results for different query patterns
function mockEnvD1(opts = {}) {
  const statsRow = opts.statsRow || {};
  const symbolRows = opts.symbolRows || [];
  const hourlyRows = opts.hourlyRows || [];
  const txRows = opts.txRows || [];
  const walletRow = opts.walletRow || null;
  const latestRows = opts.latestRows || [];

  class Chain {
    constructor() { this.lastSql = null; }
    prepare(s) { this.lastSql = s; return this; }
    bind(...args) { return this; }
    async all() {
      const sql = this.lastSql || "";
      // stats aggregate query (has COUNT(*) AS total_whales)
      if (/total_whales/.test(sql)) return { results: [statsRow] };
      // symbol breakdown (has GROUP BY symbol)
      if (/GROUP BY symbol/.test(sql)) return { results: symbolRows };
      // hourly query (has hour_bucket)
      if (/hour_bucket/.test(sql)) return { results: hourlyRows };
      // wallet txs query (has from_address = ? OR to_address)
      if (/from_address = \? OR/.test(sql)) return { results: txRows };
      // latest / history query (has ORDER BY w.detected_at DESC LIMIT)
      if (/ORDER BY w\.detected_at DESC/.test(sql)) return { results: latestRows };
      return { results: [] };
    }
    async first() {
      const sql = this.lastSql || "";
      // wallet profile query (SELECT ... FROM wallets WHERE address = ?)
      if (/FROM wallets WHERE address/.test(sql)) return walletRow;
      // stats firstRow fallback
      if (/total_whales/.test(sql)) return statsRow;
      return null;
    }
  }
  return {
    DB: new Chain(),
    KV: {
      get: async () => opts.kvThrows ? null : JSON.stringify(MARKET),
    },
  };
}

test("GET /stats returns 200 with CORS+JSON", async () => {
  const env = mockEnvD1({ statsRow: STATS, symbolRows: BY_SYMBOL, hourlyRows: HOURLY });
  const req = new Request("https://whalesignal-bot.example.workers.dev/stats");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(resp.headers.get("Content-Type"), "application/json");
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.equal(body.total_whales, 42);
  assert.equal(body.signals.bearish, 20);
});

test("GET /history returns 200 with paginated alerts", async () => {
  const env = mockEnvD1({ latestRows: HISTORY_ROWS });
  const req = new Request("https://whalesignal-bot.example.workers.dev/history?page=1&limit=20");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.equal(body.page, 1);
  assert.equal(body.alerts.length, 2);
  assert.equal(body.alerts[0].chain, "ETH");
});

test("GET /wallet/0xABC returns 200 when wallet exists", async () => {
  const env = mockEnvD1({ walletRow: PROFILE, txRows: WALLET_TXS });
  const req = new Request("https://whalesignal-bot.example.workers.dev/wallet/0x28c6c06298d514de13c02684fa65b7c0c1f723e4");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.equal(body.address, "0x28c6c06298d514de13c02684fa65b7c0c1f723e4");
  assert.equal(body.type, "exchange");
  assert.equal(body.recent_txs.length, 2);
});

test("GET /wallet/0xUNKNOWN returns 404 when wallet not found", async () => {
  const env = mockEnvD1({ walletRow: null, txRows: [] });
  const req = new Request("https://whalesignal-bot.example.workers.dev/wallet/0xunknown");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 404);
  const body = await resp.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "wallet not in database");
});

test("GET /stats handles DB error with 500", async () => {
  const env = {
    DB: { prepare() { throw new Error("D1 down"); } },
    KV: { get: async () => null },
  };
  const req = new Request("https://whalesignal-bot.example.workers.dev/stats");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 500);
  const body = await resp.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "db_error");
});

test("GET /latest still works after adding new routes", async () => {
  const env = mockEnvD1({ latestRows: [] });
  const req = new Request("https://whalesignal-bot.example.workers.dev/latest?limit=5");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "no alerts yet");
});
