/**
 * price.js — Dedicated market-data worker.
 *
 * Every 2 minutes it ingests 1h OHLCV for the tracked symbols, stores candles
 * in D1 (7-day rolling window), precomputes the full TA snapshot into KV
 * (`ta_cache:BTC` etc.), and detects market events (pumps/dumps, RSI
 * extremes, Bollinger breaks, volume spikes) into `market_events`.
 *
 * The analyst reads the KV caches — zero per-whale price fetching, zero
 * added latency on the alert path. If this worker ever stalls, the analyst
 * falls back to live fetching (ta.js).
 *
 * Price sources (no keys): Coinbase Exchange → Kraken → CoinGecko.
 */

import { isAuthorizedAdmin } from "./worker-utils.js";
import { fetchKlines, rsi, macd, bollinger, sma, volumeZ, swingLevels, summarizeTA } from "./ta.js";

const SYMBOLS = ["BTC", "ETH", "SOL"];
const CANDLE_KEEP_MS = 7 * 86400000;

// event thresholds
const PUMP_DUMP_PCT = 3;      // |1h change| %
const RSI_LOW = 25, RSI_HIGH = 75;
const VOL_Z = 3;
const EVENT_DEDUPE_MS = 4 * 3600000;

function buildSnapshot(symbol, klines) {
  const closes = klines.map((k) => k.c);
  const volumes = klines.map((k) => k.v);
  const price = closes[closes.length - 1];
  const prevDay = closes.length > 24 ? closes[closes.length - 25] : closes[0];
  const change24h = ((price - prevDay) / prevDay) * 100;
  const prev1h = closes.length > 1 ? closes[closes.length - 2] : price;
  const change1h = ((price - prev1h) / prev1h) * 100;

  const rsi14 = rsi(closes);
  const m = macd(closes);
  const bb = bollinger(closes);
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const vZ = volumeZ(volumes);
  const { support, resistance } = swingLevels(klines);
  const v24 = klines.slice(-24).reduce((a, k) => a + (k.v || 0), 0);

  const trend = s20 != null && s50 != null
    ? (s20 > s50 * 1.005 ? "uptrend" : s20 < s50 * 0.995 ? "downtrend" : "sideways")
    : "unknown";
  return {
    symbol, price, change24h: +change24h.toFixed(2), change1h: +change1h.toFixed(2),
    rsi14: rsi14 == null ? null : +rsi14.toFixed(1),
    macdHist: m == null ? null : +m.hist.toFixed(2),
    macdBullish: m == null ? null : m.hist > 0,
    bbPos: bb == null ? "unknown" : bb.pctB > 1 ? "above_upper" : bb.pctB > 0.8 ? "near_upper" : bb.pctB < 0 ? "below_lower" : bb.pctB < 0.2 ? "near_lower" : "mid_band",
    bbPctB: bb == null ? null : +bb.pctB.toFixed(2),
    trend,
    volumeZ: vZ == null ? null : +vZ.toFixed(2),
    volumeSpike: vZ != null && vZ > 2,
    support, resistance,
    volume24hUsd: v24 > 0 ? v24 * price : null,
    series: klines.slice(-48).map((k) => ({ t: k.t, c: +k.c.toFixed(2) })),
    summary: null, // filled below
    fetchedAt: Date.now(),
  };
}

/** Detect market events from a fresh snapshot. Returns [{type, details}]. */
export function detectEvents(snap) {
  const events = [];
  if (!snap) return events;
  if (Math.abs(snap.change1h) >= PUMP_DUMP_PCT) {
    events.push({
      type: snap.change1h > 0 ? "pump" : "dump",
      details: { change1h: snap.change1h, price: snap.price },
    });
  }
  if (snap.rsi14 != null && (snap.rsi14 <= RSI_LOW || snap.rsi14 >= RSI_HIGH)) {
    events.push({
      type: "rsi_extreme",
      details: { rsi14: snap.rsi14, side: snap.rsi14 <= RSI_LOW ? "oversold" : "overbought", price: snap.price },
    });
  }
  if (snap.bbPos === "above_upper" || snap.bbPos === "below_lower") {
    events.push({
      type: "bb_break",
      details: { bbPos: snap.bbPos, bbPctB: snap.bbPctB, price: snap.price },
    });
  }
  if (snap.volumeZ != null && snap.volumeZ >= VOL_Z) {
    events.push({
      type: "volume_spike",
      details: { volumeZ: snap.volumeZ, price: snap.price },
    });
  }
  return events;
}

