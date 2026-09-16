// src/ta.js — chart-reading primitives. Pure functions, no I/O, unit-tested.
//
// Industry-standard definitions, deliberately boring:
//   rsi()    — Wilder's RSI (the one every trading platform uses)
//   ema()    — exponential moving average seeded with an SMA of the first n
//   classifyRegime() — trend/choppy/oversold/overbought from those pieces
//
// The composite signal model (docs/SIGNAL_MODEL.md) consumes these; nothing
// here knows about whales.

/**
 * Wilder's RSI. Returns null when there isn't period+1 closes.
 * Monotonic up series → 100, monotonic down → ~0.
 */
export function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  return Math.round((100 - 100 / (1 + avgG / avgL)) * 100) / 100;
}

/** EMA(n), seeded with the SMA of the first n values. null when short. */
export function ema(closes, n) {
  if (!Array.isArray(closes) || closes.length < n || n < 1) return null;
  const k = 2 / (n + 1);
  let e = closes.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (let i = n; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return Math.round(e * 100) / 100;
}

/**
 * Regime classification from the pieces. Deliberately coarse — the composite
 * model only needs to know whether the tape agrees with a directional flow.
 *   bull_trend   price above ema20 AND ema20 above ema50
 *   bear_trend   price below ema20 AND ema20 below ema50
 *   oversold     RSI ≤ 30 (mean-reversion watch, regardless of trend)
 *   overbought   RSI ≥ 70
 *   choppy       none of the above
 *   unknown      missing inputs
 */
export function classifyRegime({ rsi: r = null, ema20 = null, ema50 = null, last = null } = {}) {
  if (r == null || ema20 == null || ema50 == null || last == null) return "unknown";
  if (r <= 30) return "oversold";
  if (r >= 70) return "overbought";
  if (ema20 > ema50 && last > ema20) return "bull_trend";
  if (ema20 < ema50 && last < ema20) return "bear_trend";
  return "choppy";
}

/**
 * Convenience: build a full TA snapshot from an ascending [{ts, price}] series.
 * Returns { rsi14, ema20, ema50, last, regime }.
 */
export function taSnapshot(series, { rsiPeriod = 14, emaFast = 20, emaSlow = 50 } = {}) {
  if (!Array.isArray(series) || series.length < emaSlow + 1) {
    return { rsi14: null, ema20: null, ema50: null, last: null, regime: "unknown" };
  }
  const closes = series.map((p) => p.price);
  const r = rsi(closes, rsiPeriod);
  const f = ema(closes, emaFast);
  const s = ema(closes, emaSlow);
  const last = closes[closes.length - 1];
  const regime = classifyRegime({ rsi: r, ema20: f, ema50: s, last });
  return { rsi14: r, ema20: f, ema50: s, last, regime };
}

/**
 * Pure: does the tape agree with a directional call?
 * Returns +1 (agree), −1 (conflict) or 0 (neutral/unknown).
 *   trend regimes agree when the trend matches the call direction;
 *   oversold agrees with bullish mean-reversion, overbought with bearish;
 *   the mirrored alignments conflict.
 */
export function regimeAlignment(regime, bullish) {
  if (!regime || regime === "unknown" || regime === "choppy") return 0;
  if (bullish) {
    if (regime === "bull_trend") return 1;
    if (regime === "bear_trend") return -1;
    if (regime === "oversold") return 1;   // stretched down + bullish flow
    if (regime === "overbought") return -1;
  } else {
    if (regime === "bear_trend") return 1;
    if (regime === "bull_trend") return -1;
    if (regime === "overbought") return 1; // stretched up + bearish flow
    if (regime === "oversold") return -1;
  }
  return 0;
}
