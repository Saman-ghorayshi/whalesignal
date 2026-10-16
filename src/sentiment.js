/**
 * sentiment.js — Market sentiment aggregation worker.
 *
 * Every 15 minutes it fuses three sentiment signals into one composite:
 *   1. Fear & Greed index (alternative.me, free)
 *   2. Perpetual funding rates (Bybit public API → Hyperliquid fallback)
 *      Positive funding = longs paying shorts = greed; negative = fear.
 *   3. News sentiment (24h importance-weighted average from D1 news)
 *
 * Writes D1 sentiment_snapshots (history) + KV sentiment_cache (analyst fast
 * path). No API keys needed.
 */

import { isAuthorizedAdmin , isD1SafeMode, noteD1Lock, isD1LockedError } from "./worker-utils.js";

async function fetchFearGreed() {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", { signal: ctl.signal });
    if (!res.ok) throw new Error(`F&G HTTP ${res.status}`);
    const j = await res.json();
    const d = j.data && j.data[0];
    if (!d) throw new Error("F&G: empty");
    return { value: parseInt(d.value, 10), label: d.value_classification };
  } finally {
    clearTimeout(tid);
  }
}

async function fetchFundingBybit(symbol) {
  const map = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };
  const s = map[symbol];
  if (!s) throw new Error(`Bybit: no symbol ${symbol}`);
  const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${s}&limit=1`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
    const j = await res.json();
    const row = j.result && j.result.list && j.result.list[0];
    if (!row) throw new Error("Bybit: empty funding");
    return parseFloat(row.fundingRate); // e.g. 0.0001 = 0.01%
  } finally {
    clearTimeout(tid);
  }
}

async function fetchFundingHyperliquid(symbol) {
  // POST {"type":"fundingHistory","coin":"BTC","startTime":...} — simpler:
  // metaAndAssetCtxs returns current funding per asset.
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
    const [meta, ctxs] = await res.json();
    const idx = (meta.universe || []).findIndex((a) => a.name === symbol);
    if (idx < 0 || !ctxs[idx]) throw new Error("Hyperliquid: asset not found");
    return parseFloat(ctxs[idx].funding);
  } finally {
    clearTimeout(tid);
  }
}

async function fetchFunding(symbol) {
  try {
    return await fetchFundingBybit(symbol);
  } catch (e) {
    console.warn(`[sentiment] Bybit funding failed for ${symbol}, trying Hyperliquid:`, e.message);
    return await fetchFundingHyperliquid(symbol);
  }
}

async function newsSentiment24h(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT
         SUM(sentiment * importance) / NULLIF(SUM(importance), 0) AS wavg,
         COUNT(*) AS n
       FROM news WHERE created_at > ?`
    ).bind(Date.now() - 86400000).first();
    if (!row || !row.n) return { value: 0, n: 0 };
    return { value: row.wav || 0, n: row.n };
  } catch (e) {
    console.warn("[sentiment] news aggregate failed:", e.message);
    return { value: 0, n: 0 };
  }
}

/**
 * Deribit BTC options put/call open-interest ratio (free public API).
 * High P/C = hedging/fear; low = complacency/greed.
 */
async function fetchDeribitPutCall() {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(
      "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option",
      { signal: ctl.signal }
    );
    if (!res.ok) throw new Error(`Deribit HTTP ${res.status}`);
    const j = await res.json();
    const books = j.result || [];
    let putOI = 0, callOI = 0;
    for (const b of books) {
      const oi = b.open_interest || 0;
      // instrument_name like BTC-27DEC24-100000-P (P=put, C=call)
      const kind = (b.instrument_name || "").split("-").pop();
      if (kind === "P") putOI += oi;
      else if (kind === "C") callOI += oi;
    }
    if (callOI <= 0) throw new Error("Deribit: no call OI");
    return { ratio: putOI / callOI, putOI, callOI };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * US spot BTC ETF daily net flow (Farside Investors, free HTML page).
 * Best-effort scrape: returns $M net flow for the latest day, or null.
 */
async function fetchEtfFlow() {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch("https://farside.co.uk/btc/", {
      signal: ctl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; WhaleSignal/1.0)" },
    });
    if (!res.ok) throw new Error(`Farside HTTP ${res.status}`);
    const html = await res.text();
    // The page has a "Total" row with the latest net flow like "$ 1,234.5"
    // or "(123.4)" for negative. We grab the last $-figure in the totals area.
    const totalsIdx = html.toLowerCase().lastIndexOf("total");
    const tail = totalsIdx > 0 ? html.slice(totalsIdx, totalsIdx + 2000) : html;
    const m = tail.match(/\(?\$?\s?([\d,]+\.\d)\)?/);
    if (!m) throw new Error("Farside: no flow figure");
    const val = parseFloat(m[1].replace(/,/g, ""));
    const negative = m[0].includes("(");
    return { net_usd_m: negative ? -val : val };
  } finally {
    clearTimeout(tid);
  }
}

