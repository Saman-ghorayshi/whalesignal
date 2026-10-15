/**
 * news.js — Crypto news aggregation worker.
 *
 * Every 5 minutes it pulls RSS feeds from major crypto publications, tags
 * each headline with symbols, scores sentiment with a transparent lexicon,
 * ranks by importance, and stores everything in D1. The analyst queries D1
 * for symbol-matched catalysts near a whale's detection time; a KV cache
 * keeps the hottest headlines available with zero D1 reads.
 *
 * No API keys needed — RSS is free. Add/remove sources in SOURCES.
 */

import { isAuthorizedAdmin } from "./worker-utils.js";

const SOURCES = [
  // Tier 1 — highest signal, every run
  { name: "coindesk", rss: "https://www.coindesk.com/arc/outboundfeeds/rss/", weight: 1.0 },
  { name: "cointelegraph", rss: "https://cointelegraph.com/rss", weight: 0.9 },
  { name: "theblock", rss: "https://www.theblock.co/rss.xml", weight: 0.9 },
  { name: "decrypt", rss: "https://decrypt.co/feed", weight: 0.8 },
  { name: "cryptoslate", rss: "https://cryptoslate.com/feed/", weight: 0.7 },
  { name: "bitcoinmagazine", rss: "https://bitcoinmagazine.com/feed", weight: 0.7 },
  { name: "beincrypto", rss: "https://beincrypto.com/feed/", weight: 0.6 },
  // Tier 2 — broad coverage, same cadence (cheap RSS pulls)
  { name: "blockworks", rss: "https://blockworks.co/feed", weight: 0.6 },
  { name: "dlnews", rss: "https://www.dlnews.com/feed", weight: 0.6 },
  { name: "ambcrypto", rss: "https://ambcrypto.com/feed/", weight: 0.5 },
  { name: "newsbtc", rss: "https://www.newsbtc.com/feed/", weight: 0.5 },
  { name: "cryptopotato", rss: "https://cryptopotato.com/feed/", weight: 0.5 },
  { name: "utoday", rss: "https://u.today/rss", weight: 0.5 },
  { name: "coingape", rss: "https://coingape.com/feed/", weight: 0.5 },
  { name: "bitcoinist", rss: "https://bitcoinist.com/feed/", weight: 0.5 },
  { name: "dailyhodl", rss: "https://dailyhodl.com/feed/", weight: 0.5 },
  { name: "coinjournal", rss: "https://coinjournal.net/feed/", weight: 0.5 },
  // Tier 3 — long tail. Lower weight; failures are just warnings.
  { name: "thedefiant", rss: "https://thedefiant.io/feed", weight: 0.5 },
  { name: "cryptobriefing", rss: "https://cryptobriefing.com/feed/", weight: 0.5 },
  { name: "bitcoincom", rss: "https://news.bitcoin.com/feed/", weight: 0.5 },
  { name: "forkast", rss: "https://forkast.news/feed/", weight: 0.5 },
  { name: "cryptonews", rss: "https://cryptonews.com/feed/", weight: 0.4 },
  { name: "blockonomi", rss: "https://blockonomi.com/feed/", weight: 0.4 },
  { name: "coinbureau", rss: "https://www.coinbureau.com/feed/", weight: 0.4 },
  { name: "coincodex", rss: "https://coincodex.com/feed/", weight: 0.4 },
  // Tier 4 — social/aggregators (noisy; low weight, still useful for velocity)
  { name: "reddit_bitcoin", rss: "https://www.reddit.com/r/Bitcoin/.rss", weight: 0.3 },
  { name: "reddit_ethereum", rss: "https://www.reddit.com/r/ethereum/.rss", weight: 0.3 },
  { name: "reddit_crypto", rss: "https://www.reddit.com/r/CryptoCurrency/.rss", weight: 0.3 },
  // Tier 5 — macro/world. Verified working Oct 2026. These explain WHY whales
  // move: FOMC, CPI, wars, SEC actions, earnings. Rare items get higher weight
  // because when they fire, they move everything.
  { name: "fed_press", rss: "https://www.federalreserve.gov/feeds/press_all.xml", weight: 0.8 },
  { name: "sec_press", rss: "https://www.sec.gov/news/pressreleases.rss", weight: 0.8 },
  { name: "cnbc_top", rss: "https://www.cnbc.com/id/100003114/device/rss/rss.html", weight: 0.6 },
  { name: "cnbc_earnings", rss: "https://www.cnbc.com/id/15839135/device/rss/rss.html", weight: 0.6 },
  { name: "marketwatch_top", rss: "https://www.marketwatch.com/rss/topstories", weight: 0.6 },
  { name: "forexlive", rss: "https://www.forexlive.com/feed/news/", weight: 0.6 },
  { name: "investing_news", rss: "https://www.investing.com/rss/news_25.rss", weight: 0.5 },
  { name: "bbc_news", rss: "http://feeds.bbci.co.uk/news/rss.xml", weight: 0.5 },
  { name: "bbc_business", rss: "http://feeds.bbci.co.uk/news/business/rss.xml", weight: 0.5 },
  { name: "bbc_world", rss: "http://feeds.bbci.co.uk/news/world/rss.xml", weight: 0.5 },
  { name: "aljazeera", rss: "https://www.aljazeera.com/xml/rss/all.xml", weight: 0.5 },
  { name: "thehill", rss: "https://thehill.com/feed/", weight: 0.5 },
  { name: "oilprice", rss: "https://oilprice.com/rss/main", weight: 0.5 },
  { name: "seekingalpha", rss: "https://seekingalpha.com/feed.xml", weight: 0.5 },
  { name: "npr_politics", rss: "https://feeds.npr.org/1014/rss.xml", weight: 0.4 },
  { name: "economist_china", rss: "https://www.economist.com/china/rss.xml", weight: 0.4 },
  { name: "asiatimes", rss: "https://asiatimes.com/feed/", weight: 0.4 },
  { name: "longwarjournal", rss: "https://www.longwarjournal.org/feed", weight: 0.3 },
  { name: "crisisgroup", rss: "https://www.crisisgroup.org/rss.xml", weight: 0.3 },
];

