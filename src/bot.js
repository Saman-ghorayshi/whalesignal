// src/bot.js
// The only whale-touched Telegram worker. Two entry points:
//
//   1. fetch(request, env, ctx)  — Telegram webhook for user DMs/inline.
//                                 Phase 1: /ping, /help, /latest.
//   2. queue(batch, env)        — Alert delivery from analyst.
//                                 Posts to the public channel only in Phase 1.
//
// Bindings:
//   DB   — D1
//   KV   — KV (for market_cache when composing /latest)
//   BOT_TOKEN — secret, Telegram bot token (wrangler secret put)
//   PUBLIC_CHANNEL — string, e.g. "@whalesignalnews"

import { okJson, errJson, rateLimited, tgSendMessage, tgSendPhoto, fmtUSD, shortAddr, truncateTelegram, sanitizeAIText, secretsEqual, checkRateLimit } from "./worker-utils.js";
import { analyzeWalletPatterns, buildGraphPayload } from "./graph-analyst.js";
import { buildContentBrief } from "./content.js";

/** CORS headers shared by all public GET/OPTIONS routes (BT11: no drift). */
function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-cache",
    ...extra,
  };
}

/** shared JSON response helper for all public GET routes. */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(extraHeaders),
  });
}

/**
 * Defer a Telegram send past the webhook response (BT9).
 * Telegram retries non-200 webhook responses; if a send succeeded but the
 * response was lost, the retry produced a duplicate reply. So: never hold
 * the webhook open for a send. ctx.waitUntil lets the worker finish the
 * send after returning 200. Send failures are logged, not 502'd — the user
 * may miss one reply, but they never get two.
 * In non-worker envs (tests) without ctx.waitUntil, the promise is returned
 * floating (with a catch attached, so no unhandled rejection).
 */
function replySoon(ctx, sendPromise) {
  const safe = Promise.resolve(sendPromise).catch((e) =>
    console.error("[bot] deferred reply failed:", e?.message || e)
  );
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(safe);
  return safe;
}

/** Validate "owner/repo" shape before interpolating GH_REPO into a URL (BT6/S5). */
export function isValidGhRepo(s) {
  return typeof s === "string" && /^[\w.-]+\/[\w.-]+$/.test(s);
}

// ─── R2 alert export (for paper-trading consumer) ─────────────────────

/**
 * Build the NDJSON line shape that the Python trading loop consumes.
 * Pure. This is the CONTRACT between whalesignal and trading_loop.py.
 *
 * @param {object} whale — whales + analysis row (joined in postPublicAlert)
 * @param {object|null} market — KV market_cache
 * @returns {object} alert JSON or null if required fields missing
 */
export function buildAlertJSON(whale, market) {
  if (!whale || !whale.from_address || !whale.chain || !whale.usd_value) return null;
  const m = market || {};
  return {
    id: whale.id,
    whale: whale.from_address,
    chain: whale.chain?.toUpperCase() || "?",
    signal: whale.signal || "neutral",
    from_label: whale.from_label || null,
    to_label: whale.to_label || null,
    tx_type: whale.tx_type || "unknown",
    usd_value: whale.usd_value,
    amount: whale.amount,
    symbol: whale.symbol,
    detected_at: whale.detected_at,
    market: {
      btc_price: m.btc?.price ?? null,
      eth_price: m.eth?.price ?? null,
      fear_greed: m.fear_greed ?? null,
    },
    analyst_interpretation: whale.interpretation || "",
    headline: whale.headline || "",
    confidence: whale.confidence ?? null,
  };
}

/**
 * Append an alert as one NDJSON line to R2.
 * Uses conditional PUT with a fixed key — reads existing, appends, writes back.
 * read-modify-write on the whole file, not a per-alert key. One file
 * is simple to poll and parse. Add per-hour rotation if the file grows > 1MB.
 */
async function postAlertToR2(env, alertJSON) {
  if (!env.ALERTS_R2) { console.warn("[bot] ALERTS_R2 not bound — skipping R2 export"); return; }
  const key = "alerts.ndjson";
  let existing = "";
  try {
    const obj = await env.ALERTS_R2.get(key);
    if (obj) existing = await obj.text();
  } catch (e) { /* file may not exist yet */ }
  const ndjsonLine = JSON.stringify(alertJSON) + "\n";
  try {
    await env.ALERTS_R2.put(key, existing + ndjsonLine);
  } catch (e) {
    // BT5: a failed export must NEVER trigger a Telegram repost. The alert is
    // already delivered to the channel; the trading loop can backfill from
    // GET /history. Swallow here — the atomic delivered-claim in
    // postPublicAlert already prevents a retry from re-sending.
    console.warn(`[bot] R2 export failed (alert kept, not reposted): ${e.message}`);
  }
}

// ─── GitHub Actions trigger (repository_dispatch) ────────────────────

/**
 * Fire a repository_dispatch event to GitHub Actions.
 * This triggers the trade.yml workflow in the whalesignal repo.
 *
 * Requires env.GH_PAT (GitHub Personal Access Token, repo scope) and
 * env.GH_REPO (e.g. "saman-ghorayshi/whalesignal"). Both set as CF Worker secrets.
 *
 * Fire-and-forget: if the POST fails, we log but don't throw — the alert
 * is already posted to Telegram and R2. The trading loop will pick it up
 * on the next manual or scheduled GH Actions run anyway.
 */
