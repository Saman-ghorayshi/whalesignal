// src/news_graph.js — connect individual headlines into a graph of themes
// and narratives. One headline is noise; several independent outlets pushing
// the same theme in the same direction inside a short window is a narrative —
// and narratives, not headlines, are what move sentiment and (with on-chain
// confirmation) markets.
//
// Pipeline: scanner inserts rows (lexicon sentiment) → LLM scores them
// (sentiment, event, theme, magnitude) → buildNewsGraph() clusters the last
// 72h by theme and detects narratives in the last 24h → the graph feeds the
// LLM analysis prompt, the landing page's Market Pulse, and /news.
// Pure module — unit-tested in tests/news_graph.test.js.

export const THEMES = [
  "etf", "regulation", "hack", "adoption", "macro",
  "exchange", "whales", "stablecoin", "market", "other",
];

const HUMAN_LABEL = {
  etf: "ETF flows",
  regulation: "Regulation",
  hack: "Security & hacks",
  adoption: "Adoption",
  macro: "Macro",
  exchange: "Exchange operations",
  whales: "Whale activity",
  stablecoin: "Stablecoins",
  market: "Market direction",
  other: "Other",
};

const LEXICON_THEMES = [
  ["etf", /\betf\b/i],
  ["regulation", /\b(sec|cftc|regulat|lawsuit|sue[sd]?|ban|compliance|license)\b/i],
  ["hack", /\b(hack|exploit|breach|stolen|drain|phishing|ransomware)\b/i],
  ["macro", /\b(fed|fomc|inflation|cpi|rate cut|rate hike|dollar|treasury yields|recession)\b/i],
  ["exchange", /\b(binance|coinbase|kraken|okx|bybit|bitfinex|exchange (?:wallet|reserve|outage|listing))\b/i],
  ["whales", /\b(whale|dormant|mega-transfer|accumulat|distribution)\b/i],
  ["stablecoin", /\b(usdt|usdc|tether|stablecoin|depeg)\b/i],
  ["adoption", /\b(adopt|partnership|launch(?:es|ed)?|integrat|payment|sovereign|nation-state)\b/i],
  ["market", /\b(bitcoin|btc|ethereum|eth|rally|selloff|dump|surge|plunge|volatile)\b/i],
];

/** Theme for one news row: LLM's call, then the event, then lexicon fallback
 *  so UNSCORED headlines still cluster. Null only when nothing matches. */
export function themeFor(row) {
  const t = String(row?.llm_theme || "").toLowerCase();
  if (THEMES.includes(t)) return t;
  const e = String(row?.llm_event || "").toLowerCase();
  if (THEMES.includes(e)) return e;
  const title = String(row?.title || "");
  for (const [theme, re] of LEXICON_THEMES) {
    if (re.test(title)) return theme;
  }
  return null;
}

/** Sentiment for one row: LLM's when scored, else the lexicon's. */
export function sentimentFor(row) {
  const s = row?.llm_sentiment ?? row?.sentiment;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

/** Magnitude 1-3: LLM's when present, else 1. Weights a headline's pull on
 *  its theme's net score — "SEC approves" counts more than "SEC mulls". */
export function magnitudeFor(row) {
  const m = Number(row?.llm_magnitude);
  return Number.isFinite(m) && m >= 1 && m <= 3 ? Math.round(m) : 1;
}

/**
 * Cluster the last `windowMs` of news rows by theme, then detect narratives:
 * ≥ MIN_COUNT headlines and |net sentiment (magnitude-weighted)| ≥ MIN_NET
 * within the last 24h. Pure.
 *
 * @param {Array<{title, first_seen, llm_sentiment?, llm_event?, llm_theme?, llm_magnitude?, sentiment?}>} rows
 * @param {number} now epoch ms
 * @returns {{ themes, narratives, generated_at }}
 *   themes: 72h rollup — { theme, label, count, net, pos, neg, latest }
 *   narratives: 24h clusters that crossed the bar — { theme, label, direction, net, count, strength, latest }
 */
export function buildNewsGraph(rows, now = Date.now(), {
  windowMs = 72 * 3600_000, narrativeWindowMs = 24 * 3600_000,
  minCount = 3, minNet = 2,
} = {}) {
  const cutoff = now - windowMs;
  const nCutoff = now - narrativeWindowMs;
  const byTheme = new Map();
  for (const row of rows || []) {
    const when = Number(row?.first_seen);
    if (!Number.isFinite(when) || when < cutoff || when > now) continue;
    const theme = themeFor(row);
    if (!theme) continue;
    const sent = sentimentFor(row);
    const mag = magnitudeFor(row);
    const bucket = byTheme.get(theme) || { count: 0, net: 0, pos: 0, neg: 0, net24: 0, count24: 0, latest: 0, latestTitle: "" };
    bucket.count++;
    bucket.net += sent * mag;
    if (sent > 0) bucket.pos++;
    else if (sent < 0) bucket.neg++;
    if (when >= nCutoff) {
      bucket.count24++;
      bucket.net24 += sent * mag;
    }
    if (when > bucket.latest) { bucket.latest = when; bucket.latestTitle = String(row.title || ""); }
    byTheme.set(theme, bucket);
  }
  const themes = [...byTheme.entries()].map(([theme, b]) => ({
    theme, label: HUMAN_LABEL[theme] || theme,
    count: b.count, net: b.net, pos: b.pos, neg: b.neg, latest: b.latest,
  })).sort((a, b2) => b2.net - a.net || b2.count - a.count);
  const narratives = themes
    .filter((t) => {
      const b = byTheme.get(t.theme);
      return b.count24 >= minCount && Math.abs(b.net24) >= minNet;
    })
    .map((t) => {
      const b = byTheme.get(t.theme);
      const direction = b.net24 > 0 ? "bullish" : "bearish";
      return {
        theme: t.theme, label: t.label, direction,
        net: b.net24, count: b.count24,
        strength: Math.min(3, b.count24 - 1),
        latest: t.latest, latestTitle: t.latestTitle,
      };
    })
    .sort((a, b2) => Math.abs(b2.net) * b2.count - Math.abs(a.net) * a.count);
  return { themes, narratives, generated_at: now };
}

/** Compact prompt block for the analyst's LLM: what the clusters SAY, so a
 *  single headline is read in the context of its narrative. */
export function narrativesForPrompt(graph) {
  const lines = (graph?.narratives || []).slice(0, 3).map((n) =>
    `- ${n.label}: ${n.count} ${n.direction} headlines in 24h (net ${n.net > 0 ? "+" : ""}${n.net}). Most recent: "${n.latestTitle}"`);
  if (!lines.length) return "- No news narrative cluster active (single headlines only — treat them as noise unless on-chain data confirms).";
  return lines.join("\n");
}

/** Strength 1-3 → confidence bump for the confluence model's news weight.
 *  A narrative corroborated by independent outlets is worth more than one
 *  headline repeated by aggregators. Bounded: never exceeds ±0.06. */
export function narrativeBump(graph) {
  const top = (graph?.narratives || [])[0];
  if (!top) return 0;
  const bump = [0, 0.02, 0.04, 0.06][top.strength];
  return top.direction === "bullish" ? bump : -bump;
}