async function storeCandles(env, symbol, klines) {
  const now = Date.now();
  // batch insert (D1 batch is efficient for ~100 rows)
  const stmts = klines.slice(-120).map((k) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO prices (symbol, timeframe, t, o, h, l, c, v)
       VALUES (?, '1h', ?, ?, ?, ?, ?, ?)`
    ).bind(symbol, k.t, k.o, k.h, k.l, k.c, k.v)
  );
  // D1 batch in chunks to stay under limits
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  // prune old candles
  await env.DB.prepare("DELETE FROM prices WHERE t < ?").bind(now - CANDLE_KEEP_MS).run();
}

async function recordEvents(env, symbol, events) {
  const now = Date.now();
  const out = [];
  for (const e of events) {
    // dedupe: same symbol+type within the window
    const dup = await env.DB.prepare(
      `SELECT id FROM market_events
       WHERE symbol = ? AND type = ? AND detected_at > ?
       LIMIT 1`
    ).bind(symbol, e.type, now - EVENT_DEDUPE_MS).first();
    if (dup) continue;
    await env.DB.prepare(
      `INSERT INTO market_events (symbol, type, detected_at, details, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(symbol, e.type, now, JSON.stringify(e.details), now).run();
    out.push(e);
  }
  // prune old events
  await env.DB.prepare("DELETE FROM market_events WHERE detected_at < ?").bind(now - CANDLE_KEEP_MS).run();
  return out;
}

export async function runPriceTick(env) {
  const now = Date.now();
  const snapshots = {};
  const newEvents = [];
  for (const sym of SYMBOLS) {
    try {
      const klines = await fetchKlines(sym, { limit: 120 });
      if (!klines || klines.length < 30) {
        console.warn(`[price] too few klines for ${sym}`);
        continue;
      }
      await storeCandles(env, sym, klines);
      const snap = buildSnapshot(sym, klines);
      snap.summary = summarizeTA(snap);
      snapshots[sym] = snap;
      await env.KV.put(`ta_cache:${sym}`, JSON.stringify(snap), { expirationTtl: 600 });
      const events = detectEvents(snap);
      const recorded = await recordEvents(env, sym, events);
      newEvents.push(...recorded.map((e) => ({ symbol: sym, ...e })));
    } catch (e) {
      console.warn(`[price] tick failed for ${sym}:`, e.message);
    }
  }
  // shared recent-events cache for the analyst prompt
  try {
    const rows = await env.DB.prepare(
      `SELECT symbol, type, detected_at, details FROM market_events
       WHERE detected_at > ? ORDER BY detected_at DESC LIMIT 20`
    ).bind(now - 86400000).all();
    await env.KV.put("market_events_cache", JSON.stringify(rows.results || []), { expirationTtl: 600 });
  } catch (e) {
    console.warn("[price] events cache failed:", e.message);
  }
  // BTC snapshot doubles as the legacy market_cache for backward compat
  if (snapshots.BTC) {
    try {
      const legacy = {
        btc: { price: snapshots.BTC.price, change_24h: snapshots.BTC.change24h },
        eth: snapshots.ETH ? { price: snapshots.ETH.price, change_24h: snapshots.ETH.change24h } : undefined,
        updated_at: now,
      };
      await env.KV.put("market_cache", JSON.stringify(legacy), { expirationTtl: 600 });
    } catch {}
  }
  console.log(`[price] tick done: ${Object.keys(snapshots).join(",")} | ${newEvents.length} new events`);
  return { symbols: Object.keys(snapshots), newEvents };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPriceTick(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (!isAuthorizedAdmin(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      const r = await runPriceTick(env);
      return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/snapshot") {
      const sym = (url.searchParams.get("symbol") || "BTC").toUpperCase();
      const raw = await env.KV.get(`ta_cache:${sym}`);
      return new Response(raw || JSON.stringify({ ok: false, error: "no snapshot" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, worker: "whalesignal-price", status: "healthy" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
