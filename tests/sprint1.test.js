// tests/sprint1.test.js — Sprint 1: interestingness, templates, evidence prompt
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInterestingness, SCORE_THRESHOLD } from "../src/scanner.js";
import { templateAnalysis, marketRegime, walletBehavior, buildPrompt } from "../src/analyst.js";

// ─── computeInterestingness ───────────────────────────────────────────

const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

test("computeInterestingness: $100M BTC exchange inflow from known whale = high score", () => {
  const w = { usd_value: 120_000_000, tx_type: "exchange_inflow", symbol: "BTC", detected_at: NOW };
  const walletInfo = { tx_count: 15, first_seen: NOW - 3 * 365 * ONE_DAY, last_seen: NOW - 2 * ONE_DAY };
  const score = computeInterestingness(w, walletInfo, []);
  assert.ok(score >= 80, `score should be high, got ${score}`);
});

test("computeInterestingness: $600K USDT wallet-to-wallet from unknown wallet = low score", () => {
  const w = { usd_value: 600_000, tx_type: "wallet_to_wallet", symbol: "USDT", detected_at: NOW };
  const score = computeInterestingness(w, null, []);
  // size=15 + wallet_to_wallet=3 + stablecoin penalty=-10 = 8
  assert.ok(score < SCORE_THRESHOLD, `score should be below threshold, got ${score}`);
  assert.equal(score, 8);
});

test("computeInterestingness: dormant wallet reactivation gets dormancy bonus", () => {
  const w = { usd_value: 5_000_000, tx_type: "exchange_inflow", symbol: "ETH", detected_at: NOW };
  const walletInfo = { tx_count: 2, first_seen: NOW - 2 * 365 * ONE_DAY, last_seen: NOW - 400 * ONE_DAY };
  const score = computeInterestingness(w, walletInfo, []);
  // size=45 + exchange=12 + tx_count>=1=5 + dormancy>1yr=20 + age>3yr(2yr...no, only 2yr)=0
  // 45+12+5+20 = 82
  assert.ok(score >= 70, `dormant wallet should score high, got ${score}`);
});

test("computeInterestingness: spam penalty for many txs from same wallet in 24h", () => {
  const w = { usd_value: 1_000_000, tx_type: "exchange_inflow", symbol: "BTC", detected_at: NOW };
  const recent = Array.from({ length: 10 }, (_, i) => ({ detected_at: NOW - i * 3600_000 }));
  const scoreNoSpam = computeInterestingness(w, null, []);
  const scoreSpam = computeInterestingness(w, null, recent);
  assert.ok(scoreSpam < scoreNoSpam, `spam should reduce score: ${scoreSpam} < ${scoreNoSpam}`);
  assert.ok(scoreSpam <= scoreNoSpam - 20, `should be at least 20pts lower`);
});

test("computeInterestingness: clamps to 0-100", () => {
  const w = { usd_value: 1_000_000_000, tx_type: "exchange_inflow", symbol: "BTC", detected_at: NOW };
  const walletInfo = { tx_count: 50, first_seen: NOW - 5 * 365 * ONE_DAY, last_seen: NOW - 400 * ONE_DAY };
  const score = computeInterestingness(w, walletInfo, []);
  assert.ok(score <= 100, `score should not exceed 100, got ${score}`);
});

test("computeInterestingness: stablecoin penalty only applies under $50M", () => {
  const wSmall = { usd_value: 5_000_000, tx_type: "exchange_inflow", symbol: "USDT", detected_at: NOW };
  const wHuge = { usd_value: 60_000_000, tx_type: "exchange_inflow", symbol: "USDT", detected_at: NOW };
  const scoreSmall = computeInterestingness(wSmall, null, []);
  const scoreHuge = computeInterestingness(wHuge, null, []);
  // The $50M+ stablecoin should lose the -10 penalty relative to the small one
  // (both are exchange_inflow, but the size bands differ, so we just verify the
  // huge one scores significantly higher)
  assert.ok(scoreHuge > scoreSmall, `large stablecoin should outscore small: ${scoreHuge} > ${scoreSmall}`);
});