// topic → keywords. A headline can carry multiple topics.
const TOPIC_KEYWORDS = [
  ["etf", ["etf", "exchange-traded"]],
  ["regulation", ["sec", "regulat", "lawsuit", "court", "ban", "congress", "cftc", "bill"]],
  ["security", ["hack", "exploit", "phishing", "scam", "rug pull"]],
  ["adoption", ["adoption", "partnership", "integration"]],
  ["mining", ["mining", "miner", "hashrate", "halving"]],
  ["defi", ["defi", "dex", "yield", "staking", "tvl"]],
  ["macro", ["fed", "fomc", "inflation", "cpi", "interest rate", "rate cut", "rate hike", "recession", "central bank", "powell", "jobs report", "gdp"]],
  ["exchange", ["binance", "coinbase", "kraken", "bybit", "exchange"]],
  // world/macro coverage — the "what news we did not follow" layer
  ["geopolitics", ["war", "missile", "airstrike", "sanction", "ceasefire", "invasion", "military", "nato", "taiwan", "ukraine", "gaza", "iran", "kremlin"]],
  ["us", ["white house", "trump", "biden", "congress", "senate", "treasury", "washington"]],
  ["china", ["china", "chinese", "beijing", "pboc", "yuan", "xi jinping"]],
  ["business", ["ceo", "earnings", "merger", "acquisition", "ipo", "bankruptcy", "billionaire", "dies", "passed away", "resigns", "fired"]],
  ["energy", ["oil", "opec", "crude", "gas prices", "energy"]],
  ["markets", ["s&p", "nasdaq", "dow jones", "stock market", "wall street", "gold", "treasury yield"]],
];

export function tagTopics(text) {
  const lower = ` ${String(text || "").toLowerCase()} `;
  const found = [];
  for (const [topic, kws] of TOPIC_KEYWORDS) {
    if (kws.some((kw) => lower.includes(kw))) found.push(topic);
  }
  return found;
}

/** Normalized-title hash for cross-outlet dedupe clustering. Pure. */
export function clusterId(title) {
  const norm = String(title || "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "from"].includes(w))
    .sort()
    .join(" ");
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = (Math.imul(31, h) + norm.charCodeAt(i)) | 0;
  }
  return `c${(h >>> 0).toString(36)}`;
}

// keyword → symbol. Order matters: check multi-word / specific first.
const SYMBOL_KEYWORDS = [
  ["bitcoin", "BTC"], ["\\bbtc\\b", "BTC"], ["satoshi", "BTC"],
  ["ethereum", "ETH"], ["\\beth\\b", "ETH"], ["\\bether\\b", "ETH"], ["vitalik", "ETH"],
  ["solana", "SOL"], ["\\bsol\\b", "SOL"],
  ["tether", "USDT"], ["\\busdt\\b", "USDT"],
  ["usd coin", "USDC"], ["\\busdc\\b", "USDC"],
  ["\\bxrp\\b", "XRP"], ["ripple", "XRP"],
  ["dogecoin", "DOGE"], ["\\bdoge\\b", "DOGE"],
  ["cardano", "ADA"], ["\\bada\\b", "ADA"],
  ["\\bbnb\\b", "BNB"], ["binance coin", "BNB"],
];

