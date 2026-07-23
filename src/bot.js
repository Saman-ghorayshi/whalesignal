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

import { okJson, errJson, rateLimited, tgSendMessage, fmtUSD, shortAddr, mdEscape, nowMs } from "./worker-utils.js";

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
 * ponytail: read-modify-write on the whole file, not a per-alert key. One file
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
  await env.ALERTS_R2.put(key, existing + ndjsonLine);
}

// ─── GitHub Actions trigger (repository_dispatch) ────────────────────

/**
 * Fire a repository_dispatch event to GitHub Actions.
 * This triggers the trade.yml workflow in the whalesignal repo.
 *
 * Requires env.GH_PAT (GitHub Personal Access Token, repo scope) and
 * env.GH_REPO (e.g. "samsha/whalesignal"). Both set as CF Worker secrets.
 *
 * Fire-and-forget: if the POST fails, we log but don't throw — the alert
 * is already posted to Telegram and R2. The trading loop will pick it up
 * on the next manual or scheduled GH Actions run anyway.
 */
export async function fireGitHubDispatch(env, alertJSON) {
  if (!env.GH_PAT || !env.GH_REPO) return; // not configured — skip
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${env.GH_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
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

  const explorerBase = opts.explorerBase || (whale.chain === "btc"
    ? "https://blockchain.com/tx/"
    : "https://etherscan.io/tx/");
  const explorerLink = `${explorerBase}${whale.tx_hash}`;

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
  if (analysis?.headline || analysis?.interpretation) {
    lines.push("🧠 AI Analysis:");
    if (analysis.headline) lines.push(analysis.headline);
    if (analysis.interpretation) lines.push(analysis.interpretation);
    lines.push("");
  } else {
    lines.push("🧠 AI Analysis: (pending)");
    lines.push("");
  }
  lines.push(`📊 Market: BTC ${btcP} (${btcChg}) | ${fg} | ETH ${ethP}`);
  lines.push(`🔮 Signal: ${sigEmoji} (confidence ${conf})`);
  if (analysis?.related_factor) lines.push(`📎 ${analysis.related_factor}`);
  lines.push("");
  lines.push(`🔍 ${explorerLink}`);
  return lines.join("\n");
}

const TX_TYPE_LABEL = {
  exchange_inflow: "→ exchange (likely sell)",
  exchange_outflow: "← exchange (likely withdraw)",
  exchange_internal: "↔ exchange-to-exchange",
  wallet_to_wallet: "↔ wallet to wallet",
  unknown: "wallet move",
};

// ─── fetch (Telegram webhook) ─────────────────────────────────────────

export async function fetchHandler(request, env, ctx) {
  // Simple secret-path check. Telegram also signs updates, but on free tier
  // and a side project a secret path is enough. Plan says /tg/<bot_token>
  // is what we tell Telegram as the webhook URL — that token in the URL is
  // only known to Telegram.
  const url = new URL(request.url);
  const path = url.pathname;

  // ─── public GET /latest?limit=N  (Phase 3 of ship runbook) ───────────
  // ponytail: NO auth. The alert row carries no secret — it's the same
  // content the bot posts to a public Telegram channel. Read-only, CORS
  // open so the github.io demo page can fetch() it cross-origin.
  if (request.method === "GET" && path === "/latest") {
    const limit = url.searchParams.get("limit") || 1;
    try {
      const rows = await latestRows(env, limit);
      let market = null;
      try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
      const payload = renderLatestJSON(rows, market);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",  // github.io lives on a different origin
          "Cache-Control": "no-cache",         // always fresh; the demo polls 30s
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, reason: "db_error", error: e.message }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  const expected = `/tg/${env.BOT_TOKEN || ""}`;
  if (path !== expected) {
    return errJson("not found", 404);
  }

  if (request.method !== "POST") {
    // Telegram GETs the webhook for setup — return ok so it doesn't error.
    return okJson({ ok: true, service: "whalesignal-bot" });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return errJson("invalid json", 400);
  }

  // DM commands. Phase 1 has /ping, /help, /latest.
  //
  // NOTE: we send the reply synchronously inside the webhook request here.
  // Telegram's webhook timeout is generous (~60s) and our sendMessage has an
  // 8s AbortController cap, so this is fine for Phase 1. Phase 2 should switch
  // to `ctx.waitUntil(tgSendMessage(...))` and return 200 immediately so we
  // don't hold the request open for slow /latest queries.
  const msg = update.message || update.channel_post;
  if (msg?.text) {
    const chatId = String(msg.chat.id);
    const from = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || "friend");
    const txt = msg.text.trim();
    const lc = txt.toLowerCase();

    try {
      if (lc === "/ping") {
        await tgSendMessage(env.BOT_TOKEN, chatId,
          `🐋 WhaleSignal is alive. Ping received from ${from} at ${new Date().toISOString()}.`);
        return okJson({ ok: true, handled: "ping" });
      }
      if (lc === "/help" || lc === "/start") {
        await tgSendMessage(env.BOT_TOKEN, chatId, HELP_TEXT);
        return okJson({ ok: true, handled: "help" });
      }
      if (lc === "/latest") {
        // ponytail: DM reply keeps 5-row behavior. Shared helper, limit=5.
        const rows = await latestRows(env, 5);
        let market = null;
        try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
        const reply = renderLatestReply(rows, market);
        await tgSendMessage(env.BOT_TOKEN, chatId, reply);
        return okJson({ ok: true, handled: "latest" });
      }
      // unknown
      await tgSendMessage(env.BOT_TOKEN, chatId,
        `I don't know that command yet. Try /help, /ping, or /latest.`);
      return okJson({ ok: true, handled: "unknown" });
    } catch (e) {
      console.error("bot fetch handler failed:", e.message);
      return errJson("tg error: " + e.message, 502);
    }
  }

  // acknowledgment of non-message updates (inline, callbacks, edits)
  return okJson({ ok: true, handled: "noop" });
}

const HELP_TEXT = `🐋 WhaleSignal — AI whale alerts

Phase 1 (MVP). Commands:
  /ping    — health check
  /help    — this message
  /latest  — recently posted whale moves

We post AI-enhanced whale alerts to our channel. Real-time DMs come in Phase 2.
Got a suggestion? Reply to this message.`;

// ─── /latest helper (shared by DM /latest and GET /latest route) ───────

/**
 * Pull the N most-recent analyzed whales rows joined with their analysis.
 * Pure-ish (DB read only). Returns an array of row objects.
 *
 * ponytail: ONE query shape, used by both the Telegram DM /latest reply
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

// ─── queue: deliver alerts to the public channel ──────────────────────

export async function queueHandler(batch, env) {
  for (const m of batch.messages) {
    try {
      let body;
      try { body = JSON.parse(m.body); } catch { body = {}; }
      if (body.kind === "public_alert") {
        await postPublicAlert(env, body.whale_id);
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

async function postPublicAlert(env, whaleId) {
  // Load whale + analysis
  const whale = await env.DB.prepare(
    `SELECT w.*, a.headline, a.interpretation, a.signal, a.confidence, a.related_factor
     FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id
     WHERE w.id = ?`
  ).bind(whaleId).first();
  if (!whale) throw new Error(`whale ${whaleId} not found`);
  if (!whale.analysis_status || whale.analysis_status === "failed") {
    throw new Error(`whale ${whaleId} analysis not done (status=${whale.analysis_status})`);
  }

  // dedupe per channel — Queues guarantee at-least-once, so re-delivery happens
  const chatId = env.PUBLIC_CHANNEL;
  const existing = await env.DB.prepare(
    "SELECT 1 FROM delivered WHERE whale_id = ? AND chat_id = ?"
  ).bind(whaleId, chatId).first();
  if (existing) {
    console.log(`[bot] whale ${whaleId} already delivered to ${chatId} — skipping`);
    return;
  }

  let market = null;
  try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}

  const text = formatAlert(whale, {
    headline: whale.headline,
    interpretation: whale.interpretation,
    signal: whale.signal,
    confidence: whale.confidence,
    related_factor: whale.related_factor,
  }, market);

  await tgSendMessage(env.BOT_TOKEN, chatId, text, { parse_mode: "" /* plain text */ });

  // R2 export for the Python trading loop (trading_loop.py polls this)
  const alertJSON = buildAlertJSON(whale, market);
  if (alertJSON) await postAlertToR2(env, alertJSON);

  // Fire GitHub Actions (triggers trade.yml via repository_dispatch)
  if (alertJSON) await fireGitHubDispatch(env, alertJSON);

  await env.DB.prepare(
    "INSERT OR IGNORE INTO delivered (whale_id, chat_id, delivered_at) VALUES (?, ?, ?)"
  ).bind(whaleId, chatId, Date.now()).run();
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