export async function fireGitHubDispatch(env, alertJSON) {
  if (!env.GH_PAT) return; // not configured — skip
  if (!isValidGhRepo(env.GH_REPO)) {
    // BT6/S5: a malformed GH_REPO used to produce a confusing 404 that was
    // swallowed by the fire-and-forget catch. Validate the owner/repo shape
    // up front instead.
    console.warn(`[bot] GH_REPO malformed (${JSON.stringify(env.GH_REPO)}) — skipping dispatch`);
    return;
  }
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${env.GH_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          // BT6: GitHub's API requires a User-Agent header; without it every
          // request 403s. Workers' fetch does not add one by default.
          "User-Agent": "whalesignal-bot/1.0",
          Authorization: `Bearer ${env.GH_PAT}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          event_type: "new_alert",
          client_payload: {
            alert_id: alertJSON?.id ?? null,
            whale: alertJSON?.whale ?? null,
            chain: alertJSON?.chain ?? null,
            signal: alertJSON?.signal ?? null,
          },
        }),
      },
    );
    if (!resp.ok) {
      console.warn(`[bot] GitHub dispatch failed: ${resp.status} ${resp.statusText}`);
    } else {
      console.log(`[bot] GitHub dispatch sent for alert ${alertJSON?.id}`);
    }
  } catch (e) {
    console.warn(`[bot] GitHub dispatch error: ${e.message}`);
  }
}

// ─── alert formatting (pure, testable) ────────────────────────────────

/**
 * Format a whale + its analysis into the channel alert text. Pure.
 *
 * @param {object} whale — whales row
 *   {chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, block_time, detected_at}
 * @param {object|null} analysis — analysis row
 *   {headline, interpretation, signal, confidence, related_factor}
 * @param {object|null} market — KV market_cache (for the footer)
 * @param {object} opts — { explorerBase: 'https://etherscan.io/tx/' | 'https://blockchain.com/tx/' }
 */
export function formatAlert(whale, analysis, market, opts = {}) {
  const chain = whale.chain?.toUpperCase() || "?";
  const usd = fmtUSD(whale.usd_value);
  const amtStr = `${(+whale.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${whale.symbol}`;
  const fromShort = shortAddr(whale.from_address);
  const toShort = shortAddr(whale.to_address);

  // BT12: blockchain.com/tx/<hash> does not resolve — use mempool.space.
  const explorerBase = opts.explorerBase || (whale.chain === "btc"
    ? "https://mempool.space/tx/"
    : "https://etherscan.io/tx/");
  const explorerLink = `${explorerBase}${whale.tx_hash}`;

  // S2: headline/interpretation are LLM-generated (untrusted). Strip control
  // characters and cap length before they reach the public channel. The
  // channel sends plain text (no parse_mode), so there is no markup vector,
  // but phishing-flavored prose and multi-KB ramblings are still cut here.
  const headline = sanitizeAIText(analysis?.headline, 200);
  const interpretation = sanitizeAIText(analysis?.interpretation, 2000);

  const sig = (analysis?.signal || "neutral").toLowerCase();
  const sigEmoji = sig === "bullish" ? "🟢 BULLISH" : sig === "bearish" ? "🔴 BEARISH" : "⚪ NEUTRAL";
  const conf = analysis?.confidence != null ? (analysis.confidence).toFixed(2) : "—";

  // market footer
  const m = market || {};
  const btcP = m.btc?.price ? `$${m.btc.price.toLocaleString()}` : "—";
  const btcChg = m.btc?.change_24h != null ? `${m.btc.change_24h >= 0 ? "+" : ""}${m.btc.change_24h.toFixed(1)}%` : "—";
  const ethP = m.eth?.price ? `$${m.eth.price.toLocaleString()}` : "—";
  const fg = m.fear_greed != null ? `F&G ${m.fear_greed} (${m.fear_greed_label || ""})` : "F&G —";

  const txTypeLabel = TX_TYPE_LABEL[whale.tx_type] || "wallet move";

  // We use plain text (no Markdown) for the ALERT body because Telegram
  // parse_mode Markdown is brittle when AI text contains asterisks/underscores.
  // /help and /ping below use plain text too for consistency.
  const lines = [];
  lines.push(`🐋 WHALE ALERT — ${chain}`);
  lines.push(`${usd} ${txTypeLabel}`);
  lines.push("");
  lines.push(`💰 ${amtStr} (${usd})`);
  lines.push(`📍 ${whale.chain} → ${toShort}`);
  if (whale.block_number) lines.push(`🧱 Block ${whale.block_number.toString()}`);
  lines.push("");
  if (headline || interpretation) {
    lines.push("🧠 AI Analysis:");
    if (headline) lines.push(headline);
    if (interpretation) lines.push(interpretation);
    lines.push("");
  } else {
    lines.push("🧠 AI Analysis: (pending)");
    lines.push("");
  }
  lines.push(`📊 Market: BTC ${btcP} (${btcChg}) | ${fg} | ETH ${ethP}`);
  lines.push(`🔮 Signal: ${sigEmoji} (confidence ${conf})`);
  if (analysis?.related_factor) lines.push(`📎 ${sanitizeAIText(analysis.related_factor, 200)}`);
  // Whale-intelligence: why they did it + what may have triggered it + TA.
  if (analysis?.motive && analysis.motive !== "unknown") {
    const mc = analysis.motive_confidence != null ? ` (${Number(analysis.motive_confidence).toFixed(2)})` : "";
    lines.push(`🎯 Likely motive: ${sanitizeAIText(motiveLabel(analysis.motive), 60)}${mc}`);
  }
  if (analysis?.catalyst_title) {
    const curl = analysis.catalyst_url ? ` — ${analysis.catalyst_url}` : "";
    lines.push(`📰 Catalyst: ${sanitizeAIText(analysis.catalyst_title, 160)}${curl}`);
  }
  if (analysis?.ta_summary) lines.push(`📈 TA: ${sanitizeAIText(analysis.ta_summary, 300)}`);
  // Causal chain: what led here (news → sentiment → whale).
  if (analysis?.causal_chain) {
    try {
      const chain = JSON.parse(analysis.causal_chain);
      if (Array.isArray(chain) && chain.length > 1) {
        const shown = chain.slice(-4, -1); // exclude the whale itself (already the alert)
        if (shown.length) {
          lines.push("⛓ What led here:");
          for (const l of shown) lines.push(`${l.icon || "•"} ${sanitizeAIText(l.text, 110)}`);
        }
      }
    } catch {}
  }
  lines.push(`🔍 ${explorerLink}`);
  // BT13: org drift — real repo is saman-ghorayshi/whalesignal.
  lines.push(`🌐 Money-Flow Graph: https://saman-ghorayshi.github.io/whalesignal/wallet.html?addr=${whale.from_address}&chain=${whale.chain}`);
  return lines.join("\n");
}

const TX_TYPE_LABEL = {
  exchange_inflow: "→ exchange (likely sell)",
  exchange_outflow: "← exchange (likely withdraw)",
  exchange_internal: "↔ exchange-to-exchange",
  wallet_to_wallet: "↔ wallet to wallet",
  unknown: "wallet move",
};

// Human-readable motive labels for the public channel.
function motiveLabel(m) {
  const map = {
    accumulation: "accumulation — buying the dip",
    distribution: "distribution — preparing to sell",
    capitulation: "capitulation — panic selling",
    profit_taking: "profit taking into strength",
    dry_powder: "dry powder — stablecoins ready to buy",
    cold_storage: "moving to cold storage",
    otc_deal: "likely OTC deal",
    internal_ops: "internal reorganization",
    rebalancing: "capital repositioning",
    unknown: "unclear",
  };
  return map[m] || "unclear";
}

// ─── fetch (Telegram webhook) ─────────────────────────────────────────

export async function fetchHandler(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // ─── OPTIONS preflight for the public GET routes (BT11) ──────────────
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // ─── public GET /latest?limit=N  (Phase 3 of ship runbook) ───────────
  // NO auth. The alert row carries no secret — it's the same
  // content the bot posts to a public Telegram channel. Read-only, CORS
  // open so the github.io demo page can fetch() it cross-origin.
  if (request.method === "GET" && path === "/latest") {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rl = await checkRateLimit(env, `http:/latest:${ip}`, 30, 60);
    if (rl.limited) return rateLimited();
    const limit = url.searchParams.get("limit") || 1;
    try {
      const rows = await latestRows(env, limit);
      let market = null;
      try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
      const payload = renderLatestJSON(rows, market);
      return jsonResponse(payload);
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /stats — aggregate statistics for the stats page ────
  if (request.method === "GET" && path === "/stats") {
    try {
      const stats = await statsRows(env);
      const bySymbol = await statsBySymbol(env);
      const hourly = await statsHourly(env);
      let market = null;
      try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
      const payload = renderStatsJSON(stats, bySymbol, hourly, market);
      // BT11: use the shared helper so CORS/Cache-Control can't drift.
      return jsonResponse(payload, 200, { "Cache-Control": "public, max-age=60" });
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /history — paginated, filterable whale history ──────
  if (request.method === "GET" && path === "/history") {
    try {
      const opts = {
        page: url.searchParams.get("page") || 1,
        limit: url.searchParams.get("limit") || 20,
        chain: url.searchParams.get("chain"),
        symbol: url.searchParams.get("symbol"),
        signal: url.searchParams.get("signal"),
        min_usd: url.searchParams.get("min_usd"),
      };
      // BT7: total is a real COUNT(*) with the same filters, not the page size.
      const [rows, total] = await Promise.all([historyRows(env, opts), historyCount(env, opts)]);
      const payload = renderHistoryJSON(rows, opts.page, opts.limit, total);
      return jsonResponse(payload);
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /content — content brief for the latest big whale ──
  // Returns a human-ready brief: hook, 30s spoken script, caption, hashtags.
  // ?id= for a specific whale, otherwise the latest score>=50 whale.
  // KV-first (content_briefs cache), D1 fallback.
  if (request.method === "GET" && path === "/content") {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rl = await checkRateLimit(env, `http:/content:${ip}`, 30, 60);
    if (rl.limited) return rateLimited();
    try {
      const id = url.searchParams.get("id");
      if (!id) {
        try {
          const raw = await env.KV.get("content_briefs");
          const list = raw ? JSON.parse(raw) : [];
          if (list.length) return jsonResponse({ ok: true, brief: list[0], cached: true });
        } catch {}
      }
      let whale;
      if (id) {
        whale = await env.DB.prepare("SELECT * FROM whales WHERE id = ?").bind(id).first();
      } else {
        whale = await env.DB.prepare(
          `SELECT * FROM whales WHERE interesting_score >= 50
           ORDER BY detected_at DESC LIMIT 1`
        ).first();
      }
      if (!whale) {
        return jsonResponse({ ok: false, error: "no whale found" }, 404);
      }
      const analysis = await env.DB.prepare(
        "SELECT * FROM analysis WHERE whale_id = ?"
      ).bind(whale.id).first();
      const brief = buildContentBrief(whale, analysis);
      return jsonResponse({ ok: true, brief });
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /content/queue — last N content briefs ──
  // KV-first (content_briefs cache written at alert time), D1 fallback.
  if (request.method === "GET" && path === "/content/queue") {
    try {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "5", 10) || 5, 20);
      try {
        const raw = await env.KV.get("content_briefs");
        const list = raw ? JSON.parse(raw) : [];
        if (list.length) {
          return jsonResponse({ ok: true, count: Math.min(list.length, limit), briefs: list.slice(0, limit), cached: true });
        }
      } catch {}
      const whales = await env.DB.prepare(
        `SELECT * FROM whales WHERE interesting_score >= 50
         ORDER BY detected_at DESC LIMIT ?`
      ).bind(limit).all();
      const briefs = [];
      for (const w of whales.results || []) {
        const analysis = await env.DB.prepare(
          "SELECT * FROM analysis WHERE whale_id = ?"
        ).bind(w.id).first();
        briefs.push(buildContentBrief(w, analysis));
      }
      return jsonResponse({ ok: true, count: briefs.length, briefs });
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /wallet/:addr — wallet profile + recent txs ─────────
  if (request.method === "GET" && path.startsWith("/wallet/")) {
    try {
      const addr = decodeURIComponent(path.slice("/wallet/".length));
      const chain = url.searchParams.get("chain");
      const { profile, txs } = await walletProfile(env, addr, chain);
      const payload = renderWalletJSON(profile, txs);
      return jsonResponse(payload, profile ? 200 : 404);
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /graph/:addr — forensic money-flow graph ─────────────
  if (request.method === "GET" && path.startsWith("/graph/")) {
    try {
      const addr = decodeURIComponent(path.slice("/graph/".length)).toLowerCase();
      const chain = url.searchParams.get("chain");
      const { results: txs } = await env.DB.prepare(
        "SELECT id, chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, detected_at " +
        "FROM whales WHERE (lower(from_address) = ? OR lower(to_address) = ?) " +
        (chain ? "AND lower(chain) = ? " : "") +
        "ORDER BY detected_at DESC LIMIT 100"
      ).bind(...(chain ? [addr, addr, chain.toLowerCase()] : [addr, addr])).all();

      const addrs = new Set();
      addrs.add(addr);
      for (const t of txs || []) {
        if (t.from_address) addrs.add(String(t.from_address).toLowerCase());
        if (t.to_address) addrs.add(String(t.to_address).toLowerCase());
      }
      const addrList = Array.from(addrs);
      const walletMap = new Map();
      if (addrList.length > 0) {
        for (let i = 0; i < addrList.length; i += 50) {
          const chunk = addrList.slice(i, i + 50);
          const placeholders = chunk.map(() => "?").join(",");
          const { results: wRows } = await env.DB.prepare(
            `SELECT address, label, type FROM wallets WHERE lower(address) IN (${placeholders})`
          ).bind(...chunk).all();
          for (const w of wRows || []) {
            walletMap.set(String(w.address).toLowerCase(), w);
          }
        }
      }

      const payload = buildGraphPayload(txs || [], walletMap, addr);
      return jsonResponse({ ok: true, ...payload });
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /patterns/:addr — forensic deception analysis ────────
  if (request.method === "GET" && path.startsWith("/patterns/")) {
    try {
      const addr = decodeURIComponent(path.slice("/patterns/".length)).toLowerCase();
      const chain = url.searchParams.get("chain");
      const { results: txs } = await env.DB.prepare(
        "SELECT id, chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, detected_at " +
        "FROM whales WHERE (lower(from_address) = ? OR lower(to_address) = ?) " +
        (chain ? "AND lower(chain) = ? " : "") +
        "ORDER BY detected_at DESC LIMIT 100"
      ).bind(...(chain ? [addr, addr, chain.toLowerCase()] : [addr, addr])).all();

      let market = null, news = null;
      try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
      try { news = JSON.parse(await env.KV.get("news_cache") || "null"); } catch {}

      const analysis = analyzeWalletPatterns(txs || [], addr, market, news);
      return jsonResponse({ ok: true, ...analysis });
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── GET /test-ai — diagnostic live probe across AI engines ─────────
  // S3: this proxy burns AI quota on the analyst with every hit, so it is
  // NOT public. Gate with ?key=<ADMIN_TOKEN>. Fail closed: if no secret is
  // configured, the endpoint stays dark. 404 (not 403) to avoid leaking it.
  if (request.method === "GET" && path === "/test-ai") {
    const gateSecret = env.ADMIN_TOKEN || env.WEBHOOK_SECRET || "";
    const key = url.searchParams.get("key") || "";
    if (!gateSecret || !secretsEqual(key, gateSecret)) {
      return errJson("not found", 404);
    }
    try {
      let resp;
      // The analyst's /test-ai is itself gated — forward our already-verified
      // admin key so the proxy doesn't 401 against the analyst.
      const fwdKey = encodeURIComponent(key);
      if (env.ANALYST_SERVICE) {
        resp = await env.ANALYST_SERVICE.fetch(new Request(`https://whalesignal-analyst/test-ai?key=${fwdKey}`));
      } else {
        const analystUrl = env.ANALYST_URL || "https://whalesignal-analyst.mv3sxp7x4fkv-6d9.workers.dev/test-ai";
        resp = await fetch(`${analystUrl}?key=${fwdKey}`);
      }
      const data = await resp.json();
      return jsonResponse(data, resp.status);
    } catch (e) {
      return jsonResponse({
        ok: false,
        error: `Could not reach analyst test endpoint: ${e.message}`,
      }, 502);
    }
  }

  const expected = `/tg/${env.BOT_TOKEN || ""}`;
  if (path !== expected) {
    return errJson("not found", 404);
  }

  if (request.method !== "POST") {
    // Telegram GETs the webhook for setup — return ok so it doesn't error.
    // (No secret check on GET: Telegram's setup probe carries no header; the
    // token in the path is the auth here.)
    return okJson({ ok: true, service: "whalesignal-bot" });
  }

  // S1: verify Telegram's X-Telegram-Bot-Api-Secret-Token header (set via
  // setWebhook's secret_token). Token-in-path alone lands in CF request logs
  // and proxy logs; the header check means a leaked URL is not enough to
  // forge updates, spam users, or burn D1/KV quota. Constant-time compare,
  // 404 (not 403) on mismatch to avoid leaking the endpoint's existence.
  if (env.WEBHOOK_SECRET) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!secretsEqual(got, env.WEBHOOK_SECRET)) {
      return errJson("not found", 404);
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return errJson("invalid json", 400);
  }

  // Channel posts are broadcasts, not interactive bot commands — NEVER reply to them!
  if (update.channel_post || update.message?.chat?.type === "channel") {
    return okJson({ ok: true, ignored: "channel_post" });
  }

  const msg = update.message;
  if (msg?.text) {
    const chatId = String(msg.chat.id);
    const from = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || "friend");
    const txt = msg.text.trim();
    const lc = txt.toLowerCase();

    // BT10: per-chat sliding-window rate limit (10 commands/min). The webhook
    // URL is effectively public once token-in-path is known, and /check does
    // a 50-row D1 scan + 2 KV reads per hit. 429 → Telegram retries later.
    const rl = await checkRateLimit(env, `tgcmd:${chatId}`, 10, 60);
    if (!rl.ok) {
      const r = rateLimited();
      if (rl.retryAfterSec) r.headers.set("retry-after", String(rl.retryAfterSec));
      return r;
    }

    // If not a slash command:
    if (!lc.startsWith("/")) {
      if (msg.chat?.type === "private") {
        // BT9: reply via waitUntil, return 200 immediately (see replySoon).
        replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId, truncateTelegram(HELP_TEXT)));
        return okJson({ ok: true, handled: "help_fallback" });
      }
      return okJson({ ok: true, ignored: "non_command" });
    }

    // Strip bot mention: e.g. /ping@Whaletracker_sig_bot -> /ping
    const cmd = lc.split("@")[0].split(/\s+/)[0];

    try {
      if (cmd === "/ping") {
        replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId,
          `🐋 WhaleSignal is alive. Ping received from ${from} at ${new Date().toISOString()}.`));
        return okJson({ ok: true, handled: "ping" });
      }
      if (cmd === "/help" || cmd === "/start") {
        replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId, truncateTelegram(HELP_TEXT)));
        return okJson({ ok: true, handled: "help" });
      }
      if (cmd === "/latest") {
        // DM reply keeps 5-row behavior. Shared helper, limit=5.
        const rows = await latestRows(env, 5);
        let market = null;
        try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
        const reply = renderLatestReply(rows, market);
        replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId, truncateTelegram(reply)));
        return okJson({ ok: true, handled: "latest" });
      }
      if (cmd === "/stats") {
        // BT1: the old code called five functions that don't exist
        // (getGlobalStats, getSignalAccuracy, getTopSymbols,
        // getHourlyDistribution, getMarketSnapshot) → ReferenceError → 502,
        // and Telegram retried the webhook on every hit. Reuse the same
        // helpers the public GET /stats route uses, and map the args to
        // renderStatsJSON(stats, bySymbol, hourly, market) correctly.
        const [stats, bySymbol, hourly] = await Promise.all([
          statsRows(env), statsBySymbol(env), statsHourly(env),
        ]);
        let market = null;
        try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
        const payload = renderStatsJSON(stats, bySymbol, hourly, market);
        // BT3: plain text (no Markdown). The old reply used *bold* markers
        // while the channel deliberately sends no parse_mode — one convention.
        const reply = `📊 WhaleSignal Intelligence Stats\n\n` +
          `• 24h Volume: ${fmtUSD(payload.total_volume)}\n` +
          `• Whales Tracked: ${payload.count_24h}\n` +
          `• Largest Move: ${fmtUSD(payload.largest_transfer)}\n` +
          `• Signals: 🟢 Bullish: ${payload.signals.bullish} | 🔴 Bearish: ${payload.signals.bearish} | ⚪ Neutral: ${payload.signals.neutral}\n` +
          // accuracy.rate, not rate_pct — renderStatsJSON emits { evaluated, correct, rate }.
          (payload.accuracy ? `• Signal Accuracy: ${payload.accuracy.rate}%\n` : "") +
          `\nUse /latest to view recent whale moves.`;
        replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId, truncateTelegram(reply)));
        return okJson({ ok: true, handled: "stats" });
      }
      if (cmd === "/check" || cmd === "/pattern" || cmd === "/graph") {
        const parts = txt.split(/\s+/);
        const targetAddr = parts[1]?.trim();
        if (!targetAddr) {
          replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId,
            truncateTelegram("Please provide a wallet address to check. Example:\n/check 0x28c6c06298d514de13c02684fa65b7c0c1f723e4")));
          return okJson({ ok: true, handled: "check_missing_addr" });
        }
        const cleanAddr = targetAddr.toLowerCase();
        const { results: txs } = await env.DB.prepare(
          "SELECT id, chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, detected_at " +
          "FROM whales WHERE (lower(from_address) = ? OR lower(to_address) = ?) " +
          "ORDER BY detected_at DESC LIMIT 50"
        ).bind(cleanAddr, cleanAddr).all();

        // Second-pass fix: /check on an unknown address used to 502
        // (analyzeWalletPatterns returned empty metrics → property access
        // threw → Telegram retried the webhook). Answer honestly instead.
        if (!txs || txs.length === 0) {
          replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId,
            `🕵️ No whale transactions found for ${cleanAddr} yet.\nThe scanner only tracks moves over the USD threshold — check back after the next alert, or try /latest.`));
          return okJson({ ok: true, handled: "check_no_txs" });
        }

        let market = null, news = null;
        try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
        try { news = JSON.parse(await env.KV.get("news_cache") || "null"); } catch {}

        const p = analyzeWalletPatterns(txs || [], cleanAddr, market, news);
        const riskEmoji = p.deception_risk === "high" ? "🚨 HIGH RISK" : p.deception_risk === "medium" ? "⚠️ MEDIUM RISK" : "✅ LOW RISK";
        const reply = [
          `🕵️ WhaleSignal Forensic Report`,
          `• Address: ${cleanAddr}`,
          `• Risk Level: ${riskEmoji} (Score: ${p.deception_score}/100)`,
          `• Profile: ${p.behavioral_profile}`,
          `• Activity: In: ${fmtUSD(p.metrics.total_inflow_usd)} | Out: ${fmtUSD(p.metrics.total_outflow_usd)} | Net: ${fmtUSD(p.metrics.net_flow_usd)}`,
          `• Counterparties: ${p.metrics.unique_counterparties} unique address(es)`,
          p.wash_loops.length > 0 ? `• Wash Loops: ⚠️ ${p.wash_loops.length} round-trip loop(s) detected!` : null,
          p.is_peeling_chain ? `• Peeling Chain: ⚠️ Layering across single-use addresses detected!` : null,
          p.is_structuring ? `• Structuring: ⚠️ Rapid split transfers detected!` : null,
          "",
          `💡 Intent Analysis:`,
          sanitizeAIText(p.intent_summary, 1500),
          "",
          p.flags.length > 0 ? `🚩 Flags: ${p.flags.join(", ")}` : null,
          "",
          `🌐 Interactive Money-Flow Graph:`,
          // BT13: org drift — real repo is saman-ghorayshi/whalesignal.
          `https://saman-ghorayshi.github.io/whalesignal/wallet.html?addr=${cleanAddr}`,
        ].filter(Boolean).join("\n");

        replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId, truncateTelegram(reply)));
        return okJson({ ok: true, handled: "check" });
      }
      // Unknown command: only reply if in a private DM
      if (msg.chat?.type === "private") {
        replySoon(ctx, tgSendMessage(env.BOT_TOKEN, chatId,
          truncateTelegram(`I don't know that command yet. Try /help, /ping, /latest, /stats, or /check <addr>.`)));
      }
      return okJson({ ok: true, handled: "unknown" });
    } catch (e) {
      // Only genuine failures reach here (DB errors etc.) — no Telegram send
      // happened, so Telegram retrying the webhook can't duplicate a reply.
      console.error("bot fetch handler failed:", e.message);
      return errJson("tg error: " + e.message, 502);
    }
  }

  // acknowledgment of non-message updates (inline, callbacks, edits)
  return okJson({ ok: true, handled: "noop" });
}

