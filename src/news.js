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

/**
 * NOTE: CryptoPanic's free no-key endpoint now returns 410 Gone (Oct 2026).
 * If a NEWS_TOKEN (free CryptoPanic API key) is configured, this becomes the
 * speed layer — one call, hundreds of sources, near-real-time. Without a key
 * it no-ops and Tier-1 RSS carries the fast tick.
 */
async function fetchCryptoPanic(env) {
  if (!env.NEWS_TOKEN) return [];
  const url = `https://cryptopanic.com/api/v1/posts/?kind=news&filter=hot&auth_token=${env.NEWS_TOKEN}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": "WhaleSignal/1.0 (news aggregator)" },
    });
    if (!res.ok) throw new Error(`CryptoPanic HTTP ${res.status}`);
    const j = await res.json();
    const now = Date.now();
    return (j.results || []).map((p) => ({
      title: String(p.title || "").slice(0, 300),
      url: p.url || `https://cryptopanic.com/news/${p.id}/`,
      publishedAt: p.published_at ? Date.parse(p.published_at) : now,
      summary: "",
      source: "cryptopanic",
      weight: 0.7,
      panicVotes: { positive: p.votes?.positive || 0, negative: p.votes?.negative || 0 },
    })).filter((it) => it.title && it.url);
  } finally {
    clearTimeout(tid);
  }
}

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
  { name: "fed_press", rss: "https://www.federalreserve.gov/feeds/press_all.xml", weight: 0.8, macro: true },
  { name: "sec_press", rss: "https://www.sec.gov/news/pressreleases.rss", weight: 0.8, macro: true },
  { name: "cnbc_top", rss: "https://www.cnbc.com/id/100003114/device/rss/rss.html", weight: 0.6, macro: true },
  { name: "cnbc_earnings", rss: "https://www.cnbc.com/id/15839135/device/rss/rss.html", weight: 0.6, macro: true },
  { name: "marketwatch_top", rss: "https://www.marketwatch.com/rss/topstories", weight: 0.6, macro: true },
  { name: "forexlive", rss: "https://www.forexlive.com/feed/news/", weight: 0.6, macro: true },
  { name: "investing_news", rss: "https://www.investing.com/rss/news_25.rss", weight: 0.5, macro: true },
  { name: "bbc_news", rss: "http://feeds.bbci.co.uk/news/rss.xml", weight: 0.5, macro: true },
  { name: "bbc_business", rss: "http://feeds.bbci.co.uk/news/business/rss.xml", weight: 0.5, macro: true },
  { name: "bbc_world", rss: "http://feeds.bbci.co.uk/news/world/rss.xml", weight: 0.5, macro: true },
  { name: "aljazeera", rss: "https://www.aljazeera.com/xml/rss/all.xml", weight: 0.5, macro: true },
  { name: "thehill", rss: "https://thehill.com/feed/", weight: 0.5, macro: true },
  { name: "oilprice", rss: "https://oilprice.com/rss/main", weight: 0.5, macro: true },
  { name: "seekingalpha", rss: "https://seekingalpha.com/feed.xml", weight: 0.5, macro: true },
  { name: "npr_politics", rss: "https://feeds.npr.org/1014/rss.xml", weight: 0.4, macro: true },
  { name: "economist_china", rss: "https://www.economist.com/china/rss.xml", weight: 0.4, macro: true },
  { name: "asiatimes", rss: "https://asiatimes.com/feed/", weight: 0.4, macro: true },
  { name: "longwarjournal", rss: "https://www.longwarjournal.org/feed", weight: 0.3, macro: true },
  { name: "crisisgroup", rss: "https://www.crisisgroup.org/rss.xml", weight: 0.3, macro: true },
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

/**
 * Poll interval per source (minutes), from weight + type.
 * Fast, high-signal outlets earn the 2-min cadence; slow/rare publishers
 * (Fed, SEC) are polled hourly — polling them every 2 min is pure waste.
 */
export function sourceInterval(src) {
  if (src.macro && (src.name === "fed_press" || src.name === "sec_press")) return 60;
  if (src.macro) return 15;
  if ((src.weight || 0) >= 0.8) return 2;
  if ((src.weight || 0) >= 0.5) return 10;
  return 15;
}

/**
 * Fetch one source with conditional requests (ETag / If-Modified-Since).
 * A 304 means "unchanged" — no body, no parse, ~free.
 * Returns { items, notModified, etag, lastModified }.
 */