// ─── marketRegime ─────────────────────────────────────────────────────

test("marketRegime classifies Fear & Greed correctly", () => {
  assert.equal(marketRegime({ fear_greed: 10 }), "fear");
  assert.equal(marketRegime({ fear_greed: 25 }), "fear");
  assert.equal(marketRegime({ fear_greed: 50 }), "neutral");
  assert.equal(marketRegime({ fear_greed: 75 }), "greed");
  assert.equal(marketRegime({ fear_greed: 90 }), "greed");
  assert.equal(marketRegime(null), "unknown");
  assert.equal(marketRegime({}), "unknown");
});

// ─── walletBehavior ───────────────────────────────────────────────────

test("walletBehavior detects distribution pattern", () => {
  const hist = [
    { tx_type: "exchange_inflow" },
    { tx_type: "exchange_inflow" },
    { tx_type: "exchange_inflow" },
  ];
  assert.equal(walletBehavior(hist), "distribution");
});

test("walletBehavior detects accumulation pattern", () => {
  const hist = [
    { tx_type: "exchange_outflow" },
    { tx_type: "exchange_outflow" },
    { tx_type: "wallet_to_wallet" },
  ];
  assert.equal(walletBehavior(hist), "accumulation");
});

test("walletBehavior returns unknown for no/empty history", () => {
  assert.equal(walletBehavior([]), "unknown");
  assert.equal(walletBehavior(null), "unknown");
});

test("walletBehavior returns mixed for balanced inflow/outflow", () => {
  const hist = [
    { tx_type: "exchange_inflow" },
    { tx_type: "exchange_outflow" },
  ];
  assert.equal(walletBehavior(hist), "mixed");
});

// ─── templateAnalysis ─────────────────────────────────────────────────

const MARKET_FEAR = { fear_greed: 20, fear_greed_label: "Fear", btc: { price: 60_000, change_24h: -3 }, eth: { price: 3000, change_24h: -2 } };
const MARKET_GREED = { fear_greed: 80, fear_greed_label: "Greed", btc: { price: 80_000, change_24h: 5 }, eth: { price: 5000, change_24h: 4 } };

test("templateAnalysis: exchange_inflow during fear → bearish", () => {
  const w = { tx_type: "exchange_inflow", usd_value: 10_000_000, symbol: "BTC" };
  const result = templateAnalysis(w, MARKET_FEAR, []);
  assert.ok(result, "should return a template result");
  assert.equal(result.signal, "bearish");
  assert.ok(result.confidence >= 0.70, `confidence should be >= 0.7, got ${result.confidence}`);
  assert.match(result.headline, /deposited to exchange/i);
  assert.match(result.related_factor, /exchange inflow/i);
});

test("templateAnalysis: exchange_outflow during greed → bullish", () => {
  const w = { tx_type: "exchange_outflow", usd_value: 5_000_000, symbol: "ETH" };
  const result = templateAnalysis(w, MARKET_GREED, []);
  assert.ok(result);
  assert.equal(result.signal, "bullish");
  assert.match(result.headline, /withdrawn from exchange/i);
});

test("templateAnalysis: exchange_internal → neutral, high confidence", () => {
  const w = { tx_type: "exchange_internal", usd_value: 50_000_000, symbol: "USDT" };
  const result = templateAnalysis(w, MARKET_FEAR, []);
  assert.ok(result);
  assert.equal(result.signal, "neutral");
  assert.ok(result.confidence >= 0.85, `internal should have high confidence, got ${result.confidence}`);
});

test("templateAnalysis: small stablecoin wallet-to-wallet → neutral", () => {
  const w = { tx_type: "wallet_to_wallet", usd_value: 2_000_000, symbol: "USDC" };
  const result = templateAnalysis(w, MARKET_FEAR, []);
  assert.ok(result);
  assert.equal(result.signal, "neutral");
  assert.equal(result.confidence, 0.50);
});

test("templateAnalysis: ambiguous wallet-to-wwallet BTC → null (needs Gemini)", () => {
  const w = { tx_type: "wallet_to_wallet", usd_value: 8_000_000, symbol: "BTC" };
  const result = templateAnalysis(w, MARKET_FEAR, []);
  assert.equal(result, null, "ambiguous cases should return null for Gemini");
});