const HELP_TEXT = `🐋 WhaleSignal — AI whale alerts

Commands:
  /ping          — health check
  /help          — this message
  /latest        — recently posted whale moves
  /stats         — 24h market intelligence & signal stats
  /check <addr>  — forensic wallet deception & money-flow report

We post AI-enhanced whale alerts to our channel.
Got a suggestion? Reply to this message.`;

// ─── /latest helper (shared by DM /latest and GET /latest route) ───────

/**
 * Pull the N most-recent analyzed whales rows joined with their analysis.
 * Pure-ish (DB read only). Returns an array of row objects.
 *
 * ONE query shape, used by both the Telegram DM /latest reply
 * and the public GET /latest JSON route. Two surface, one source of truth.
 * Default limit=1 (smallest JSON payload for the 30s-polling github.io demo).
 * Callers pass limit=5 for the DM reply to match the original 5-row behavior.
 */
export async function latestRows(env, limit = 1) {
  const n = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 1)));
  const { results } = await env.DB.prepare(
    "SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol, " +
    "w.usd_value, w.tx_type, w.block_number, w.detected_at, " +
    "a.headline, a.interpretation, a.signal, a.confidence, a.related_factor " +
    "FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id " +
    "WHERE w.analysis_status = 'done' ORDER BY w.detected_at DESC LIMIT ?"
  ).bind(n).all();
  return results || [];
}

