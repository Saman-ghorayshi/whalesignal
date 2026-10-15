/**
 * causal.js — "What caused what caused what."
 *
 * Builds an evidence chain for a whale: everything relevant that happened in
 * the 24h BEFORE the move, in chronological order — news, sentiment shifts,
 * market events, price action — ending with the whale itself. The code
 * assembles the timeline; the analyst LLM draws the causal arrows
 * ("the SEC headline at 14:02 likely triggered the capitulation at 15:15").
 *
 * A link: { t: epoch ms, kind, icon, text }. Kinds:
 *   news | sentiment | market_event | price | whale
 */

const WINDOW_MS = 24 * 3600000;

function fmtTime(t) {
  return new Date(t).toISOString().slice(5, 16).replace("T", " ");
}

/**
 * Build the evidence chain ending at the whale's detection.
 * All sources are best-effort; a thin chain is better than none.
 */
export async function buildChain(env, whale, ta = null) {
  const links = [];
  const sym = (whale.symbol || "BTC").toUpperCase();
  const tradable = ["BTC", "ETH", "SOL"].includes(sym) ? sym : "BTC";
  const end = whale.detected_at || Date.now();
  const start = end - WINDOW_MS;

  // 1. News — top 3 by importance, symbol-matched, in window
  try {
    const rows = await env.DB.prepare(
      `SELECT title, source, published_at, sentiment, importance
       FROM news
       WHERE published_at BETWEEN ? AND ?
         AND symbols LIKE ?
       ORDER BY importance DESC LIMIT 3`
    ).bind(start, end, `%,${sym},%`).all();
    for (const n of rows.results || []) {
      links.push({
        t: n.published_at || end - 3600000,
        kind: "news",
        icon: "📰",
        text: `${n.title.slice(0, 90)} (${n.source}${n.sentiment < -0.25 ? ", bearish" : n.sentiment > 0.25 ? ", bullish" : ""})`,
      });
    }
  } catch {}

  // 2. Market events — pumps, RSI extremes, etc. in window
  try {
    const rows = await env.DB.prepare(
      `SELECT type, detected_at, details FROM market_events
       WHERE symbol = ? AND detected_at BETWEEN ? AND ?
       ORDER BY detected_at ASC LIMIT 5`
    ).bind(tradable, start, end).all();
    for (const e of rows.results || []) {
      links.push({
        t: e.detected_at,
        kind: "market_event",
        icon: e.type === "pump" ? "🚀" : e.type === "dump" ? "📉" : "⚡",
        text: describeEvent(e),
      });
    }
  } catch {}

  // 3. Sentiment shift — first vs last snapshot in window
  try {
    const rows = await env.DB.prepare(
      `SELECT t, composite, label FROM sentiment_snapshots
       WHERE t BETWEEN ? AND ? ORDER BY t ASC`
    ).bind(start, end).all();
    const snaps = rows.results || [];
    if (snaps.length >= 2) {
      const a = snaps[0], b = snaps[snaps.length - 1];
      const d = b.composite - a.composite;
      if (Math.abs(d) >= 0.15) {
        links.push({
          t: b.t,
          kind: "sentiment",
          icon: d > 0 ? "📈" : "📉",
          text: `Sentiment shifted ${a.label} → ${b.label}`,
        });
      }
    }
  } catch {}

  // 4. Price action — 24h move into the whale
  try {
    const rows = await env.DB.prepare(
      `SELECT t, c FROM prices
       WHERE symbol = ? AND timeframe = '1h' AND t BETWEEN ? AND ?
       ORDER BY t ASC`
    ).bind(tradable, start, end).all();
    const candles = rows.results || [];
    if (candles.length >= 2) {
      const first = candles[0].c, last = candles[candles.length - 1].c;
      const pct = ((last - first) / first) * 100;
      if (Math.abs(pct) >= 1) {
        links.push({
          t: end - 60000,
          kind: "price",
          icon: pct > 0 ? "💹" : "📉",
          text: `${tradable} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% in the 24h before the move`,
        });
      }
    }
  } catch {}

  // 5. The whale itself — the chain's conclusion
  links.push({
    t: end,
    kind: "whale",
    icon: "🐋",
    text: `Whale moved ${whale.amount} ${whale.symbol} ($${(whale.usd_value / 1e6).toFixed(1)}M, ${whale.tx_type})`,
  });

  links.sort((a, b) => a.t - b.t);
  return links;
}

function describeEvent(e) {
  let d = {};
  try { d = JSON.parse(e.details || "{}"); } catch {}
  switch (e.type) {
    case "pump": return `Pump: +${d.change1h?.toFixed(1)}% in 1h`;
    case "dump": return `Dump: ${d.change1h?.toFixed(1)}% in 1h`;
    case "rsi_extreme": return `RSI ${d.rsi14} (${d.side})`;
    case "bb_break": return `Bollinger break (${d.bbPos})`;
    case "volume_spike": return `Volume spike (z=${d.volumeZ})`;
    default: return e.type;
  }
}

/** Prompt block: the evidence timeline for causal reasoning. */
export function chainPromptBlock(chain) {
  if (!chain || !chain.length) return "";
  const lines = chain.map((l) => `- [${fmtTime(l.t)}] ${l.icon} ${l.text}`);
  return `
CAUSAL EVIDENCE CHAIN (chronological — what happened before the whale moved):
${lines.join("\n")}

Using this chain, identify the most plausible causal story in your interpretation:
which earlier link(s) most likely TRIGGERED this whale move, and what the whale's
move itself likely CAUSES next. State the chain explicitly (A → B → C). If no
earlier link plausibly connects, say so — do not invent causation.`;
}

/** Compact chain rendering for Telegram. */
export function formatChain(chain, maxLinks = 5) {
  if (!chain || !chain.length) return "";
  const shown = chain.slice(-maxLinks);
  return ["⛓ What led here:", ...shown.map((l) => `${l.icon} ${l.text}`)].join("\n");
}
