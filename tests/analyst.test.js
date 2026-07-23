// tests/analyst.test.js
// Tests buildPrompt() + parseAnalysis() — pure functions, no API calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, parseAnalysis, templateAnalysis, marketRegime, walletBehavior } from "../src/analyst.js";

const WHALE = {
  chain: "eth",
  from_address: "0x28C6c06298d514De13C02684fa65b7c0c1F723e4",
  to_address: "0x21a31Ee1AfC5e7A728a5F2C3d6c2F3a8f9d93Da3",
  amount: 250,
  symbol: "BTC", // wrapped btc transfer via ERC20 path
  usd_value: 16_750_000,
  tx_type: "exchange_internal",
  detected_at: 1_700_000_000_000,
};

const MARKET = {
  btc: { price: 67_000, change_24h: -2.3 },
  eth: { price: 3_200, change_24h: -1.8 },
  usdt: { price: 1 }, usdc: { price: 1 }, dai: { price: 1 }, wbtc: { price: 67_000 },
  fear_greed: 28,
  fear_greed_label: "Fear",
};

test("buildPrompt always contains all the structural anchors the AI needs", () => {
  const hist = [
    {
      chain: "eth", tx_hash: "0xOLD", from_address: WHALE.from_address, to_address: "0xRECV",
      amount: 12, symbol: "WBTC", usd_value: 800_000, tx_type: "exchange_inflow",
      detected_at: 1_699_900_000_000,
    },
  ];
  const p = buildPrompt(WHALE, MARKET, hist, [{ title: "BTC slides as SEC announces review" }]);
  assert.match(p, /Blockchain: eth/i);
  assert.match(p, /Transaction type: exchange_internal/i);
  assert.match(p, /STRUCTURED FACTS/i);
  assert.match(p, /Market sentiment: Fear/i);
  assert.match(p, /RECENT HEADLINES/i);
  assert.match(p, /WALLET HISTORY/i);
  assert.match(p, /SEC announces review/i);
  assert.match(p, /"headline"/i);
  assert.match(p, /"signal": "bullish" \| "bearish" \| "neutral"/i);
  assert.match(p, /"confidence": 0\.0-1\.0/i);
});

test("buildPrompt handles missing market + history gracefully", () => {
  const p = buildPrompt(WHALE, null, [], null);
  assert.match(p, /no prior history/i);
  assert.match(p, /no recent headlines cached/i);
  // market values fall back to "unknown"
  assert.match(p, /Market sentiment: unknown/i);
  assert.match(p, /Wallet historical behavior: unknown/i);
});

test("parseAnalysis parses clean JSON out of plain JSON text", () => {
  const txt = JSON.stringify({
    headline: "X moved to Binance",
    interpretation: "Looks like sell prep.",
    signal: "bearish",
    confidence: 0.71,
    related_factor: "exchange inflow during market fear",
  });
  const r = parseAnalysis(txt);
  assert.equal(r.headline, "X moved to Binance");
  assert.equal(r.signal, "bearish");
  assert.equal(r.confidence, 0.71);
  assert.equal(r.related_factor, "exchange inflow during market fear");
});

test("parseAnalysis strips ```json fences and extracts the embedded object", () => {
  const txt = "```json\n{\n  \"headline\": \"y\",\n  \"interpretation\": \"z\",\n  \"signal\": \"bullish\",\n  \"confidence\": 0.5,\n  \"related_factor\": \"f\"\n}\n```";
  const r = parseAnalysis(txt);
  assert.equal(r.headline, "y");
  assert.equal(r.signal, "bullish");
  assert.equal(r.confidence, 0.5);
});

test("parseAnalysis clamps confidence to [0,1] and rejects unknown signals", () => {
  const r = parseAnalysis(JSON.stringify({ signal: "moon", confidence: 5.7 }));
  assert.equal(r.signal, "neutral", "unknown signal normalizes to neutral");
  assert.equal(r.confidence, 1, "confidence >1 clamps to 1");

  const r2 = parseAnalysis(JSON.stringify({ signal: "bearish", confidence: -0.3 }));
  assert.equal(r2.confidence, 0, "negative confidence clamps to 0");
});

test("parseAnalysis returns null when no JSON is recoverable", () => {
  assert.equal(parseAnalysis(null), null);
  assert.equal(parseAnalysis(""), null);
  assert.equal(parseAnalysis("just prose, no braces"), null);
  assert.equal(parseAnalysis("```markdown\n# nothing here\n```"), null);
});

test("parseAnalysis truncates runaway long fields", () => {
  const long = "x".repeat(500);
  const r = parseAnalysis(JSON.stringify({
    headline: long, interpretation: long,
    signal: "neutral", confidence: 0.1, related_factor: long,
  }));
  assert.ok(r.headline.length <= 200);
  assert.ok(r.interpretation.length <= 800);
  assert.ok(r.related_factor.length <= 200);
});