/** Build the /latest reply FROM the shared query. Public for test reuse. */
export function renderLatestReply(rows, market = null) {
  if (!rows || rows.length === 0) {
    return "No whale moves posted yet. The scanner cron just kicked off — check back in a minute.";
  }
  const blocks = rows.map((w) => {
    const sig = (w.signal || "—").toLowerCase();
    const emoji = sig === "bullish" ? "🟢" : sig === "bearish" ? "🔴" : "⚪";
    return `${emoji} ${fmtUSD(w.usd_value)} ${w.symbol} ${w.chain} — ${w.headline || "(no headline)"}\n  ${shortAddr(w.from_address)} → ${shortAddr(w.to_address)}`;
  });
  return ["🐋 Latest whale moves:", "", ...blocks].join("\n");
}

/** Build the public GET /latest JSON payload from the shared query. */
export function renderLatestJSON(rows, market = null) {
  if (!rows || rows.length === 0) {
    return { ok: false, reason: "no alerts yet", alerts: [] };
  }
  const m = market || {};
  const alerts = rows.map((w) => ({
    id: w.id,
    chain: (w.chain || "?").toUpperCase(),
    whale: w.from_address,
    to: w.to_address,
    symbol: w.symbol,
    usd_value: w.usd_value,
    amount: w.amount,
    tx_type: w.tx_type,
    block_number: w.block_number,
    detected_at: w.detected_at,
    signal: w.signal || "neutral",
    headline: w.headline || "",
    interpretation: w.interpretation || "",
    confidence: w.confidence ?? null,
    related_factor: w.related_factor || null,
  }));
  return {
    ok: true,
    count: alerts.length,
    market: {
      btc_price: m.btc?.price ?? null,
      eth_price: m.eth?.price ?? null,
      fear_greed: m.fear_greed ?? null,
    },
    alerts,
  };
}

