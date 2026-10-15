// tests/motive.test.js — motive classifier, catalyst picker, impact estimate.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { classifyMotive, pickCatalyst, estimateImpact } from "../src/motive.js";

const FEAR_TA = { rsi14: 28, trend: "downtrend", bbPos: "near_lower" };
const GREED_TA = { rsi14: 76, trend: "uptrend", bbPos: "near_upper" };

test("capitulation: inflow + fear + oversold", () => {
  const r = classifyMotive({ txType: "exchange_inflow", ta: FEAR_TA, sentiment: -0.6, newsCount: 3, usdValue: 5e6, avgUsd: 1e6 });
  assert.equal(r.motive, "capitulation");
  assert.ok(r.confidence >= 0.7, "high confidence");
  assert.ok(r.reasons.length > 0, "reasons given");
});

test("accumulation: outflow + fear + oversold", () => {
  const r = classifyMotive({ txType: "exchange_outflow", ta: FEAR_TA, sentiment: -0.5, newsCount: 2, usdValue: 8e6 });
  assert.equal(r.motive, "accumulation");
});

test("profit_taking: inflow + greed + overbought", () => {
  const r = classifyMotive({ txType: "exchange_inflow", ta: GREED_TA, sentiment: 0.6, newsCount: 1, usdValue: 1e7 });
  assert.equal(r.motive, "profit_taking");
});

test("dry_powder: stablecoin inflow during fear", () => {
  const r = classifyMotive({ txType: "exchange_inflow", ta: FEAR_TA, sentiment: -0.5, usdValue: 2e6, isStable: true });
  assert.equal(r.motive, "dry_powder");
});

test("internal_ops: self-transfer is never a market move", () => {
  const r = classifyMotive({ txType: "wallet_to_wallet", isSelfTransfer: true, usdValue: 2e8, sentiment: 0.5, ta: GREED_TA });
  assert.equal(r.motive, "internal_ops");
  assert.ok(r.confidence >= 0.85);
});

test("internal_ops: exchange_internal plumbing", () => {
  const r = classifyMotive({ txType: "exchange_internal", usdValue: 1e7 });
  assert.equal(r.motive, "internal_ops");
});

test("otc_deal: quiet wallet-to-wallet", () => {
  const r = classifyMotive({ txType: "wallet_to_wallet", newsCount: 0, usdValue: 3e6, avgUsd: 3e6 });
  assert.equal(r.motive, "otc_deal");
});

test("cold_storage: neutral outflow", () => {
  const r = classifyMotive({ txType: "exchange_outflow", ta: null, sentiment: 0, newsCount: 0, usdValue: 2e6 });
  assert.equal(r.motive, "cold_storage");
});

test("pickCatalyst: highest importance in window wins", () => {
  const now = 1792080000000;
  const news = [
    { title: "old", url: "u1", source: "a", symbols: ",BTC,", sentiment: 0, importance: 0.9, published_at: now - 20 * 3600 * 1000 },
    { title: "top", url: "u2", source: "b", symbols: ",BTC,", sentiment: -0.5, importance: 0.7, published_at: now - 3600000 },
    { title: "eth", url: "u3", source: "c", symbols: ",ETH,", sentiment: 0, importance: 0.95, published_at: now - 3600000 },
  ];
  const c = pickCatalyst(news, { symbol: "BTC", detectedAt: now });
  assert.equal(c.title, "top", "in-window BTC story beats out-of-window and wrong-symbol");
  assert.equal(pickCatalyst([], { symbol: "BTC", detectedAt: now }), null, "empty → null");
});

test("estimateImpact: bps math + labels", () => {
  const r = estimateImpact(1e6, 1e9); // $1M of $1B volume = 10 bps
  assert.equal(r.bps, 10);
  assert.equal(r.label, "small");
  const big = estimateImpact(5e7, 1e9); // 500 bps
  assert.equal(big.label, "significant");
  const unk = estimateImpact(1e6, null);
  assert.equal(unk.label, "unknown");
});