const BULL_WORDS = [
  "rally", "rallies", "surged", "surge", "surges", "soar", "breakout", "bullish",
  "approval", "approved", "inflows", "record high", "all-time high", "ath",
  "adoption", "partnership", "accumulat", "etf", "institutional", "reserve",
  "upgrade", "gains", "rebound", "recovery", "optimism", "milestone",
];
const BEAR_WORDS = [
  "crash", "crashed", "plunge", "dump", "dumps", "bearish", "hack", "hacked",
  "exploit", "lawsuit", "sued", "ban", "banned", "outflows", "liquidat",
  "fear", "warning", "fraud", "scam", "collapse", "tumble", "slide", "probe",
  "fine", "settlement", "bankrupt",
];
const BREAKING_WORDS = ["etf", "hack", "lawsuit", "ban", "approval", "halving", "sec", "exploit", "arrest"];

// ─── parsing ────────────────────────────────────────────────────────

function stripCdata(s) {
  return (s || "").replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1");
}
function stripTags(s) {
  return (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function pickTag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i"));
    if (m) return stripCdata(m[1]).trim();
  }
  return "";
}

/**
 * Minimal RSS2 + Atom parser. Returns [{title, url, publishedAt(ms|null), summary}].
 * Pure — fully testable without network.
 */
export function parseRss(xml) {
  const items = [];
  if (!xml || typeof xml !== "string") return items;
  // RSS2 items
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const it of rssItems) {
    const title = stripTags(pickTag(it, ["title"]));
    const url = pickTag(it, ["link", "guid"]);
    const pub = pickTag(it, ["pubDate", "dc:date"]);
    const summary = stripTags(pickTag(it, ["description"])).slice(0, 500);
    if (title && url) items.push({ title, url, publishedAt: parseDate(pub), summary });
  }
  // Atom entries (only if no RSS items found — avoid double counting)
  if (!items.length) {
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const en of entries) {
      const title = stripTags(pickTag(en, ["title"]));
      let url = "";
      const linkM = en.match(/<link[^>]*href="([^"]+)"/i);
      if (linkM) url = linkM[1];
      else url = pickTag(en, ["link", "id"]);
      const pub = pickTag(en, ["published", "updated"]);
      const summary = stripTags(pickTag(en, ["summary", "content"])).slice(0, 500);
      if (title && url) items.push({ title, url, publishedAt: parseDate(pub), summary });
    }
  }
  return items;
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ─── tagging / sentiment / importance ───────────────────────────────

export function tagSymbols(text) {
  const lower = ` ${String(text || "").toLowerCase()} `;
  const found = new Set();
  for (const [kw, sym] of SYMBOL_KEYWORDS) {
    if (new RegExp(kw, "i").test(lower)) found.add(sym);
  }
  return [...found];
}

export function scoreSentiment(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return 0;
  let score = 0;
  for (const w of BULL_WORDS) if (lower.includes(w)) score += 1;
  for (const w of BEAR_WORDS) if (lower.includes(w)) score -= 1;
  // normalize by text length so long articles don't dominate
  const norm = Math.min(1, lower.length / 300);
  return Math.max(-1, Math.min(1, (score / 3) * (0.5 + 0.5 * norm)));
}

export function scoreImportance({ sourceWeight, publishedAt, symbols, title, topics }) {
  let imp = sourceWeight;
  if (publishedAt) {
    const ageH = (Date.now() - publishedAt) / 3600000;
    imp *= Math.exp(-ageH / 12); // 12h half-life-ish decay
  } else {
    imp *= 0.7; // undated = less trustworthy
  }
  if (symbols && symbols.length) imp *= 1.2;
  // Macro/geopolitical shocks move crypto even without a symbol tag —
  // a Fed decision or a war headline deserves crypto relevance.
  const macroTopics = ["macro", "geopolitics", "us", "china", "markets", "energy"];
  if (topics && topics.some((t) => macroTopics.includes(t))) imp *= 1.35;
  const lower = String(title || "").toLowerCase();
  if (BREAKING_WORDS.some((w) => lower.includes(w))) imp *= 1.4;
  return Math.min(1, imp);
}

