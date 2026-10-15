/**
 * motive.js — Why did the whale do that?
 *
 * A transparent rule-based motive classifier. It fuses:
 *   - transaction type (inflow / outflow / wallet-to-wallet / internal)
 *   - technical snapshot (RSI, trend, Bollinger position, volume)
 *   - news sentiment + catalyst presence
 *   - transfer size vs the whale's own history
 *
 * The classifier produces a *preliminary* motive with a confidence and a
 * human-readable reasoning chain. The analyst LLM receives it as a starting
 * hypothesis and may refine or override it — the final motive stored is the
 * LLM's, but this keeps the LLM honest and gives a sane answer when the LLM
 * abstains or fails.
 *
 * Motive labels (stable set — the predictions table aggregates on these):
 *   accumulation | distribution | capitulation | profit_taking |
 *   dry_powder | cold_storage | otc_deal | internal_ops |
 *   rebalancing | unknown
 */

/**
 * Classify the likely motive.
 * @param {object} p
 *   txType, ta (snapshot from ta.js or null), sentiment (-1..1),
 *   newsCount (relevant headlines in ±12h), usdValue, avgUsd (whale's mean),
 *   isSelfTransfer, isStable
 */
export function classifyMotive(p) {
  const {
    txType, ta = null, sentiment = 0, newsCount = 0,
    usdValue = 0, avgUsd = 0, isSelfTransfer = false, isStable = false,
  } = p || {};

  const reasons = [];
  const fear = sentiment < -0.25;
  const greed = sentiment > 0.25;
  const oversold = ta && ta.rsi14 != null && ta.rsi14 < 35;
  const overbought = ta && ta.rsi14 != null && ta.rsi14 > 70;
  const downtrend = ta && ta.trend === "downtrend";
  const uptrend = ta && ta.trend === "uptrend";
  const bigVsSelf = avgUsd > 0 && usdValue > avgUsd * 2;
  if (fear) reasons.push("negative news sentiment");
  if (greed) reasons.push("positive news sentiment");
  if (oversold) reasons.push(`RSI ${ta.rsi14} oversold`);
  if (overbought) reasons.push(`RSI ${ta.rsi14} overbought`);
  if (downtrend) reasons.push("downtrend");
  if (uptrend) reasons.push("uptrend");
  if (newsCount > 0) reasons.push(`${newsCount} related headline${newsCount > 1 ? "s" : ""} nearby`);
  if (bigVsSelf) reasons.push("unusually large for this wallet");

  // Self-transfers are never market moves.
  if (isSelfTransfer) {
    return { motive: "internal_ops", confidence: 0.9, reasons: ["sender == receiver"] };
  }
  if (txType === "exchange_internal") {
    return { motive: "internal_ops", confidence: 0.95, reasons: ["exchange internal plumbing"] };
  }

  // Stablecoin inflow to exchange during fear = dry powder.
  if (isStable && txType === "exchange_inflow" && fear) {
    return { motive: "dry_powder", confidence: 0.75, reasons: [...reasons, "stablecoin to exchange in fear = preparing to buy dip"] };
  }
  if (isStable && txType === "exchange_inflow") {
    return { motive: "dry_powder", confidence: 0.6, reasons: [...reasons, "stablecoin to exchange"] };
  }

  switch (txType) {
    case "exchange_inflow": {
      if (fear && (oversold || downtrend)) {
        return { motive: "capitulation", confidence: 0.8, reasons: [...reasons, "inflow during fear/weakness = panic selling"] };
      }
      if (fear) {
        return { motive: "capitulation", confidence: 0.65, reasons: [...reasons, "inflow during negative sentiment"] };
      }
      if (greed && (overbought || uptrend)) {
        return { motive: "profit_taking", confidence: 0.75, reasons: [...reasons, "inflow into strength = distribution"] };
      }
      return { motive: "distribution", confidence: 0.55, reasons: [...reasons, "coins moving to exchange = preparing to sell"] };
    }
    case "exchange_outflow": {
      if (fear && oversold) {
        return { motive: "accumulation", confidence: 0.8, reasons: [...reasons, "withdrawing into fear/oversold = smart-money dip buying"] };
      }
      if (fear) {
        return { motive: "accumulation", confidence: 0.65, reasons: [...reasons, "outflow during fear = contrarian accumulation"] };
      }
      if (ta && ta.bbPos === "near_lower") {
        return { motive: "accumulation", confidence: 0.6, reasons: [...reasons, "buying lower Bollinger"] };
      }
      return { motive: "cold_storage", confidence: 0.6, reasons: [...reasons, "outflow to self-custody"] };
    }
    case "wallet_to_wallet": {
      if (isStable) {
        return { motive: "rebalancing", confidence: 0.55, reasons: [...reasons, "stablecoin moving between private wallets"] };
      }
      if (newsCount === 0 && !bigVsSelf) {
        return { motive: "otc_deal", confidence: 0.5, reasons: [...reasons, "quiet private transfer, no catalyst"] };
      }
      return { motive: "otc_deal", confidence: 0.45, reasons };
    }
    default:
      return { motive: "unknown", confidence: 0.3, reasons };
  }
}

