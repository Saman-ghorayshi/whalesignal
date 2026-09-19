// tests/signal_math.test.js — the research-backed signal math in
// src/signal_math.js plus its wiring into the confluence model. The research
// base for each formula is cited in docs/RESEARCH.md (Sep 19 wave).
import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  impactRatio, impactMultiplier, expectedImpactPct, dailyizedVolPct,
  gradingThresholdPct, liquidityHourFactor, dormancyDays, dormancyFactor,
  calibrate, bucketFor, IMPACT_CAP,
} from "../src/signal_math.js";
import { flowConfidence, templateAnalysis } from "../src/analyst.js";

const DAY = 86_400_000;

// ─── square-root impact ────────────────────────────────────────────────

test("impactRatio: null on missing/invalid sides", () => {
  assert.equal(impactRatio(1_000_000, null), null);
  assert.equal(impactRatio(null, 10e9), null);
  assert.equal(impactRatio(-5, 10e9), null);
  assert.equal(impactRatio(0, 10e9), null);
});

test("impactMultiplier: √-law vs the 0.1%-of-ADV reference", () => {
  assert.equal(impactMultiplier(0.001), 1);                    // routine
  assert.ok(Math.abs(impactMultiplier(0.01) - 3.162) < 0.01);  // √10
  assert.ok(Math.abs(impactMultiplier(0.05) - 7.07) < 0.05);   // √50
  assert.equal(impactMultiplier(100), IMPACT_CAP, "capped");
  assert.equal(impactMultiplier(null), null);
});

test("expectedImpactPct: σ_daily·√(Q/V) — one full ADV ≈ one daily vol", () => {
  // Q = V → √1 → exactly the daily vol
  assert.ok(Math.abs(expectedImpactPct(1, 3) - 3) < 1e-9);
  // Q = 1% of V, daily vol 3% → 3%·0.1 = 0.3%
  assert.ok(Math.abs(expectedImpactPct(0.01, 3) - 0.3) < 1e-9);
  assert.equal(expectedImpactPct(0.01, null), null);
});

test("dailyizedVolPct matches the grader's vol math; gradingThresholdPct mirrors the grader", () => {
  // constant price → 0 returns → vol 0 → null path? No: sd=0 → returns 0? —
  // dailyizedVolPct returns √24·0·100 = 0, which is a VALID 0, distinct from null
  const flat = dailyizedVolPct([100, 100, 100, ...Array(30).fill(100)]);
  assert.equal(flat, 0);
  assert.equal(dailyizedVolPct([100].map((p, i) => p + i).slice(0, 10)), null, "<24 rows → null");
  // threshold bar: max(1%, half of vol)
  assert.equal(gradingThresholdPct(0.5), 1.0);
  assert.ok(Math.abs(gradingThresholdPct(6) - 3) < 1e-9);
});

// ─── intraday liquidity seasonality ────────────────────────────────────

test("liquidityHourFactor: thin 22-06 UTC, thick 13-21 UTC, normal between", () => {
  // use explicit hours to stay timezone-independent
  assert.equal(liquidityHourFactor(0, 2), 1.15);   // thin (post-US, pre-Asia)
  assert.equal(liquidityHourFactor(0, 22), 1.15);
  assert.equal(liquidityHourFactor(0, 5), 1.15);
  assert.equal(liquidityHourFactor(0, 15), 0.9);   // US session
  assert.equal(liquidityHourFactor(0, 21), 0.9);
  assert.equal(liquidityHourFactor(0, 10), 1.0);   // Europe morning
  // real timestamp path: 2026-09-19T15:00:00Z = hour 15 → thick
  assert.equal(liquidityHourFactor(Date.UTC(2026, 8, 19, 15)), 0.9);
});

// ─── dormancy ──────────────────────────────────────────────────────────

test("dormancyDays: sighting gap in days, clamped, null when unknown", () => {
  const now = Date.UTC(2026, 8, 19);
  assert.equal(dormancyDays(now - 95 * DAY, now), 95);
  assert.equal(dormancyDays(now - 30 * DAY, now), 30);
  assert.equal(dormancyDays(now - 1 * DAY, now), 1);
  assert.equal(dormancyDays(now + 3600_000, now), 0, "future last_seen clamps to 0");
  assert.equal(dormancyDays(null, now), null);
  assert.equal(dormancyFactor(95), 1.25);
  assert.equal(dormancyFactor(30), 1.1);
  assert.equal(dormancyFactor(5), null, "routine churn is not a signal");
});

