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
  lines.push(`📍 ${whale.chain} → ${toShort}${analysis?.related_factor ? "" : ""}`);
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
        const reply = await latestReply(env);
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

/** Build the /latest reply from D1 + KV. Pure-ish (DB read only). */
export async function latestReply(env) {
  const { results } = await env.DB.prepare(
    "SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol, w.usd_value, w.tx_type, w.block_number, w.detected_at, a.headline, a.interpretation, a.signal, a.confidence, a.related_factor FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id WHERE w.analysis_status = 'done' ORDER BY w.detected_at DESC LIMIT 5"
  ).all();
  if (!results || results.length === 0) {
    return "No whale moves posted yet. The scanner cron just kicked off — check back in a minute.";
  }
  let market = null;
  try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
  const blocks = results.map((w) => {
    const sig = (w.signal || "—").toLowerCase();
    const emoji = sig === "bullish" ? "🟢" : sig === "bearish" ? "🔴" : "⚪";
    return `${emoji} ${fmtUSD(w.usd_value)} ${w.symbol} ${w.chain} — ${w.headline || "(no headline)"}\n  ${shortAddr(w.from_address)} → ${shortAddr(w.to_address)}`;
  });
  return ["🐋 Latest whale moves:", "", ...blocks].join("\n");
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
