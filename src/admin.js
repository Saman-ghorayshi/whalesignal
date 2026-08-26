// src/admin.js
// Private control-plane worker for WhaleSignal. Not part of the public
// product surface — every route requires X-Admin-Token matching the
// ADMIN_TOKEN secret, and it runs on its own subdomain so it never shares
// an attack surface with the public bot.
//
// Bindings: DB (D1), KV (caches + config keys)
// Secrets:  ADMIN_TOKEN
//
//   GET  /              single-page control panel
//   GET  /api/health    system vitals
//   GET  /api/alerts    recent analyzed events
//   GET  /api/config    current pause flags + key status
//   POST /api/pause     {"scope":"all|btc|eth","paused":true|false}

import { okJson, errJson } from "./worker-utils.js";

const PAUSE_KEY = "config:paused";

/** Pure: constant-time-ish token comparison from the X-Admin-Token header. */
export function isAuthorized(request, token) {
  if (!token) return false;
  const given = request.headers.get("x-admin-token") || "";
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** Pure: validate + normalize a pause request body. Null when malformed. */
export function parsePauseBody(body) {
  if (!body || typeof body !== "object") return null;
  const scope = String(body.scope || "").toLowerCase();
  if (!["all", "btc", "eth"].includes(scope)) return null;
  return { scope, paused: !!body.paused };
}

/**
 * Pure: assemble health vitals from raw inputs so tests can feed fixtures.
 */
export function buildHealth({ states, counts, kvMarket, kvNews, hasGemini, paused }) {
  const now = Date.now();
  const ageOf = (ts) => (ts ? Math.round((now - ts) / 1000) : null);
  const chains = {};
  for (const s of states || []) {
    chains[s.chain] = {
      last_block: s.last_block,
      seconds_since_scan: ageOf(s.last_scan),
      errors: s.errors ?? 0,
      paused: !!(paused?.global || paused?.[s.chain]),
    };
  }
  return {
    ok: true,
    generated_at: now,
    chains,
    whales: counts?.whales ?? {},
    analysis: counts?.analysis ?? {},
    caches: {
      market_age_s: kvMarket?.updated_at ? Math.round((now - kvMarket.updated_at) / 1000) : null,
      news_age_s: kvNews?.updated_at ? Math.round((now - kvNews.updated_at) / 1000) : null,
    },
    ai: { gemini_key: hasGemini },
    paused: paused || {},
  };
}

async function getPaused(env) {
  try { return JSON.parse(await env.KV.get(PAUSE_KEY) || "{}"); }
  catch { return {}; }
}

async function collectCounts(env) {
  const whales = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN detected_at > ? THEN 1 ELSE 0 END) AS last_24h,
            COALESCE(SUM(usd_value), 0) AS volume
     FROM whales`
  ).bind(Date.now() - 86_400_000).first();
  const analysis = await env.DB.prepare(
    `SELECT analysis_status AS status, COUNT(*) AS n FROM whales GROUP BY analysis_status`
  ).all();
  const byStatus = {};
  for (const r of analysis.results || []) byStatus[r.status] = r.n;
  return { whales, analysis: byStatus };
}

async function handleApi(request, env, path) {
  if (path === "/api/health" && request.method === "GET") {
    const states = (await env.DB.prepare(
      "SELECT chain, last_block, last_scan, errors FROM scanner_state"
    ).all()).results;
    const counts = await collectCounts(env);
    let market = null, news = null;
    try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
    try { news = JSON.parse(await env.KV.get("news_cache") || "null"); } catch {}
    let gemini = !!env.GEMINI_KEY;
    if (!gemini) { try { gemini = !!(await env.KV.get("key:gemini")); } catch {} }
    return okJson(buildHealth({
      states, counts, kvMarket: market, kvNews: news,
      hasGemini: gemini, paused: await getPaused(env),
    }));
  }

  if (path === "/api/config" && request.method === "GET") {
    let gemini = !!env.GEMINI_KEY;
    if (!gemini) { try { gemini = !!(await env.KV.get("key:gemini")); } catch {} }
    return okJson({ ok: true, paused: await getPaused(env), ai: { gemini_key: gemini } });
  }

  if (path === "/api/pause" && request.method === "POST") {
    let body = null;
    try { body = await request.json(); } catch { return errJson("invalid json", 400); }
    const parsed = parsePauseBody(body);
    if (!parsed) return errJson("scope must be all|btc|eth", 400);
    const flags = await getPaused(env);
    if (parsed.scope === "all") {
      flags.global = parsed.paused; flags.btc = false; flags.eth = false;
    } else {
      flags[parsed.scope] = parsed.paused; flags.global = false;
    }
    await env.KV.put(PAUSE_KEY, JSON.stringify(flags));
    return okJson({ ok: true, paused: flags });
  }

  if (path === "/api/alerts" && request.method === "GET") {
    const limit = Math.min(parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20, 50);
    const { results } = await env.DB.prepare(
      `SELECT w.id, w.chain, w.tx_hash, w.amount, w.symbol, w.usd_value, w.tx_type,
              w.detected_at, w.analysis_status, w.interesting_score,
              a.headline, a.signal, a.confidence, a.context_relevance
       FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id
       ORDER BY w.detected_at DESC LIMIT ?`
    ).bind(limit).all();
    return okJson({ ok: true, alerts: results || [] });
  }

  return errJson("not found", 404);
}

import { renderPanel } from "./admin-panel.js";

export async function fetchHandler(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/" && request.method === "GET") {
    return new Response(renderPanel(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return errJson("unauthorized", 401);
  }
  try {
    return await handleApi(request, env, path);
  } catch (e) {
    console.error("[admin]", e.message);
    return errJson(e.message, 500);
  }
}

export default { fetch: fetchHandler };