// ─── calibration loop ──────────────────────────────────────────────────

test("calibrate: Beta-Binomial shrinkage toward realized accuracy", () => {
  // no ledger → unchanged
  assert.deepEqual(calibrate(0.6, {}), { confidence: 0.6, n: 0, acc: null });
  // 20 graded calls, 100% correct → pulled up from 0.6 to (20·0.6+20)/40 = 0.8
  const up = calibrate(0.6, { correct: 20, wrong: 0 });
  assert.equal(up.confidence, 0.8);
  assert.equal(up.n, 20);
  // 20 graded, 0% correct → dragged to 0.3
  const down = calibrate(0.6, { correct: 0, wrong: 20 });
  assert.equal(down.confidence, 0.3);
  // small samples barely move: 2/2 correct → (20·0.6+2)/22 ≈ 0.636
  const small = calibrate(0.6, { correct: 2, wrong: 0 });
  assert.ok(small.confidence > 0.6 && small.confidence < 0.65);
  // no_move rows never enter n (caller's job, but the math only sums c+w)
  assert.equal(calibrate(0.6, { correct: 1, wrong: 1 }).n, 2);
});

test("bucketFor matches the grader's confidence buckets", () => {
  assert.equal(bucketFor(0.80), "high");
  assert.equal(bucketFor(0.75), "high");
  assert.equal(bucketFor(0.65), "mid");
  assert.equal(bucketFor(0.60), "mid");
  assert.equal(bucketFor(0.55), "low");
});

// ─── confluence integration ────────────────────────────────────────────

test("flowConfidence: impact above the bar adds, negligible impact subtracts", () => {
  const base = flowConfidence({ bullish: true });
  const strong = flowConfidence({
    bullish: true,
    impact: { expectedPct: 2.5, thresholdPct: 1.5 },
  });
  assert.ok(strong.confidence > base.confidence, `strong ${strong.confidence} > base ${base.confidence}`);
  assert.ok(strong.features.some((f) => f.includes("√impact")), strong.features.join("; "));

  const weak = flowConfidence({
    bullish: true,
    impact: { expectedPct: 0.1, thresholdPct: 1.5 },
  });
  assert.ok(weak.confidence < base.confidence, `weak ${weak.confidence} < base ${base.confidence}`);
  assert.ok(weak.features.some((f) => f.includes("≪")), weak.features.join("; "));

  // the middle band (t/10 … t) changes nothing — most honest alerts live here
  const mid = flowConfidence({
    bullish: true,
    impact: { expectedPct: 0.5, thresholdPct: 1.5 },
  });
  assert.equal(mid.confidence, base.confidence);
});

test("flowConfidence: dormant reactivation adds the history weight", () => {
  const base = flowConfidence({ bullish: true });
  const dorm = flowConfidence({
    bullish: true,
    impact: { expectedPct: null, thresholdPct: null, dormancyDays: 95 },
  });
  assert.ok(dorm.confidence > base.confidence);
  assert.ok(dorm.features.some((f) => f.includes("dormancy 95d")), dorm.features.join("; "));
  // <30d = routine churn, no line
  const quiet5 = flowConfidence({
    bullish: true,
    impact: { dormancyDays: 5 },
  });
  assert.equal(quiet5.confidence, base.confidence);
});

test("flowConfidence: calibration engages at n≥10 and moves toward realized accuracy", () => {
  const base = flowConfidence({ bullish: true });
  // bucket for the base 0.60 confidence is 'mid' — feed it a bad ledger
  const bad = flowConfidence({
    bullish: true,
    calib: { mid: { correct: 0, wrong: 30 } },
  });
  assert.ok(bad.confidence < base.confidence, `bad ledger must drag confidence (${bad.confidence} < ${base.confidence})`);
  assert.ok(bad.features.some((f) => f.includes("ledger-calibrated")), bad.features.join("; "));
  // tiny ledger (n=6) must NOT engage
  const tiny = flowConfidence({
    bullish: true,
    calib: { mid: { correct: 0, wrong: 6 } },
  });
  assert.equal(tiny.confidence, base.confidence);
});

// ─── templateAnalysis end-to-end with the impact context ───────────────