export function compositeLabel(v) {
  if (v <= -0.6) return "extreme_fear";
  if (v <= -0.2) return "fear";
  if (v < 0.2) return "neutral";
  if (v < 0.6) return "greed";
  return "extreme_greed";
}

export async function runSentimentTick(env) {
  const now = Date.now();
  const [fg, fundingBTC, fundingETH, news, deribit, etf] = await Promise.all([
    fetchFearGreed().catch((e) => (console.warn("[sentiment] F&G failed:", e.message), null)),
    fetchFunding("BTC").catch((e) => (console.warn("[sentiment] BTC funding failed:", e.message), null)),
    fetchFunding("ETH").catch((e) => (console.warn("[sentiment] ETH funding failed:", e.message), null)),
    newsSentiment24h(env),
    fetchDeribitPutCall().catch((e) => (console.warn("[sentiment] Deribit failed:", e.message), null)),
    fetchEtfFlow().catch((e) => (console.warn("[sentiment] ETF flow failed:", e.message), null)),
  ]);

  // normalize each to -1..1
  const fgN = fg ? (fg.value - 50) / 50 : 0;
  const fundN = (r) => (r == null ? 0 : Math.max(-1, Math.min(1, r / 0.0005)));
  const fundAvg = [fundingBTC, fundingETH].filter((x) => x != null);
  const fundAvgN = fundAvg.length ? fundAvg.reduce((a, r) => a + fundN(r), 0) / fundAvg.length : 0;
  const newsN = Math.max(-1, Math.min(1, news.value || 0));
  // put/call: ~0.7 neutral; >1 fear, <0.5 greed → map to -1..1 (inverted)
  const pcN = deribit ? Math.max(-1, Math.min(1, (0.7 - deribit.ratio) / 0.5)) : 0;
  // ETF flow: +$500M/day = strong greed; -$500M = strong fear
  const etfN = etf ? Math.max(-1, Math.min(1, etf.net_usd_m / 500)) : 0;

  const composite = +(0.3 * fgN + 0.25 * fundAvgN + 0.2 * newsN + 0.15 * pcN + 0.1 * etfN).toFixed(3);
  const snap = {
    t: now,
    fear_greed: fg?.value ?? null,
    fear_greed_label: fg?.label ?? null,
    funding_btc: fundingBTC,
    funding_eth: fundingETH,
    news_sentiment: +newsN.toFixed(3),
    news_count: news.n,
    put_call_ratio: deribit ? +deribit.ratio.toFixed(3) : null,
    etf_net_usd_m: etf ? +etf.net_usd_m.toFixed(1) : null,
    composite,
    label: compositeLabel(composite),
  };

  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO sentiment_snapshots
         (t, fear_greed, fear_greed_label, funding_btc, funding_eth, news_sentiment, composite, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(now, snap.fear_greed, snap.fear_greed_label, snap.funding_btc, snap.funding_eth, snap.news_sentiment, snap.composite, snap.label).run();
    await env.DB.prepare("DELETE FROM sentiment_snapshots WHERE t < ?").bind(now - 7 * 86400000).run();
  } catch (e) {
    console.warn("[sentiment] D1 write failed:", e.message);
  }
  try {
    await env.KV.put("sentiment_cache", JSON.stringify(snap), { expirationTtl: 1800 });
  } catch (e) {
    console.warn("[sentiment] KV write failed:", e.message);
  }
  console.log(`[sentiment] tick: F&G ${snap.fear_greed} | fund BTC ${snap.funding_btc} | P/C ${snap.put_call_ratio} | ETF $${snap.etf_net_usd_m}M | news ${snap.news_sentiment} (${snap.news_count}) → ${snap.label} (${snap.composite})`);
  return snap;
}

export default {
  async scheduled(event, env, ctx) {
    // D1 safe mode: skip D1-heavy work when quota is hit.
    if (await isD1SafeMode(env)) {
      console.warn("[sentiment] D1 safe mode — skipping tick");
      return { skipped: "d1_safe_mode" };
    }
    ctx.waitUntil(runSentimentTick(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (!isAuthorizedAdmin(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      const r = await runSentimentTick(env);
      return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, worker: "whalesignal-sentiment", status: "healthy" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
