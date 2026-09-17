// tests/signal_model.test.js — the confluence model's contract: TA
// primitives, regime alignment, and flowConfidence weights. If these
// numbers change, docs/SIGNAL_MODEL.md must change with them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rsi, ema, classifyRegime, regimeAlignment, taSnapshot } from "../src/ta.js";
import { flowConfidence, sanitizeWeights } from "../src/analyst.js";

const UP = Array.from({ length: 60 }, (_, i) => 100 + i);        // monotonic up
const DOWN = Array.from({ length: 60 }, (_, i) => 200 - i);      // monotonic down
const FLAT = Array.from({ length: 60 }, () => 100);              // no movement

test("rsi: Wilder RSI on synthetic series", () => {
  assert.equal(rsi(UP, 14), 100, "pure uptrend → 100");
  assert.equal(rsi(DOWN, 14), 0, "pure downtrend → 0");
  assert.equal(rsi(FLAT, 14), 50, "flat → 50 (no losses, no gains)");
  assert.equal(rsi(UP.slice(0, 10), 14), null, "needs period+1 closes");
});

test("ema: constant series holds the level", () => {
  assert.equal(ema(FLAT, 20), 100);
  assert.equal(ema(UP, 20) > 100, true, "ema of uptrend sits above the first price");
  assert.equal(ema(UP.slice(0, 5), 20), null, "needs n closes");
});

test("classifyRegime: trend, stretched, and choppy", () => {
  const bull = { rsi: 60, ema20: 105, ema50: 100, last: 110 };
  assert.equal(classifyRegime(bull), "bull_trend");
  const bear = { rsi: 40, ema20: 95, ema50: 100, last: 90 };
  assert.equal(classifyRegime(bear), "bear_trend");
  assert.equal(classifyRegime({ rsi: 25, ema20: 100, ema50: 100, last: 100 }), "oversold");
  assert.equal(classifyRegime({ rsi: 75, ema20: 100, ema50: 100, last: 100 }), "overbought");
  assert.equal(classifyRegime({ rsi: 50, ema20: 100, ema50: 100, last: 100 }), "choppy");
  assert.equal(classifyRegime({}), "unknown");
});

test("regimeAlignment: trend + mean-reversion alignment matrix", () => {
  assert.equal(regimeAlignment("bull_trend", true), 1);
  assert.equal(regimeAlignment("bull_trend", false), -1);
  assert.equal(regimeAlignment("bear_trend", false), 1);
  assert.equal(regimeAlignment("oversold", true), 1, "stretched down supports bullish mean-reversion");
  assert.equal(regimeAlignment("oversold", false), -1);
  assert.equal(regimeAlignment("overbought", false), 1);
  assert.equal(regimeAlignment("choppy", true), 0);
  assert.equal(regimeAlignment("unknown", true), 0);
});

test("taSnapshot: full stack from a series", () => {
  const series = UP.map((price, i) => ({ ts: i * 3600_000, price }));
  const t = taSnapshot(series);
  assert.equal(t.rsi14, 100);
  assert.equal(t.regime, "overbought", "RSI 70+ dominates classification even in an uptrend");
  assert.equal(taSnapshot(series.slice(0, 40)).regime, "unknown", "needs ≥51 rows");
});

test("flowConfidence: base, clamps, and the huge-unlabeled cap", () => {
  const base = flowConfidence({ bullish: true });
  assert.equal(base.confidence, 0.60);
  assert.deepEqual(base.features, []);

  // every category agrees → clamped at 0.85
  const all = flowConfidence({
    bullish: true, fgRegime: "greed", behavior: "accumulation",
    taRegime: "bull_trend", sizeRatio: 8, newsSent: { sum: 3, n: 4 },
  });
  assert.equal(all.confidence, 0.85);
  assert.equal(all.features.length, 5);

  // every category conflicts → floored at 0.50
  const none = flowConfidence({
    bullish: true, fgRegime: "fear", behavior: "distribution",
    taRegime: "bear_trend", sizeRatio: 0.1, newsSent: { sum: -3, n: 4 },
  });
  assert.equal(none.confidence, 0.50);
  assert.equal(none.features.length, 5);

  // huge unlabeled caps regardless of agreement
  const capped = flowConfidence({
    bullish: true, fgRegime: "greed", behavior: "accumulation",
    taRegime: "bull_trend", sizeRatio: 8, newsSent: { sum: 3, n: 4 }, hugeUnlabeled: true,
  });
  assert.equal(capped.confidence, 0.55);

  // news sentiment needs ≥2 headlines to count (one headline is noise)
  const oneHeadline = flowConfidence({ bullish: true, newsSent: { sum: 2, n: 1 } });
  assert.equal(oneHeadline.confidence, 0.60);
});

test("flowConfidence: derivatives crowding is contrarian", () => {
  // bullish flow + extreme positive funding (crowded longs) = conflict
  const r1 = flowConfidence({ bullish: true, derivs: { funding: 0.0005 } });
  assert.equal(r1.confidence, 0.55);
  assert.match(r1.features[0], /crowded longs/);
  // bearish flow + crowded longs = confirmation
  const r2 = flowConfidence({ bullish: false, derivs: { funding: 0.0005 } });
  assert.equal(r2.confidence, 0.65);
  assert.match(r2.features[0], /longs crowded/);
  // negative funding supports bullish, fights bearish
  const r3 = flowConfidence({ bullish: true, derivs: { funding: -0.0005 } });
  assert.equal(r3.confidence, 0.65);
  assert.match(r3.features[0], /shorts crowded/);
  // neutral funding → no feature
  const r4 = flowConfidence({ bullish: true, derivs: { funding: 0.0001 } });
  assert.equal(r4.confidence, 0.60);
  assert.deepEqual(r4.features, []);
});

test("sanitizeWeights + adaptive loop: fitted weights override defaults safely", () => {
  // garbage input → defaults
  assert.deepEqual(sanitizeWeights(null), {});
  assert.deepEqual(sanitizeWeights({ tape: "hack" }), {});
  assert.deepEqual(sanitizeWeights({ tape: 0.5 }), {}, "oversized weight ignored");
  // valid fit output → applied
  assert.deepEqual(sanitizeWeights({ tape: 0.06, fg: 0.04, news: 0.07 }), { tape: 0.06, fg: 0.04, news: 0.07 });
  // regime tape agreement now uses the fitted weight
  const fitted = flowConfidence({ bullish: true, taRegime: "bull_trend", weights: { tape: 0.12 } });
  assert.equal(fitted.confidence, 0.72, "0.60 + fitted tape weight 0.12");
  assert.match(fitted.features[0], /tape agrees \+0\.12/);
});

// ─── vol-adaptive grading + per-regime weights (accuracy round) ───────
import { volThreshold } from "../src/bot.js";

test("volThreshold: flat in calm markets, adaptive in violent ones", () => {
  const calm = Array.from({ length: 168 }, (_, i) => ({ price: 100_000 + Math.sin(i) * 50 }));
  assert.equal(volThreshold(calm), 1.0, "quiet market keeps the 1% floor");
  const wild = Array.from({ length: 168 }, (_, i) => 100_000 * (1 + 0.02 * Math.sin(i * 0.7) + (i % 5) * 0.004));
  assert.ok(volThreshold(wild) > 1.0, "violent market raises the threshold above 1%");
  assert.equal(volThreshold([{ price: 100 }]), 1.0, "too few rows → conservative 1%");
});
