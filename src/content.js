/**
 * content.js — the content brief machine.
 *
 * NOT a video generator (that's slop). This turns a whale alert into a
 * human-ready content brief: a thumb-stopping hook, a 30-second spoken
 * script with a real take, caption, and hashtags. A person films it.
 *
 * The script is the anti-slop: one idea, spoken language, an actual
 * opinion, and an honest caveat. Data is the peg; the take is the show.
 */

import { shortAddr, fmtUSD } from "./worker-utils.js";

const MOTIVE_TAKES = {
  accumulation: "Someone's quietly stacking. Whales accumulate when they think the price is going higher — they don't buy the top.",
  distribution: "This looks like distribution — moving coins toward exchanges. Historically, that's what selling pressure looks like before it hits.",
  exchange_inflow: "Coins moving INTO an exchange usually means one thing: they're getting ready to sell. Watch the price.",
  exchange_outflow: "Coins LEAVING the exchange. That's bullish — you don't withdraw to sell, you withdraw to hold.",
  cold_storage: "Going to cold storage. This whale isn't selling anytime soon — that's a long-term hold signal.",
  otc_deal: "This has OTC written all over it — big move, no exchange, no panic. Two parties, one deal, zero market impact.",
  profit_taking: "Classic profit-taking. Whale bought low, price ran up, now they're trimming. Not bearish long-term, but expect some chop.",
  capitulation: "This smells like capitulation — moving at a loss after a drop. Capitulation is often close to the bottom, ironically.",
  dry_powder: "Stablecoins moving to an exchange. Dry powder loading up — someone's about to buy the dip. Or cause one.",
};

const SIGNAL_LINES = {
  bullish: "My read: bullish.",
  bearish: "My read: bearish.",
  neutral: "No strong signal here — but worth watching.",
};

/**
 * Build a content brief for a whale. Pure.
 * @param {object} whale — whales row
 * @param {object|null} analysis — analysis row (may be null)
 * @returns {object} { hook, script, caption, hashtags, chart_hint }
 */
export function buildContentBrief(whale, analysis = null) {
  const usd = fmtUSD(whale.usd_value);
  const sym = (whale.symbol || "BTC").toUpperCase();
  const fromShort = shortAddr(whale.from_address);
  const toShort = shortAddr(whale.to_address);
  const fromLabel = whale.from_label || fromShort;
  const toLabel = whale.to_label || toShort;

  const motive = (analysis?.motive || whale.motive || "unknown").toLowerCase();
  const signal = (analysis?.signal || "neutral").toLowerCase();
  const confidence = analysis?.confidence != null ? Math.round(analysis.confidence * 100) : null;

  // ── Hook (first 3 seconds — stop the thumb) ──
  const hook = `${usd} in ${sym} just moved. Here's why it matters.`;

  // ── The take ──
  const take = MOTIVE_TAKES[motive] || MOTIVE_TAKES[whale.tx_type] ||
    "Big money moving. The question is always: why now?";
  const signalLine = SIGNAL_LINES[signal] || SIGNAL_LINES.neutral;

  // ── 30-second spoken script, as timed beats ──
  const beats = [
    { t: "0–3s", label: "HOOK", text: `${usd} worth of ${sym} just moved from ${fromLabel} to ${toLabel}.` },
    { t: "3–20s", label: "THE TAKE", text: `${take} ${signalLine}${confidence ? ` I'm about ${confidence}% on this one.` : ""}` },
    { t: "20–30s", label: "CTA", text: "One move doesn't make a trend — but whales don't move for no reason. Follow for the next one." },
  ];
  const script = beats.map((b) => b.text).join(" ");

  // ── Caption ──
  const caption = [
    `🐋 WHALE ALERT: ${usd} ${sym} → ${toLabel}`,
    ``,
    take,
    ``,
    `Not financial advice. I track the whales so you don't have to.`,
    `Follow @whaletracker for daily whale moves.`,
  ].join("\n");

  const hashtags = ["#crypto", "#bitcoin", "#whalealert", "#btc", "#cryptonews", "#onchain"]
    .slice(0, 6).join(" ");

  return {
    whale_id: whale.id,
    hook,
    script,
    beats,
    caption,
    hashtags,
    chart_hint: `Use the whale chart for ${sym} (already generated with the alert).`,
    meta: {
      usd_value: whale.usd_value,
      symbol: sym,
      motive,
      signal,
      confidence,
      from: fromLabel,
      to: toLabel,
      detected_at: whale.detected_at || null,
    },
  };
}