const MARKET = {
  fear_greed: 50, fear_greed_label: "Neutral",
  btc: { price: 100_000, change_24h: 0, vol_24h: 30e9 },
  eth: { price: 3_500, change_24h: 0, vol_24h: 15e9 },
};

// hour 10 UTC = "normal" session (factor 1.0) → deterministic impact math
const DETECTED = Date.UTC(2026, 8, 19, 10);

function whaleBtcInflow(usd, hour = 10) {
  return {
    chain: "btc", symbol: "BTC", usd_value: usd, tx_type: "exchange_inflow",
    from_address: "0xwhale", to_address: "0xbinance",
    detected_at: Date.UTC(2026, 8, 19, hour),
    price_at_detect: 100_000,
  };
}

test("templateAnalysis: a flow that can't move the market is dampened, one that can is boosted", () => {
  const ctx = {
    ta: null, newsSent: null, derivs: null, weights: null,
    volPct: 2.0,           // daily vol 2% → grading bar 1%
    calib: null, fromLastSeen: null,
  };
  // $60K on a $30B volume day = 2e-6 of ADV → √-law expected ≈ 0.0028%
  // < bar/10 (0.1%) → −W.size
  const small = templateAnalysis(whaleBtcInflow(60_000), MARKET, [], ctx);
  assert.ok(small.features.some((f) => f.includes("≪")), JSON.stringify(small.features));
  assert.ok(small.interpretation.includes("too small to move the market"), small.interpretation);

  // $85M = 0.28% of ADV → expected ≈ 0.107% — inside the neutral band
  // (bar/10=0.1 … bar=1.0) → no impact line; below the $100M huge-unlabeled
  // cap → straight base confidence, above the damped small flow
  const mid = templateAnalysis(whaleBtcInflow(85e6), MARKET, [], ctx);
  assert.ok(!mid.features.some((f) => f.includes("√impact")), JSON.stringify(mid.features));
  assert.ok(mid.confidence > small.confidence, `${mid.confidence} > ${small.confidence}`);

  // $7.5B = 25% of ADV → √0.25 = 0.5 → expected = 1.0% ≥ the 1% bar → boost
  // fires; the final confidence is then capped at 0.55 by the huge-unlabeled
  // treasury-migration guard (as designed — the reasoning stays visible)
  const huge = templateAnalysis(whaleBtcInflow(7.5e9), MARKET, [], ctx);
  assert.ok(huge.features.some((f) => f.includes("≥")), JSON.stringify(huge.features));
  assert.equal(huge.confidence, 0.55);
});

test("templateAnalysis: thin-session factor and dormancy ride along", () => {
  // 03:00 UTC = thin session (×1.15); wallet unseen for exactly 95 days
  const detected = Date.UTC(2026, 8, 19, 2);
  const ctx = {
    ta: null, newsSent: null, derivs: null, weights: null,
    volPct: 3.0,           // bar = max(1%, 1.5) = 1.5%
    calib: null,
    fromLastSeen: detected - 95 * DAY,
  };
  // $2B at 03:00 UTC = 6.7% of ADV → √0.067·3%·1.15 ≈ 0.89% — inside the
  // neutral band (bar/10=0.15 … bar=1.5) → no impact line, but the dormancy
  // reactivation line MUST fire and the interpretation must say why.
  const r = templateAnalysis({ ...whaleBtcInflow(2e9, 2), detected_at: detected }, MARKET, [], ctx);
  assert.ok(!r.features.some((f) => f.includes("√impact")), r.features.join("; "));
  assert.ok(r.features.some((f) => f.includes("dormancy 95d")), r.features.join("; "));
  assert.ok(r.interpretation.includes("95 days"), r.interpretation);
});

test("templateAnalysis: stables skip the impact model (dry-powder story, not price impact)", () => {
  const ctx = { volPct: 2.0, calib: null, fromLastSeen: null, ta: null, newsSent: null, derivs: null, weights: null };
  const w = { ...whaleBtcInflow(5_000_000), symbol: "USDT", chain: "eth" };
  const r = templateAnalysis(w, MARKET, [], ctx);
  assert.ok(!r.features.some((f) => f.includes("√impact")), r.features.join("; "));
  assert.equal(r.signal, "bullish", "stablecoin inflow stays bullish (inversion)");
});
