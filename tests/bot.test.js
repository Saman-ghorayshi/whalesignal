// tests/bot.test.js
// Tests the pure alert formatter (formatAlert). No Telegram, no D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAlert } from "../src/bot.js";
import { buildAlertJSON } from "../src/bot.js";

const WHALE = {
  chain: "eth",
  tx_hash: "0xabc123def4567890abcdef",
  from_address: "0x0001aaaaaaaaaaaaaaaaaaaaaaaaaa0001",
  to_address: "0x28c6c06298d514de13c02684fa65b7c0c1f723e4",
  amount: 250,
  symbol: "WBTC",
  usd_value: 16_750_000,
  tx_type: "exchange_inflow",
  block_number: 20_000_000,
  detected_at: 1_700_000_000_000,
};

const ANALYSIS = {
  headline: "Whale moved 250 WBTC to Binance",
  interpretation: "Looks like sell prep. BTC already down 2.3% today.",
  signal: "bearish",
  confidence: 0.71,
  related_factor: "Exchange inflow during market fear",
};

const MARKET = {
  btc: { price: 67_000, change_24h: -2.3 },
  eth: { price: 3_200, change_24h: -1.8 },
  fear_greed: 28,
  fear_greed_label: "Fear",
};

test("formatAlert renders the canonical phase-1 alert block", () => {
  const out = formatAlert(WHALE, ANALYSIS, MARKET);
  // Header
  assert.match(out, /🐋 WHALE ALERT — ETH/);
  assert.match(out, /\$16\.75M → exchange \(likely sell\)/);
  // body
  assert.match(out, /250 WBTC \(\$16\.75M\)/);
  assert.match(out, /📍 eth → 0x28c6\.\.\.23e4/i);
  assert.match(out, /🧱 Block 20000000/);
  // AI section
  assert.match(out, /🧠 AI Analysis:/);
  assert.match(out, /Whale moved 250 WBTC to Binance/);
  assert.match(out, /Looks like sell prep/);
  // footer
  assert.match(out, /📊 Market: BTC \$67,000 \(-2.3%\) \| F&G 28 \(Fear\) \| ETH \$3,200/);
  assert.match(out, /🔴 BEARISH/);
  assert.match(out, /confidence 0.71/);
  assert.match(out, /📎 Exchange inflow during market fear/);
  // explorer
  assert.match(out, /etherscan\.io\/tx\/0xabc123def4567890abcdef/);
});

test("formatAlert swaps in blockchain.com URL for BTC", () => {
  const btcWhale = { ...WHALE, chain: "btc", symbol: "BTC" };
  const out = formatAlert(btcWhale, ANALYSIS, MARKET);
  assert.match(out, /blockchain\.com\/tx\/0xabc123def4567890abcdef/);
  assert.match(out, /🐋 WHALE ALERT — BTC/);
});

test("formatAlert handles missing analysis gracefully", () => {
  const out = formatAlert(WHALE, null, MARKET);
  assert.match(out, /🧠 AI Analysis: \(pending\)/);
  assert.match(out, /⚪ NEUTRAL/);
  assert.match(out, /confidence —/);
});

test("formatAlert handles missing market fields gracefully", () => {
  const out = formatAlert(WHALE, ANALYSIS, null);
  assert.match(out, /📊 Market: BTC — \(—\) \| F&G — \| ETH —/);
});

test("formatAlert maps all four tx_types to a label", () => {
  for (const t of ["exchange_inflow", "exchange_outflow", "exchange_internal", "wallet_to_wallet", "unknown"]) {
    const out = formatAlert({ ...WHALE, tx_type: t }, ANALYSIS, MARKET);
    assert.ok(/→ exchange \(likely sell\)|← exchange \(likely withdraw\)|↔ exchange-to-exchange|↔ wallet to wallet|wallet move/.test(out), `type ${t}`);
  }
});

// ─── buildAlertJSON (R2 export contract) ──────────────────────────────

test("buildAlertJSON produces the NDJSON contract shape for trading_loop.py", () => {
  const out = buildAlertJSON({ ...WHALE, id: 42, ...ANALYSIS }, MARKET);
  assert.ok(out, "should return an object");
  // required fields the plan says the Python loop keys on
  assert.equal(out.id, 42);
  assert.equal(typeof out.whale, "string");
  assert.equal(out.chain, "ETH");
  assert.equal(typeof out.signal, "string");
  assert.equal(typeof out.usd_value, "number");
  assert.equal(typeof out.detected_at, "number");
  // market nested object
  assert.equal(typeof out.market.btc_price, "number");
  assert.equal(typeof out.market.eth_price, "number");
  assert.equal(typeof out.market.fear_greed, "number");
  // analyst fields carried for the LLM prompt
  assert.equal(typeof out.analyst_interpretation, "string");
  assert.equal(typeof out.headline, "string");
  assert.equal(out.confidence, 0.71);
});

test("buildAlertJSON returns null when required fields are missing", () => {
  assert.equal(buildAlertJSON(null, MARKET), null);
  assert.equal(buildAlertJSON({}, MARKET), null);
  assert.equal(buildAlertJSON({ from_address: "0x1" }, MARKET), null); // no chain/usd
});

test("buildAlertJSON handles missing market (nulls, not crash)", () => {
  const out = buildAlertJSON({ ...WHALE, ...ANALYSIS }, null);
  assert.ok(out);
  assert.equal(out.market.btc_price, null);
  assert.equal(out.market.eth_price, null);
  assert.equal(out.market.fear_greed, null);
});
