// src/signal_math.js — pure, testable signal math behind the confluence
// model's newest feature lines. Research base lives in docs/RESEARCH.md
// (Sep 19 wave); every function here states the paper it encodes.
// No I/O, no imports — unit-tested in tests/signal_math.test.js.

// ─── square-root law of market impact ─────────────────────────────────
//
// Expected price impact of a metaorder scales with the SQUARE ROOT of its
// size relative to traded volume: ΔP ≈ σ_daily · √(Q/V). Validated across
// four decades of order sizes on Bitcoin specifically ("A Million Metaorder
// Analysis of Market Impact on the Bitcoin", World Scientific) and widely on
// equities/futures/options (Tóth et al. 2016; Gatheral; Bouchaud et al.).
//
// We use it to answer the money question per alert: is this flow BIG
// RELATIVE TO THE MARKET that must absorb it — big enough to actually move
// price past our vol-adaptive grading threshold — or is it noise?

/** A flow that is 0.1% of daily volume is "routine" (multiplier 1.0). */
export const IMPACT_REF_RATIO = 0.001;
/** Cap so a 20%-of-volume flow can't blow the weight bounds. */
export const IMPACT_CAP = 8;

/** Q/V as a plain ratio, or null when either side is missing/invalid. */
export function impactRatio(usd, volume24h) {
  const q = Number(usd), v = Number(volume24h);
  if (!(q > 0) || !(v > 0)) return null;
  return q / v;
}

/** √-law multiplier vs the routine reference: 0.1% of ADV → 1.0,
 *  1% → ~3.2, 5% → ~7.1 (capped at IMPACT_CAP). */
export function impactMultiplier(ratio) {
  if (ratio == null || !(ratio > 0)) return null;
  return Math.min(IMPACT_CAP, Math.sqrt(ratio / IMPACT_REF_RATIO));
}

/** Expected one-side impact in PERCENT of price: σ_daily% · √(Q/V).
 *  At Q = V (the whole day's volume in one order) the model says ~σ_daily —
 *  the literature's calibration (impact ≈ 0.5–1× daily vol at one ADV). */
export function expectedImpactPct(ratio, dailyVolPct) {
  if (ratio == null || !(ratio > 0) || !(dailyVolPct > 0)) return null;
  return dailyVolPct * Math.sqrt(ratio);
}

/** Dailyized return volatility in percent from an hourly price series —
 *  the σ_daily the √-law needs. Same math as the grading engine's
 *  vol-adaptive threshold (bot.js volThreshold) so impact and grading
 *  share one bar. Needs ≥ 24 rows to be meaningful; null otherwise. */
export function dailyizedVolPct(prices) {
  const ps = (prices || [])
    .map((p) => (typeof p === "object" ? Number(p.price) : Number(p)))
    .filter((p) => Number.isFinite(p) && p > 0);
  if (ps.length < 24) return null;
  const rets = [];
  for (let i = 1; i < ps.length; i++) rets.push(Math.log(ps[i] / ps[i - 1]));
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  return Math.sqrt(24) * sd * 100;
}

/** The grader's threshold formula, shared: max(1%, half the daily vol). */
export function gradingThresholdPct(dailyVolPct) {
  return Math.max(1.0, 0.5 * (dailyVolPct > 0 ? dailyVolPct : 0));
}

// ─── intraday liquidity seasonality ───────────────────────────────────
//
// BTC volume/variance have strong time-of-day periodicities tied to
// traditional sessions (Wang 2020, "Time-of-Day Periodicities of Trading
// Volume and Volatility in Bitcoin"): the US session (13:00–21:00 UTC) is
// the thick window, 22:00–06:00 UTC is the trough. Related SSRN work
// ("When Markets Never Sleep") finds crypto liquidity is largely "volume
// in disguise" — depth tracks volume — so the SAME flow hits harder in
// thin hours. Multipliers are deliberately conservative.

/** 1.15 thin (22–06 UTC), 0.9 thick (13–21 UTC), else 1.0. */
export function liquidityHourFactor(timestampMs, utcHour = null) {
  const h = utcHour != null ? Number(utcHour) : new Date(timestampMs).getUTCHours();
  if (h >= 22 || h < 6) return 1.15;
  if (h >= 13 && h <= 21) return 0.9;
  return 1.0;
}

// ─── dormancy (coin-days-destroyed proxy) ─────────────────────────────
//
// Glassnode's CDD / Average Coin Dormancy literature: long-dormant coins
// moving is a rare, high-conviction event — historically flags long-term
// holder distribution when it lands on exchanges. We can't see true UTXO
// age, so the proxy is OUR sighting gap: a wallet the scanner hasn't seen
// doing whale-sized things for N days reactivating. Honest limitation, real
// signal — dormant reactivations are exactly what the CDD papers flag.

/** Days since our last sighting of the wallet, or null when unknown.
 *  Number.isFinite (no coercion) — Number(null) is 0 and would read a
 *  never-seen wallet as "quiet since 1970" (20715-day false dormancy).
 *  Clock skew / out-of-order sightings clamp at 0. */
export function dormancyDays(lastSeen, detectedAt) {
  if (!Number.isFinite(lastSeen) || !Number.isFinite(detectedAt)) return null;
  const d = Math.floor((detectedAt - lastSeen) / 86_400_000);
  return d > 0 ? d : 0;
}

// (tiering note: the ≥30d / ≥90d tiers live in flowConfidence — +W.history
// and +0.03 respectively — so the weights stay in one place.)

// ─── ledger calibration (closing the accountability loop) ─────────────
//
// The grading ledger produces outcome:{bucket}:{outcome} counters — realized
// results for every call, bucketed by the confidence we claimed. This is the
// missing piece the model card flagged ("weights are priors until
// calibrated"): shrink the confluence prior toward realized directional
// accuracy with a Beta-Binomial posterior, strength k=20 (≈20 graded calls
// halve the prior's weight; small samples barely move it).
//
// n counts correct+wrong only. A no_move is a missed MOVE, not a wrong
// DIRECTION — confidence expresses directional conviction, so no_move rows
// inform a different calibration (regime filters), not this one.

export function calibrate(prior, { correct = 0, wrong = 0 } = {}, strength = 20) {
  const p = Math.min(0.85, Math.max(0.05, Number(prior) || 0.6));
  const c = Math.max(0, Number(correct) || 0);
  const w = Math.max(0, Number(wrong) || 0);
  const n = c + w;
  if (n <= 0) return { confidence: prior, n: 0, acc: null };
  const adj = (strength * p + c) / (strength + n);
  return { confidence: Math.round(adj * 100) / 100, n, acc: c / n };
}

/** Pick the confidence bucket the way the grader does (bot.js
 *  confidenceBucket): high ≥ 0.75, mid ≥ 0.60, low below. */
export function bucketFor(conf) {
  const c = Number(conf) || 0;
  if (c >= 0.75) return "high";
  if (c >= 0.6) return "mid";
  return "low";
}