/**
 * Pick the most likely catalyst: highest-importance news within ±windowMs
 * of the whale's detection time that mentions the symbol.
 */
export function pickCatalyst(newsItems, { symbol, detectedAt, windowMs = 6 * 3600 * 1000 } = {}) {
  if (!newsItems || !newsItems.length) return null;
  const sym = (symbol || "").toUpperCase();
  const cands = newsItems.filter((n) => {
    if (n.published_at && Math.abs(n.published_at - detectedAt) > windowMs) return false;
    if (sym && n.symbols && !n.symbols.includes(`,${sym},`)) return false;
    return true;
  });
  if (!cands.length) return null;
  cands.sort((a, b) => (b.importance || 0) - (a.importance || 0));
  const top = cands[0];
  return { title: top.title, url: top.url, source: top.source, sentiment: top.sentiment };
}

/**
 * Estimate market impact: the transfer as basis points of 24h spot volume.
 * volume24hUsd may be null (unknown) — then impact is unknown, not zero.
 */
export function estimateImpact(usdValue, volume24hUsd) {
  if (!volume24hUsd || volume24hUsd <= 0 || !usdValue) {
    return { bps: null, label: "unknown", note: "24h volume unavailable" };
  }
  const bps = (usdValue / volume24hUsd) * 10000;
  const label = bps < 5 ? "negligible" : bps < 50 ? "small" : bps < 200 ? "moderate" : "significant";
  const note =
    label === "negligible" ? "too small to move price on its own"
    : label === "small" ? "unlikely to move price alone, but adds to flow"
    : label === "moderate" ? "could nudge price if executed aggressively"
    : "large enough to move the market if sold into thin books";
  return { bps: +bps.toFixed(1), label, note };
}

/** Render the motive block for the analyst prompt. */
export function motivePromptBlock(pre, catalyst, impact) {
  const lines = [
    "PRELIMINARY MOTIVE ASSESSMENT (rule-based — refine or override with evidence):",
    `- Likely motive: ${pre.motive} (confidence ${pre.confidence})`,
    `- Reasoning: ${pre.reasons.join("; ") || "no strong signals"}`,
  ];
  if (catalyst) {
    lines.push(`- Possible catalyst: "${catalyst.title}" (${catalyst.source}, sentiment ${catalyst.sentiment})`);
  } else {
    lines.push("- Possible catalyst: none found in the news window");
  }
  if (impact && impact.label !== "unknown") {
    lines.push(`- Estimated market impact: ${impact.label} (${impact.bps} bps of 24h volume) — ${impact.note}`);
  }
  lines.push(
    "Your JSON must include: \"motive\" (one of the labels above), \"motive_confidence\" (0-1),",
    "and \"catalyst\" (the headline above, or null). Only override the preliminary motive if the facts contradict it."
  );
  return lines.join("\n");
}
