// tests/sprint3.test.js — Sprint 3: event clustering, accuracy stats
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatClusterNote, renderStatsJSON } from "../src/bot.js";

// ─── formatClusterNote (pure) ─────────────────────────────────────────

test("formatClusterNote: returns null for 0 (no cluster)", () => {
  assert.equal(formatClusterNote(0), null);
});

test("formatClusterNote: returns null for undefined/null", () => {
  assert.equal(formatClusterNote(undefined), null);
  assert.equal(formatClusterNote(null), null);
});

test("formatClusterNote: count=1 → singular 'transfer'", () => {
  const out = formatClusterNote(1);
  assert.equal(out, "📦 2 whale transfers to this address in the last 15 min");
});

test("formatClusterNote: count=4 → plural 'transfers'", () => {
  const out = formatClusterNote(4);
  assert.equal(out, "📦 5 whale transfers to this address in the last 15 min");
});

test("formatClusterNote: includes emoji and timeframe", () => {
  const out = formatClusterNote(2);
  assert.ok(out.startsWith("📦"));
  assert.ok(out.includes("15 min"));
});

// ─── accuracy stats in renderStatsJSON (pure) ──────────────────────────

test("renderStatsJSON: accuracy null when no eval data", () => {
  const out = renderStatsJSON({ total_whales: 10 }, [], [], null);
  assert.equal(out.accuracy, null);
});

test("renderStatsJSON: accuracy populated when eval data exists", () => {
  const out = renderStatsJSON({ total_whales: 10, accuracy_total: 8, accuracy_correct: 6 }, [], [], null);
  assert.deepEqual(out.accuracy, {
    evaluated: 8,
    correct: 6,
    rate: 75,
  });
});

test("renderStatsJSON: accuracy rate=100 when all correct", () => {
  const out = renderStatsJSON({ total_whales: 5, accuracy_total: 3, accuracy_correct: 3 }, [], [], null);
  assert.equal(out.accuracy.rate, 100);
});

test("renderStatsJSON: accuracy rate=0 when none correct", () => {
  const out = renderStatsJSON({ total_whales: 5, accuracy_total: 4, accuracy_correct: 0 }, [], [], null);
  assert.equal(out.accuracy.rate, 0);
});

// ─── evaluate_signal logic (pure, mirrors Python) ─────────────────────
// ponytail: mirror the Python eval logic in JS for testing without a Python runtime.

function evaluateSignal(signal, priceAtDetect, priceNow, thresholdPct = 1.0) {
  if (!signal || signal === "neutral") return "neutral";
  if (!priceAtDetect || !priceNow) return "no_data";
  const pct = ((priceNow - priceAtDetect) / priceAtDetect) * 100;
  const up = pct > thresholdPct;
  const down = pct < -thresholdPct;
  if (signal === "bullish") return up ? "correct" : (down ? "wrong" : "neutral");
  if (signal === "bearish") return down ? "correct" : (up ? "wrong" : "neutral");
  return "neutral";
}

test("eval logic: bullish + price up = correct", () => {
  assert.equal(evaluateSignal("bullish", 100, 105, 1.0), "correct");
});

test("eval logic: bullish + price down = wrong", () => {
  assert.equal(evaluateSignal("bullish", 100, 95, 1.0), "wrong");
});

test("eval logic: bearish + price down = correct", () => {
  assert.equal(evaluateSignal("bearish", 100, 95, 1.0), "correct");
});

test("eval logic: bearish + price up = wrong", () => {
  assert.equal(evaluateSignal("bearish", 100, 105, 1.0), "wrong");
});

test("eval logic: movement under threshold = neutral", () => {
  assert.equal(evaluateSignal("bullish", 100, 100.5, 1.0), "neutral");
});

test("eval logic: neutral signal = always neutral", () => {
  assert.equal(evaluateSignal("neutral", 100, 200, 1.0), "neutral");
});

test("eval logic: missing prices = no_data", () => {
  assert.equal(evaluateSignal("bullish", null, 100, 1.0), "no_data");
  assert.equal(evaluateSignal("bullish", 100, null, 1.0), "no_data");
});