async function fetchSource(src, meta = {}) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 10000);
  try {
    const headers = { "user-agent": "WhaleSignal/1.0 (news aggregator)" };
    if (meta.etag) headers["if-none-match"] = meta.etag;
    if (meta.last_modified) headers["if-modified-since"] = meta.last_modified;
    const res = await fetch(src.rss, { signal: ctl.signal, headers });
    if (res.status === 304) {
      return { items: [], notModified: true, etag: meta.etag, lastModified: meta.last_modified };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Size guard: reject feeds > 2MB (prevents memory exhaustion from
    // compromised/hijacked feeds)
    const cl = res.headers.get("content-length");
    if (cl && parseInt(cl, 10) > 2 * 1024 * 1024) {
      throw new Error(`feed too large: ${cl} bytes`);
    }
    const xml = await res.text();
    if (xml.length > 2 * 1024 * 1024) {
      throw new Error(`feed too large: ${xml.length} chars`);
    }
    return {
      items: parseRss(xml).map((it) => ({ ...it, source: src.name, weight: src.weight })),
      notModified: false,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  } finally {
    clearTimeout(tid);
  }
}

/** Load per-source meta (one D1 query). */
async function loadSourceMeta(env) {
  try {
    const rows = await env.DB.prepare("SELECT * FROM source_meta").all();
    const m = new Map();
    for (const r of rows.results || []) m.set(r.name, r);
    return m;
  } catch {
    return new Map();
  }
}

/** Which sources are due? Respects interval + exponential failure backoff. */
export function dueSources(now, metaMap) {
  return SOURCES.filter((src) => {
    const m = metaMap.get(src.name);
    const interval = (m?.interval_min) || sourceInterval(src);
    const lastFetch = m?.last_fetch || 0;
    // backoff: failures push the next attempt out quadratically (cap 60 min)
    const failures = m?.failures || 0;
    const cooldownMin = Math.min(60, interval * Math.pow(2, Math.min(failures, 4)));
    return now - lastFetch >= cooldownMin * 60000;
  });
}

/** Persist per-source meta in one batch. */
async function saveSourceMeta(env, updates) {
  if (!updates.length) return;
  const stmts = updates.map((u) =>
    env.DB.prepare(
      `INSERT INTO source_meta (name, last_fetch, last_ok, etag, last_modified, failures, interval_min, items_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_fetch=excluded.last_fetch, last_ok=excluded.last_ok,
         etag=excluded.etag, last_modified=excluded.last_modified,
         failures=excluded.failures, interval_min=excluded.interval_min,
         items_seen=excluded.items_seen`
    ).bind(u.name, u.last_fetch, u.last_ok, u.etag, u.last_modified, u.failures, u.interval_min, u.items_seen)
  );
  for (let i = 0; i < stmts.length; i += 50) {
    try { await env.DB.batch(stmts.slice(i, i + 50)); }
    catch (e) { console.warn("[news] meta batch failed:", e.message); }
  }
}

/**
 * Run aggregation with adaptive polling:
 *  1. load source meta (1 D1 query)
 *  2. fetch only due sources, with ETags (304 = unchanged, ~free)
 *  3. batch-insert items, batch-save meta
 * Respects Cloudflare's 50-subrequest/invocation cap and sites' rate limits.
 */
export async function runAggregation(env, sources = null, extraItems = []) {
  const now = Date.now();
  const metaMap = await loadSourceMeta(env);
  const due = sources || dueSources(now, metaMap);

  const results = await Promise.allSettled(
    due.map((src) => fetchSource(src, metaMap.get(src.name) || {}))
  );
  const items = [...extraItems];
  const metaUpdates = [];
  for (let i = 0; i < due.length; i++) {
    const src = due[i];
    const r = results[i];
    const prev = metaMap.get(src.name) || {};
    if (r.status === "fulfilled") {
      const v = r.value;
      if (!v.notModified) items.push(...v.items);
      metaUpdates.push({
        name: src.name,
        last_fetch: now,
        last_ok: now,
        etag: v.etag || prev.etag || null,
        last_modified: v.lastModified || prev.last_modified || null,
        failures: 0,
        interval_min: sourceInterval(src),
        items_seen: v.notModified ? (prev.items_seen || 0) : v.items.length,
      });
    } else {
      const failures = (prev.failures || 0) + 1;
      console.warn(`[news] source failed: ${src.name}: ${r.reason?.message} (failures=${failures})`);
      metaUpdates.push({
        name: src.name,
        last_fetch: now,
        last_ok: prev.last_ok || null,
        etag: prev.etag || null,
        last_modified: prev.last_modified || null,
        failures,
        interval_min: sourceInterval(src),
        items_seen: prev.items_seen || 0,
      });
    }
  }
  await saveSourceMeta(env, metaUpdates);

  // One query for recent cluster_ids → in-memory dedupe check.
  // 2h window (not 24h): cross-outlet dupes appear within minutes.
  // Saves ~90% of D1 row reads on this hot query.
  let recentClusters = new Set();
  try {
    const rows = await env.DB.prepare(
      `SELECT cluster_id, source FROM news WHERE created_at > ?`
    ).bind(now - 7200000).all();
    for (const r of rows.results || []) {
      if (r.cluster_id) recentClusters.add(`${r.cluster_id}|${r.source}`);
    }
  } catch (e) {
    console.warn("[news] cluster prefetch failed:", e.message);
  }

  let inserted = 0, duplicates = 0;
  const stmts = [];
  const seenUrls = new Set();
  for (const it of items) {
    if (!it.url || seenUrls.has(it.url)) continue;
    seenUrls.add(it.url);
    const symbols = tagSymbols(`${it.title} ${it.summary}`);
    const topics = tagTopics(`${it.title} ${it.summary}`);
    const sentiment = scoreSentiment(`${it.title} ${it.summary}`);
    const cid = clusterId(it.title);
    let importance = scoreImportance({
      sourceWeight: it.weight, publishedAt: it.publishedAt, symbols, title: it.title, topics,
    });
    // Dedupe: same story from another outlet in the last 24h → keep, demote.
    let isDup = false;
    for (const key of recentClusters) {
      if (key.startsWith(cid + "|") && !key.endsWith(`|${it.source}`)) { isDup = true; break; }
    }
    if (isDup) { importance *= 0.25; duplicates++; }
    recentClusters.add(`${cid}|${it.source}`);
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO news (url, title, source, published_at, symbols, sentiment, importance, created_at, topics, cluster_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        it.url.slice(0, 500), it.title.slice(0, 300), it.source,
        it.publishedAt, paddedSymbols(symbols), +sentiment.toFixed(3), +importance.toFixed(3), now,
        paddedSymbols(topics), cid
      )
    );
  }
  // Batched inserts (chunks of 50 stay well under D1 batch limits).
  for (let i = 0; i < stmts.length; i += 50) {
    try {
      const res = await env.DB.batch(stmts.slice(i, i + 50));
      for (const r of res) inserted += r.meta?.changes || 0;
    } catch (e) {
      console.warn("[news] batch insert failed:", e.message);
    }
  }
  // prune: keep 7 days
  try {
    await env.DB.prepare("DELETE FROM news WHERE created_at < ?").bind(now - 7 * 86400000).run();
  } catch {}
  // KV cache: hottest 40 of the last 24h for the analyst fast path.
  // Throttled to every ~10 min (KV writes are budgeted at 1k/day on free).
  try {
    const lastCache = await env.KV.get("news_cache_meta");
    if (!lastCache || now - parseInt(lastCache, 10) > 600000) {
      const rows = await env.DB.prepare(
        `SELECT title, url, source, published_at, symbols, sentiment, importance
         FROM news WHERE created_at > ? ORDER BY importance DESC LIMIT 40`
      ).bind(now - 86400000).all();
      await env.KV.put("news_cache", JSON.stringify({
        headlines: rows.results.map((n) => ({ title: n.title, url: n.url })),
        full: rows.results,
        updated_at: now,
      }));
      await env.KV.put("news_cache_meta", String(now), { expirationTtl: 900 });
    }
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
    // Single 2-min cron; per-source intervals + ETags + backoff inside
    // runAggregation decide what actually gets fetched each tick.
    // Typical tick: ~5-8 fetches (not 47) — kind to CF limits and to sites.
    const cron = event.cron || "";
    if (cron.startsWith("*/2")) {
      ctx.waitUntil((async () => {
        let panicItems = [];
        try { panicItems = await fetchCryptoPanic(env); }
        catch (e) { console.warn("[news] cryptopanic failed:", e.message); }
        await runAggregation(env, null, panicItems);
      })());
    } else {
      // legacy/manual crons: run the due-source pass without the speed layer
      ctx.waitUntil(runAggregation(env));
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (!isAuthorizedAdmin(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      const tier = url.searchParams.get("tier");
      let sources = null, extra = []; // null = adaptive due-source pass
      if (tier === "macro") {
        sources = SOURCES.filter((s) => s.macro);
      } else if (tier === "fast") {
        sources = SOURCES.filter((s) => !s.macro && (s.weight || 0) >= 0.8);
        try { extra = await fetchCryptoPanic(env); } catch (e) { console.warn("[news] cryptopanic failed:", e.message); }
      } else if (tier === "crypto") {
        sources = SOURCES.filter((s) => !s.macro);
      } else if (tier === "all") {
        sources = SOURCES;
      }
      const r = await runAggregation(env, sources, extra);
      return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, worker: "whalesignal-news", status: "healthy" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