// ─── /stats endpoint ───────────────────────────────────────────────────

/**
 * Query aggregate stats from D1. One round trip, ~5 reads of existing indexes.
 * Returns: total whales, total volume, signal breakdown, top symbols,
 * 24h count, 7d count, largest transfer, exchange flow ratios.
 */
export async function statsRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT
       COUNT(*)                              AS total_whales,
       COALESCE(SUM(usd_value), 0)           AS total_volume,
       COALESCE(SUM(CASE WHEN a.signal='bullish' THEN 1 ELSE 0 END), 0) AS bullish,
       COALESCE(SUM(CASE WHEN a.signal='bearish' THEN 1 ELSE 0 END), 0) AS bearish,
       COALESCE(SUM(CASE WHEN a.signal='neutral' THEN 1 ELSE 0 END), 0) AS neutral,
       COALESCE(SUM(CASE WHEN detected_at > ? THEN 1 ELSE 0 END), 0)   AS count_24h,
       COALESCE(SUM(CASE WHEN detected_at > ? THEN 1 ELSE 0 END), 0)   AS count_7d,
       COALESCE(MAX(usd_value), 0)           AS largest_transfer,
       COALESCE(SUM(CASE WHEN a.prediction_outcome IS NOT NULL THEN 1 ELSE 0 END), 0) AS accuracy_total,
       COALESCE(SUM(CASE WHEN a.prediction_outcome='correct' THEN 1 ELSE 0 END), 0)  AS accuracy_correct
     FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id
     WHERE w.analysis_status IN ('done', 'skipped')`
  ).bind(Date.now() - 86_400_000, Date.now() - 7 * 86_400_000).all();
  return (results && results[0]) || {};
}

/**
 * Query per-symbol breakdown for the stats page. Top 5 symbols by count.
 */
export async function statsBySymbol(env) {
  const { results } = await env.DB.prepare(
    `SELECT symbol, COUNT(*) AS count, COALESCE(SUM(usd_value), 0) AS volume
     FROM whales WHERE analysis_status IN ('done', 'skipped')
     GROUP BY symbol ORDER BY count DESC LIMIT 5`
  ).all();
  return results || [];
}

/**
 * Query hourly whale activity for the last 24h (for charts). Returns
 * { hour_bucket, count, volume } per hour.
 */
export async function statsHourly(env) {
  const { results } = await env.DB.prepare(
    `SELECT
       (detected_at / 3600000) * 3600000 AS hour_bucket,
       COUNT(*)                           AS count,
       COALESCE(SUM(usd_value), 0)        AS volume
     FROM whales
     WHERE detected_at > ? AND analysis_status IN ('done', 'skipped')
     GROUP BY hour_bucket ORDER BY hour_bucket ASC`
  ).bind(Date.now() - 24 * 86_400_000).all();
  return results || [];
}

/** Pure. Build the /stats JSON payload from query results. */
export function renderStatsJSON(stats, bySymbol, hourly, market = null) {
  const s = stats || {};
  const total = s.total_whales || 0;
  return {
    ok: total > 0,
    total_whales: total,
    total_volume: s.total_volume || 0,
    count_24h: s.count_24h || 0,
    count_7d: s.count_7d || 0,
    largest_transfer: s.largest_transfer || 0,
    signals: {
      bullish: s.bullish || 0,
      bearish: s.bearish || 0,
      neutral: s.neutral || 0,
    },
    accuracy: s.accuracy_correct || s.accuracy_total ? {
      evaluated: s.accuracy_total || 0,
      correct: s.accuracy_correct || 0,
      rate: s.accuracy_total ? Math.round((s.accuracy_correct / s.accuracy_total) * 100) : 0,
    } : null,
    top_symbols: (bySymbol || []).map((sym) => ({
      symbol: sym.symbol,
      count: sym.count,
      volume: sym.volume,
    })),
    hourly: (hourly || []).map((h) => ({
      hour: h.hour_bucket,
      count: h.count,
      volume: h.volume,
    })),
    market: market ? {
      btc_price: market.btc?.price ?? null,
      eth_price: market.eth?.price ?? null,
      fear_greed: market.fear_greed ?? null,
    } : null,
  };
}

// ─── /history endpoint ─────────────────────────────────────────────────

/**
 * Shared WHERE clause for the /history page query and its COUNT(*).
 * BT7: total must use the SAME filters as the page, or pagination lies.
 * @returns {{ where: string, binds: any[] }}
 */
function historyWhere(opts = {}) {
  const { chain = null, symbol = null, signal = null, min_usd = null } = opts;
  let where = "WHERE w.analysis_status IN ('done', 'skipped')";
  const binds = [];
  if (chain) { where += " AND w.chain = ?"; binds.push(String(chain).toLowerCase()); }
  if (symbol) { where += " AND w.symbol = ?"; binds.push(String(symbol).toUpperCase()); }
  if (signal) { where += " AND a.signal = ?"; binds.push(String(signal).toLowerCase()); }
  if (min_usd != null && min_usd !== "") { where += " AND w.usd_value >= ?"; binds.push(Number(min_usd)); }
  return { where, binds };
}

/**
 * Paginated history query. Filters: chain, symbol, signal, min_usd.
 * Sort: detected_at DESC. Returns joined whale+analysis rows.
 */
export async function historyRows(env, opts = {}) {
  const { page = 1, limit = 20 } = opts;
  const n = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
  const offset = Math.max(0, (Math.trunc(Number(page) || 1) - 1) * n);

  const { where, binds } = historyWhere(opts);
  const sql = "SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol, " +
    "w.usd_value, w.tx_type, w.block_number, w.detected_at, w.interesting_score, " +
    "a.headline, a.interpretation, a.signal, a.confidence, a.related_factor " +
    "FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id " +
    where + " ORDER BY w.detected_at DESC LIMIT ? OFFSET ?";

  const { results } = await env.DB.prepare(sql).bind(...binds, n, offset).all();
  return results || [];
}

/**
 * COUNT(*) with the same filters as historyRows — the real /history total.
 * The old code passed the current page's row count as `total`, which broke
 * any frontend pagination built on it.
 */
export async function historyCount(env, opts = {}) {
  const { where, binds } = historyWhere(opts);
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id " + where
  ).bind(...binds).first();
  return row?.cnt ?? 0;
}

/** Pure. Build the /history JSON payload. */
export function renderHistoryJSON(rows, page, limit, total) {
  return {
    ok: true,
    page: Math.max(1, Math.trunc(Number(page) || 1)),
    limit: Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20))),
    total: total || (rows ? rows.length : 0),
    alerts: (rows || []).map((w) => ({
      id: w.id,
      chain: (w.chain || "?").toUpperCase(),
      tx_hash: w.tx_hash,
      from: w.from_address,
      to: w.to_address,
      symbol: w.symbol,
      usd_value: w.usd_value,
      amount: w.amount,
      tx_type: w.tx_type,
      interesting_score: w.interesting_score ?? 0,
      detected_at: w.detected_at,
      signal: w.signal || null,
      headline: w.headline || null,
      confidence: w.confidence ?? null,
    })),
  };
}

// ─── /wallet/:addr endpoint ────────────────────────────────────────────

/**
 * Wallet profile: metadata from wallets table + recent whale txs involving
 * this address (as sender or receiver). Two queries, one round trip each.
 */
export async function walletProfile(env, address, chain = null) {
  const rawAddr = String(address || "").trim();
  const lowerAddr = rawAddr.toLowerCase();
  let sql = "SELECT address, chain, label, type, reputation, tx_count, total_volume, first_seen, last_seen FROM wallets WHERE address = ? OR lower(address) = ?";
  const binds = [rawAddr, lowerAddr];
  if (chain) { sql += " AND chain = ?"; binds.push(chain.toLowerCase()); }
  sql += " LIMIT 1";
  const profile = await env.DB.prepare(sql).bind(...binds).first();

  // Recent txs involving this wallet (as from or to), joined with analysis.
  const txs = await env.DB.prepare(
    "SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol, " +
    "w.usd_value, w.tx_type, w.detected_at, w.interesting_score, " +
    "a.signal, a.headline, a.confidence " +
    "FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id " +
    "WHERE (w.from_address = ? OR w.to_address = ? OR lower(w.from_address) = ? OR lower(w.to_address) = ?) " +
    (chain ? "AND w.chain = ? " : "") +
    "ORDER BY w.detected_at DESC LIMIT 20"
  ).bind(...(chain ? [rawAddr, rawAddr, lowerAddr, lowerAddr, chain.toLowerCase()] : [rawAddr, rawAddr, lowerAddr, lowerAddr])).all();

  return { profile, txs: txs?.results || [] };
}

/** Pure. Build the /wallet/:addr JSON payload. */
export function renderWalletJSON(profile, txs) {
  if (!profile) {
    return { ok: false, reason: "wallet not in database", address: null, txs: [] };
  }
  // BT8: EVM addresses are cased inconsistently between tables (checksummed
  // in wallets, lowercase in whales). Compare lowercased or in/out flips.
  const pAddr = String(profile.address || "").toLowerCase();
  return {
    ok: true,
    address: profile.address,
    chain: profile.chain,
    label: profile.label || null,
    type: profile.type || "unknown",
    reputation: profile.reputation || null,
    tx_count: profile.tx_count ?? 0,
    total_volume: profile.total_volume ?? 0,
    first_seen: profile.first_seen ?? null,
    last_seen: profile.last_seen ?? null,
    recent_txs: (txs || []).map((t) => {
      const isOut = String(t.from_address || "").toLowerCase() === pAddr;
      return {
        id: t.id,
        chain: (t.chain || "?").toUpperCase(),
        tx_hash: t.tx_hash,
        direction: isOut ? "out" : "in",
        counterpart: isOut ? t.to_address : t.from_address,
        amount: t.amount,
        symbol: t.symbol,
        usd_value: t.usd_value,
        tx_type: t.tx_type,
        detected_at: t.detected_at,
        interesting_score: t.interesting_score ?? 0,
        signal: t.signal || null,
        headline: t.headline || null,
        confidence: t.confidence ?? null,
      };
    }),
  };
}

// ─── event clustering ─────────────────────────────────────────────────

/**
 * Count other whale transfers to the same destination address on the same
 * chain within the last 15 minutes. One D1 read. Returns the count of
 * *other* whales (excludes the current one).
 */
export async function countCluster(env, toAddress, chain, detectedAt, currentWhaleId) {
  if (!toAddress || !chain || !detectedAt) return 0;
  const windowMs = 15 * 60 * 1000; // 15 min
  const since = detectedAt - windowMs;
  // Second-pass fix: EVM addresses are cased inconsistently, so compare
  // lowercased — otherwise same-address transfers are missed by the cluster.
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM whales " +
    "WHERE lower(to_address) = ? AND chain = ? AND detected_at >= ? AND detected_at <= ? AND id != ?"
  ).bind(String(toAddress).toLowerCase(), chain, since, detectedAt + windowMs, currentWhaleId).first();
  return row?.cnt || 0;
}

/**
 * Pure. Format a cluster note for the alert. Returns null if no cluster.
 * simple count prefix, no fancy grouping. Add temporal clustering
 * with multi-exchange correlation if volume warrants it.
 */
export function formatClusterNote(clusterCount) {
  if (!clusterCount || clusterCount < 1) return null;
  const total = clusterCount + 1;
  const s = total === 1 ? "" : "s";
  return `📦 ${total} whale transfer${s} to this address in the last 15 min`;
}

// ─── queue: deliver alerts to the public channel ──────────────────────

export async function queueHandler(batch, env) {
  for (const m of batch.messages) {
    try {
      let body;
      try {
        body = typeof m.body === "string" ? JSON.parse(m.body) : (m.body || {});
      } catch {
        body = {};
      }
      if (body.kind === "public_alert") {
        // Second-pass fix: a message with no whale_id can never succeed —
        // ack it instead of burning all max_retries on a poison message.
        if (body.whale_id == null) {
          console.warn("[bot] public_alert without whale_id — acking poison message");
        } else {
          await postPublicAlert(env, body.whale_id, body.chart_url || null);
        }
      } else {
        console.warn("[bot] unknown queue kind:", body.kind);
      }
      m.ack();
    } catch (e) {
      console.error("[bot] delivery failed:", e.message);
      m.retry();
    }
  }
}

async function postPublicAlert(env, whaleId, chartUrl = null) {
  const chatId = env.PUBLIC_CHANNEL;

  // BT2 — ATOMIC DELIVERED-CLAIM, FIRST, BEFORE ANY NETWORK I/O.
  // The old code did check → send → insert: if the Telegram post succeeded
  // but R2/GH threw (or a retry raced a concurrent batch), the delivered row
  // was never written and the alert posted twice. Now we INSERT OR IGNORE
  // first and only proceed when meta.changes === 1 (we won the claim).
  // A retry or concurrent invocation sees changes === 0 and skips — no
  // double-post, ever. Trade-off: this is at-most-once delivery. If the
  // Telegram send itself fails after the claim, the retry skips the alert
  // instead of risking a duplicate; a rare miss beats a duplicate on a
  // public channel. (delivered PK is (whale_id, chat_id) — the IGNORE is
  // the claim.)
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO delivered (whale_id, chat_id, delivered_at) VALUES (?, ?, ?)"
  ).bind(whaleId, chatId, Date.now()).run();
  if (!claim || claim.meta?.changes !== 1) {
    console.log(`[bot] whale ${whaleId} already claimed/delivered to ${chatId} — skipping`);
    return;
  }

  // Load whale + analysis (incl. whale-intelligence fields)
  const whale = await env.DB.prepare(
    `SELECT w.*, a.headline, a.interpretation, a.signal, a.confidence, a.related_factor,
            a.motive, a.motive_confidence, a.catalyst_title, a.catalyst_url, a.ta_summary,
            a.causal_chain, a.regime
     FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id
     WHERE w.id = ?`
  ).bind(whaleId).first();
  if (!whale) throw new Error(`whale ${whaleId} not found`);
  if (!whale.analysis_status || whale.analysis_status === "failed") {
    throw new Error(`whale ${whaleId} analysis not done (status=${whale.analysis_status})`);
  }

  let market = null;
  try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}

  // Event clustering: count other whales to the same destination in the last 15 min.
  const clusterCount = await countCluster(env, whale.to_address, whale.chain, whale.detected_at, whaleId);
  const clusterNote = formatClusterNote(clusterCount);

  let text = formatAlert(whale, {
    headline: whale.headline,
    interpretation: whale.interpretation,
    signal: whale.signal,
    confidence: whale.confidence,
    related_factor: whale.related_factor,
    motive: whale.motive,
    motive_confidence: whale.motive_confidence,
    catalyst_title: whale.catalyst_title,
    catalyst_url: whale.catalyst_url,
    ta_summary: whale.ta_summary,
  }, market);
  if (clusterNote) text = clusterNote + "\n" + text;

  // BT3+BT4: plain text (parse_mode omitted), truncated to Telegram's limit.
  // Whale-intelligence: send the price chart as a photo when available;
  // fall back to a text message if the photo send fails.
  const caption = truncateTelegram(text, 1024); // Telegram photo caption limit
  if (chartUrl) {
    try {
      await tgSendPhoto(env.BOT_TOKEN, chatId, chartUrl, caption);
    } catch (e) {
      console.warn(`[bot] sendPhoto failed, falling back to text:`, e.message);
      await tgSendMessage(env.BOT_TOKEN, chatId, truncateTelegram(text));
    }
  } else {
    await tgSendMessage(env.BOT_TOKEN, chatId, truncateTelegram(text));
  }

  // Content studio: cache the brief in KV so /content/queue works even
  // when D1 is down (and faster anyway). Keep last 10.
  try {
    const brief = buildContentBrief(whale, {
      motive: whale.motive, signal: whale.signal, confidence: whale.confidence,
    });
    const raw = await env.KV.get("content_briefs");
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(brief);
    await env.KV.put("content_briefs", JSON.stringify(list.slice(0, 10)), { expirationTtl: 86400 });
  } catch (e) {
    console.warn("[bot] brief KV cache failed:", e.message);
  }

  // R2 export for the Python trading loop (trading_loop.py polls this).
  // postAlertToR2 swallows its own errors (BT5) — a failed export can never
  // trigger a repost now that the delivered row is claimed up front.
  const alertJSON = buildAlertJSON(whale, market);
  if (alertJSON) await postAlertToR2(env, alertJSON);

  // Fire GitHub Actions (triggers trade.yml via repository_dispatch)
  if (alertJSON) await fireGitHubDispatch(env, alertJSON);
}

// ─── default export (entry) ──────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      return await fetchHandler(request, env, ctx);
    } catch (e) {
      console.error("[bot] uncaught:", e.message);
      return errJson("internal", 500);
    }
  },
  async queue(batch, env) {
    try {
      return await queueHandler(batch, env);
    } catch (e) {
      console.error("[bot] queue uncaught:", e.message);
      return;
    }
  },
};
