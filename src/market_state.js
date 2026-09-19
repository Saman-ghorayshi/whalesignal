// src/market_state.js — computes a single 0-100 "market conditions" score
// that tells you whether the environment favors bullish or bearish whale
// flows. This is NOT a trading signal — it's context for the confluence
// model and a dashboard gauge.
//
// Combines: TA regime + funding crowding + netflow direction + F&G +
// news sentiment into one explainable number. Each component logs its
// contribution so you can see WHY the score is what it is.
//
// Score: >55 = bullish environment, <45 = bearish environment, 45-55 = neutral.

/**
 * Pure: compute the market state score from component inputs.
 * All inputs optional — missing components reduce the max possible score
 * (the model is honest about what it doesn't know).
 *
 * @param {object} inputs
 *   { taRegime, rsi14, funding, netflow_24h, fearGreed, newsSent }
 * @returns {{ score: number, components: object, confidence: string }}
 */
export function computeMarketState({ taRegime = null, rsi14 = null, ema20 = null, ema50 = null,
  funding = null, netInflow24h = null, fearGreed = null, newsSent = null } = {}) {

  const parts = [];
  let score = 50;
  let maxConfidence = 0;

  // ── TA regime (25 points max) ──
  if (taRegime) {
    if (taRegime === "bull_trend") { score += 15; parts.push({ name: "trend", value: "+15 (bull trend)" }); }
    else if (taRegime === "bear_trend") { score -= 15; parts.push({ name: "trend", value: "-15 (bear trend)" }); }
    else if (taRegime === "overbought") { score += 5; parts.push({ name: "trend", value: "+5 (overbought = momentum)" }); }
    else if (taRegime === "oversold") { score -= 5; parts.push({ name: "trend", value: "-5 (oversold = weakness)" }); }
    else { parts.push({ name: "trend", value: "0 (choppy)" }); }
    maxConfidence += 25;
  }

  // ── Funding rate crowding (20 points max) ──
  if (funding != null) {
    // extreme positive = crowded longs = bearish; extreme negative = crowded shorts = bullish
    if (funding > 0.0003) { score -= 10; parts.push({ name: "funding", value: "-10 (crowded longs)" }); }
    else if (funding < -0.0003) { score += 10; parts.push({ name: "funding", value: "+10 (crowded shorts)" }); }
    else if (funding > 0.0001) { score -= 3; parts.push({ name: "funding", value: "-3 (mild long bias)" }); }
    else if (funding < -0.0001) { score += 3; parts.push({ name: "funding", value: "+3 (mild short bias)" }); }
    else { parts.push({ name: "funding", value: "0 (neutral)" }); }
    maxConfidence += 20;
  }

  // ── Exchange netflow (20 points max) ──
  if (netInflow24h != null) {
    // negative net = outflows = accumulation = bullish; positive = inflows = selling = bearish
    if (netInflow24h < -10_000_000) { score += 10; parts.push({ name: "netflow", value: "+10 (net outflows = accumulation)" }); }
    else if (netInflow24h > 10_000_000) { score -= 10; parts.push({ name: "netflow", value: "-10 (net inflows = selling)" }); }
    else if (netInflow24h < -1_000_000) { score += 3; parts.push({ name: "netflow", value: "+3 (mild outflows)" }); }
    else if (netInflow24h > 1_000_000) { score -= 3; parts.push({ name: "netflow", value: "-3 (mild inflows)" }); }
    else { parts.push({ name: "netflow", value: "0 (balanced)" }); }
    maxConfidence += 20;
  }

  // ── Fear & Greed (15 points max) ──
  if (fearGreed != null) {
    const fgAdj = Math.round((fearGreed - 50) / 50 * 15);
    score += fgAdj;
    parts.push({ name: "fear_greed", value: `${fgAdj >= 0 ? "+" : ""}${fgAdj} (F&G ${fearGreed})` });
    maxConfidence += 15;
  }

  // ── News sentiment (20 points max) ──
  if (newsSent && newsSent.n > 0) {
    const avg = newsSent.sum / newsSent.n;
    const adj = Math.round(avg * 20);
    score += adj;
    parts.push({ name: "news", value: `${adj >= 0 ? "+" : ""}${adj} (${newsSent.n} headlines, avg ${avg.toFixed(1)})` });
    maxConfidence += 20;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // confidence: how many categories actually contributed
  const contributing = parts.length;
  const confidence = contributing >= 4 ? "high" : contributing >= 2 ? "medium" : contributing >= 1 ? "low" : "none";

  const bias = score >= 65 ? "bullish" : score >= 45 ? "neutral" : "bearish";
  return { score, bias, confidence, components: parts.map(p => p.value) };
}