function paddedSymbols(symbols) {
  return `,${(symbols || []).join(",")},`;
}

// ─── aggregation ────────────────────────────────────────────────────

async function fetchSource(src) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(src.rss, {
      signal: ctl.signal,
      headers: { "user-agent": "WhaleSignal/1.0 (news aggregator)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRss(xml).map((it) => ({ ...it, source: src.name, weight: src.weight }));
  } finally {
    clearTimeout(tid);
  }
}

export async function runAggregation(env) {
  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  const items = [];
  for (const r of results) {
    if (r.status === "fulfilled") items.push(...r.value);
    else console.warn("[news] source failed:", r.reason?.message);
  }
  const now = Date.now();
  let inserted = 0, duplicates = 0;
  for (const it of items) {
    const symbols = tagSymbols(`${it.title} ${it.summary}`);
    const topics = tagTopics(`${it.title} ${it.summary}`);
    const sentiment = scoreSentiment(`${it.title} ${it.summary}`);
    const cid = clusterId(it.title);
    let importance = scoreImportance({
      sourceWeight: it.weight, publishedAt: it.publishedAt, symbols, title: it.title, topics,
    });
    // Dedupe: same story from another outlet in the last 24h → keep, but demote.
    try {
      const dup = await env.DB.prepare(
        `SELECT id FROM news WHERE cluster_id = ? AND created_at > ? AND source != ? LIMIT 1`
      ).bind(cid, now - 86400000, it.source).first();
      if (dup) {
        importance *= 0.25;
        duplicates++;
      }
    } catch {}
    try {
      const r = await env.DB.prepare(
        `INSERT OR IGNORE INTO news (url, title, source, published_at, symbols, sentiment, importance, created_at, topics, cluster_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        it.url.slice(0, 500), it.title.slice(0, 300), it.source,
        it.publishedAt, paddedSymbols(symbols), +sentiment.toFixed(3), +importance.toFixed(3), now,
        paddedSymbols(topics), cid
      ).run();
      if (r.meta.changes > 0) inserted++;
    } catch (e) {
      console.warn("[news] insert failed:", e.message);
    }
  }
  // prune: keep 7 days
  try {
    await env.DB.prepare("DELETE FROM news WHERE created_at < ?").bind(now - 7 * 86400000).run();
  } catch {}
  // KV cache: hottest 40 of the last 24h for the analyst fast path
  try {
    const rows = await env.DB.prepare(
      `SELECT title, url, source, published_at, symbols, sentiment, importance
       FROM news WHERE created_at > ? ORDER BY importance DESC LIMIT 40`
    ).bind(now - 86400000).all();
    await env.KV.put("news_cache", JSON.stringify({
      headlines: rows.results.map((n) => ({ title: n.title, url: n.url })),
      full: rows.results,
      updated_at: now,
    }));
  } catch (e) {
    console.warn("[news] KV cache update failed:", e.message);
  }
  console.log(`[news] aggregated ${items.length} items, ${inserted} new, ${duplicates} cross-outlet dupes`);
  return { fetched: items.length, inserted, duplicates };
}

/** Symbol-matched headlines near a timestamp, for the analyst. */
export async function getRelevantNews(env, { symbol, detectedAt, windowMs = 12 * 3600 * 1000, limit = 8 } = {}) {
  const sym = (symbol || "").toUpperCase();
  try {
    const rows = await env.DB.prepare(
      `SELECT title, url, source, published_at, symbols, sentiment, importance
       FROM news
       WHERE published_at IS NOT NULL
         AND published_at BETWEEN ? AND ?
         AND symbols LIKE ?
       ORDER BY importance DESC LIMIT ?`
    ).bind(detectedAt - windowMs, detectedAt + windowMs, `%,${sym},%`, limit).all();
    if (rows.results.length) return rows.results;
    // fallback: most important recent, regardless of symbol match
    const fb = await env.DB.prepare(
      `SELECT title, url, source, published_at, symbols, sentiment, importance
       FROM news WHERE created_at > ? ORDER BY importance DESC LIMIT ?`
    ).bind(Date.now() - 86400000, limit).all();
    return fb.results;
  } catch (e) {
    console.warn("[news] getRelevantNews failed:", e.message);
    return [];
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAggregation(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (!isAuthorizedAdmin(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      const r = await runAggregation(env);
      return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, worker: "whalesignal-news", status: "healthy" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