test("templateAnalysis: inflow without fear or distribution history → null", () => {
  const w = { tx_type: "exchange_inflow", usd_value: 3_000_000, symbol: "ETH" };
  const result = templateAnalysis(w, { fear_greed: 50, fear_greed_label: "Neutral" }, []);
  assert.equal(result, null, "inflow in neutral market without distribution history needs Gemini");
});

test("templateAnalysis: inflow with prior distribution history → bearish even in neutral market", () => {
  const w = { tx_type: "exchange_inflow", usd_value: 3_000_000, symbol: "ETH" };
  const distHistory = [
    { tx_type: "exchange_inflow" }, { tx_type: "exchange_inflow" }, { tx_type: "exchange_inflow" },
  ];
  const result = templateAnalysis(w, { fear_greed: 50, fear_greed_label: "Neutral" }, distHistory);
  assert.ok(result, "distribution history should trigger template even in neutral market");
  assert.equal(result.signal, "bearish");
  assert.ok(result.confidence < 0.75, `should have lower confidence without fear, got ${result.confidence}`);
});

// ─── buildPrompt (evidence-based) ─────────────────────────────────────

const WHALE = {
  chain: "eth",
  from_address: "0x28C6c06298d514De13C02684fa65b7c0c1F723e4",
  to_address: "0x21a31Ee1AfC5e7A728a5F2C3d6c2F3a8f9d93Da3",
  amount: 250,
  symbol: "BTC",
  usd_value: 16_750_000,
  tx_type: "exchange_inflow",
  detected_at: 1_700_000_000_000,
};

const MARKET = {
  btc: { price: 67_000, change_24h: -2.3 },
  eth: { price: 3_200, change_24h: -1.8 },
  usdt: { price: 1 }, usdc: { price: 1 }, dai: { price: 1 }, wbtc: { price: 67_000 },
  fear_greed: 28,
  fear_greed_label: "Fear",
};

test("buildPrompt includes STRUCTURED FACTS section", () => {
  const p = buildPrompt(WHALE, MARKET, [], null);
  assert.match(p, /STRUCTURED FACTS/i);
  assert.match(p, /Destination: exchange wallet/i);
  assert.match(p, /Source: private wallet/i);
  assert.match(p, /Wallet historical behavior:/i);
  assert.match(p, /Market sentiment: Fear/i);
  assert.match(p, /Exchange involvement: yes/i);
});

test("buildPrompt includes anti-speculation rules", () => {
  const p = buildPrompt(WHALE, MARKET, [], null);
  assert.match(p, /Do not speculate/i);
  assert.match(p, /STRUCTURED FACTS/i);
  assert.match(p, /insufficient data/i);
  assert.match(p, /not predicting prices/i);
});

test("buildPrompt includes confidence guard rule (3+ facts for >0.7)", () => {
  const p = buildPrompt(WHALE, MARKET, [], null);
  assert.match(p, /only above 0\.7 if 3\+ supporting facts/i);
});

test("buildPrompt handles missing market + history gracefully", () => {
  const p = buildPrompt(WHALE, null, [], null);
  assert.match(p, /no prior history/i);
  assert.match(p, /no recent headlines cached/i);
  assert.match(p, /Market sentiment: unknown/i);
  assert.match(p, /Wallet historical behavior: unknown/i);
});

test("buildPrompt counts prior events from history length", () => {
  const hist = [
    { detected_at: 1_699_900_000_000, tx_type: "exchange_inflow", amount: 5, symbol: "BTC", usd_value: 300_000, from_address: "0x1", to_address: "0x2" },
    { detected_at: 1_699_800_000_000, tx_type: "exchange_outflow", amount: 3, symbol: "ETH", usd_value: 9000, from_address: "0x1", to_address: "0x3" },
  ];
  const p = buildPrompt(WHALE, MARKET, hist, null);
  assert.match(p, /Prior similar events in wallet history: 2 transactions/i);
});
