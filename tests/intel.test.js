// tests/intel.test.js — price events, sentiment composite, news topics/dedupe.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { detectEvents } from "../src/price.js";
import { compositeLabel } from "../src/sentiment.js";
import { tagTopics, clusterId } from "../src/news.js";

test("detectEvents: pump on +4% hourly move", () => {
  const snap = { symbol: "BTC", price: 84000, change1h: 4.2, rsi14: 55, bbPos: "mid_band", volumeZ: 0.5 };
  const ev = detectEvents(snap);
  assert.ok(ev.some((e) => e.type === "pump"), "pump detected");
  assert.ok(!ev.some((e) => e.type === "dump"), "no dump");
});

test("detectEvents: dump + rsi extreme + bb break can co-fire", () => {
  const snap = { symbol: "ETH", price: 3000, change1h: -5.1, rsi14: 22, bbPos: "below_lower", volumeZ: 4.5 };
  const types = detectEvents(snap).map((e) => e.type);
  assert.ok(types.includes("dump"), "dump");
  assert.ok(types.includes("rsi_extreme"), "rsi_extreme");
  assert.ok(types.includes("bb_break"), "bb_break");
  assert.ok(types.includes("volume_spike"), "volume_spike");
});

test("detectEvents: quiet market → no events", () => {
  const snap = { symbol: "BTC", price: 82000, change1h: 0.3, rsi14: 52, bbPos: "mid_band", volumeZ: 0.2 };
  assert.deepEqual(detectEvents(snap), []);
  assert.deepEqual(detectEvents(null), []);
});

test("compositeLabel: sentiment buckets", () => {
  assert.equal(compositeLabel(-0.8), "extreme_fear");
  assert.equal(compositeLabel(-0.4), "fear");
  assert.equal(compositeLabel(0), "neutral");
  assert.equal(compositeLabel(0.4), "greed");
  assert.equal(compositeLabel(0.8), "extreme_greed");
});

test("tagTopics: multi-topic tagging", () => {
  const t = tagTopics("SEC approves Bitcoin ETF as BlackRock inflows surge");
  assert.ok(t.includes("etf"), "etf topic");
  assert.ok(t.includes("regulation"), "regulation topic (SEC)");
  const h = tagTopics("Exchange hack drains $50M in exploit");
  assert.ok(h.includes("security"), "security topic");
  assert.deepEqual(tagTopics("sunny day, nothing happening"), []);
});

test("clusterId: same story → same id, different → different", () => {
  const a = clusterId("Bitcoin ETF inflows hit record high!");
  const b = clusterId("Record high: bitcoin ETF inflows hit");
  const c = clusterId("Ethereum upgrade scheduled for March");
  assert.equal(a, b, "word-order-insensitive match");
  assert.notEqual(a, c, "different stories differ");
  assert.ok(/^c[0-9a-z]+$/.test(a), "id format");
});
