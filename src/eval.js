/**
 * eval.js — The learning loop. Worker #7.
 *
 * Every hour it scores matured predictions: for each call with
 * detected_at older than the horizon (1h / 6h / 24h), it looks up the
 * asset price then vs now (from D1 prices — no external API needed),
 * computes the return, and grades hit | miss | flat.
 *
 * Then it rebuilds the public leaderboard: overall accuracy, by motive,
 * by confidence bucket, and recent form. The leaderboard is the product's
 * proof — the thing Pro subscriptions will be sold on.
 *
 * Scoring (horizon-scaled noise thresholds):
 *   1h : |return| > 0.3% to count
 *   6h : |return| > 0.75%
 *   24h: |return| > 1.5%
 * bullish + up beyond threshold = hit; bullish + down beyond = miss.
 * Neutral signals are recorded but never scored (no direction = no bet).
 */

import { isAuthorizedAdmin } from "./worker-utils.js";

const HORIZONS = [
  { key: "1h", ms: 3600000, noisePct: 0.3, ocol: "outcome_1h", pcol: "horizon_1h_price", rcol: "horizon_1h_return" },
  { key: "6h", ms: 6 * 3600000, noisePct: 0.75, ocol: "outcome_6h", pcol: "horizon_6h_price", rcol: "horizon_6h_return" },
  { key: "24h", ms: 24 * 3600000, noisePct: 1.5, ocol: "outcome", pcol: "horizon_24h_price", rcol: "horizon_24h_return" },
];

/** Nearest 1h candle close at or before t (D1 prices). */
async function priceAt(env, symbol, t) {
  const row = await env.DB.prepare(
    `SELECT c FROM prices WHERE symbol = ? AND timeframe = '1h' AND t <= ?
     ORDER BY t DESC LIMIT 1`
  ).bind(symbol, t).first();
  return row ? row.c : null;
}

function symbolFor(whale) {
  const s = (whale.symbol || "BTC").toUpperCase();
  return ["BTC", "ETH", "SOL"].includes(s) ? s : "BTC";
}

export function grade(signal, retPct, noisePct) {
  if (signal === "neutral") return "flat";
  if (Math.abs(retPct) < noisePct) return "flat";
  const up = retPct > 0;
  if (signal === "bullish") return up ? "hit" : "miss";
  if (signal === "bearish") return up ? "miss" : "hit";
  return "flat";
}

export async function runEvalTick(env) {
  const now = Date.now();
  let scored = 0;

  for (const h of HORIZONS) {
    const cutoff = now - h.ms;
    // matured, unscored, directional predictions
    let rows;
    try {
      rows = await env.DB.prepare(
        `SELECT p.whale_id, p.signal, p.confidence, p.motive, p.price_at_detect,
                p.detected_at, w.symbol
         FROM predictions p JOIN whales w ON w.id = p.whale_id
         WHERE p.detected_at < ? AND p.${h.ocol} IS NULL
           AND p.signal IN ('bullish', 'bearish')
         LIMIT 200`
      ).bind(cutoff).all();
    } catch (e) {
      console.warn(`[eval] fetch ${h.key} failed:`, e.message);
      continue;
    }
    for (const p of rows.results || []) {
      try {
        const sym = symbolFor(p);
        const p0 = p.price_at_detect || await priceAt(env, sym, p.detected_at);
        const p1 = await priceAt(env, sym, p.detected_at + h.ms);
        if (!p0 || !p1) continue; // not enough price history yet
        const ret = ((p1 - p0) / p0) * 100;
        const outcome = grade(p.signal, ret, h.noisePct);
        await env.DB.prepare(
          `UPDATE predictions SET ${h.pcol} = ?, ${h.rcol} = ?,
             ${h.ocol} = ?, evaluated_at = ? WHERE whale_id = ?`
        ).bind(p1, +ret.toFixed(3), outcome, now, p.whale_id).run();
        scored++;
      } catch (e) {
        console.warn(`[eval] score whale ${p.whale_id} failed:`, e.message);
      }
    }
  }

  const board = await buildLeaderboard(env);
  try {
    await env.KV.put("leaderboard", JSON.stringify(board), { expirationTtl: 7200 });
  } catch (e) {
    console.warn("[eval] leaderboard KV failed:", e.message);
  }
  console.log(`[eval] tick: scored ${scored}, leaderboard ${board.total} calls`);
  return { scored, total: board.total };
}

async function buildLeaderboard(env) {
  const empty = { n: 0, hits: 0, acc: null };
  const board = {
    updated_at: Date.now(),
    total: 0,
    by_horizon: {},
    by_motive: {},
    by_confidence: { high: { ...empty }, mid: { ...empty }, low: { ...empty } },
    recent: [], // last 20 scored 24h outcomes
  };
  try {
    for (const h of HORIZONS) {
      const rows = await env.DB.prepare(
        `SELECT signal, confidence, motive, ${h.ocol} AS o,
                ${h.rcol} AS r
         FROM predictions WHERE ${h.ocol} IS NOT NULL`
      ).all();
      const rs = rows.results || [];
      const scored = rs.filter((x) => x.o === "hit" || x.o === "miss");
      const hits = rs.filter((x) => x.o === "hit").length;
      board.by_horizon[h.key] = {
        n: rs.length, hits,
        acc: scored.length ? +(hits / scored.length).toFixed(3) : null,
      };
      board.total = Math.max(board.total, rs.length);
      for (const x of rs) {
        if (x.o !== "hit" && x.o !== "miss") continue;
        const mk = (map, k) => {
          map[k] = map[k] || { n: 0, hits: 0 };
          map[k].n++;
          if (x.o === "hit") map[k].hits++;
        };
        mk(board.by_motive, x.motive || "unknown");
        mk(board.by_confidence, x.confidence >= 0.7 ? "high" : x.confidence >= 0.5 ? "mid" : "low");
      }
      for (const k of Object.keys(board.by_motive)) {
        const m = board.by_motive[k];
        m.acc = m.n ? +(m.hits / m.n).toFixed(3) : null;
      }
      for (const k of Object.keys(board.by_confidence)) {
        const m = board.by_confidence[k];
        m.acc = m.n ? +(m.hits / m.n).toFixed(3) : null;
      }
      if (h.key === "24h") {
        board.recent = rs.slice(-20).map((x) => ({
          signal: x.signal, motive: x.motive, o: x.o,
          ret: x.r != null ? +x.r.toFixed(2) : null,
        }));
      }
    }
  } catch (e) {
    console.warn("[eval] leaderboard build failed:", e.message);
  }
  return board;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEvalTick(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (!isAuthorizedAdmin(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      const r = await runEvalTick(env);
      return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/leaderboard") {
      const raw = await env.KV.get("leaderboard");
      return new Response(raw || JSON.stringify({ ok: false, error: "not built yet" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true, worker: "whalesignal-eval", status: "healthy" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
