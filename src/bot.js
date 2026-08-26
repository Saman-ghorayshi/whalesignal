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

/** shared JSON response helper for all public GET routes. */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    },
  });
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
  // relevance tier: 🔥 high-context alerts get promoted, 💤 plumbing gets
  // visibly muted. medium/missing keeps the classic line untouched.
  const rel = (analysis?.context_relevance || "medium").toLowerCase();
  let signalLine = `🔮 Signal: ${sigEmoji} (confidence ${conf})`;
  if (rel === "high") signalLine = `🔥 ${signalLine}`;
  else if (rel === "low") signalLine = `${signalLine} · 💤`;

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
  lines.push(signalLine);
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
  mint: "✨ newly minted",
  burn: "🔥 burned",
  bridge_flow: "🌉 cross-chain bridge",
  miner_flow: "⛏️ miner wallet move",
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
  // NO auth. The alert row carries no secret — it's the same
  // content the bot posts to a public Telegram channel. Read-only, CORS
  // open so the github.io demo page can fetch() it cross-origin.
  if (request.method === "GET" && path === "/latest") {
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
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
        },
      });
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
      const rows = await historyRows(env, opts);
      const payload = renderHistoryJSON(rows, opts.page, opts.limit, rows.length);
      return jsonResponse(payload);
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
        // DM reply keeps 5-row behavior. Shared helper, limit=5.
        const rows = await latestRows(env, 5);
        let market = null;
        try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
        const reply = renderLatestReply(rows, market);
        await tgSendMessage(env.BOT_TOKEN, chatId, reply);
        return okJson({ ok: true, handled: "latest" });
      }
      if (lc === "/id") {
        // diagnostics: shows the numeric ids the bot actually sees, so
        // ADMIN_CHAT_ID mismatches stop being guesswork
        await tgSendMessage(env.BOT_TOKEN, chatId,
          `chat.id: ${msg.chat?.id ?? "?"}\nfrom.id: ${msg.from?.id ?? "(none — channel post?)"}\n\nDM the bot directly; channel posts have no from.id.`);
        return okJson({ ok: true, handled: "id" });
      }
      if (lc === "/stats") {
        // Admin-only. Non-admins get the generic unknown-command reply so
        // the command's existence isn't advertised.
        if (!isAdmin(msg, env.ADMIN_CHAT_ID)) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            `I don't know that command yet. Try /help, /ping, or /latest.`);
          return okJson({ ok: true, handled: "unknown" });
        }
        const stats = await statsRows(env);
        await tgSendMessage(env.BOT_TOKEN, chatId, renderAdminStats(stats));
        return okJson({ ok: true, handled: "admin_stats" });
      }
      if (lc === "/keys" || lc.startsWith("/setkey ") || lc.startsWith("/delkey ")) {
        // Admin-only key management. Values live in KV; workers read env
        // first and fall back to KV, so a set here survives without deploys.
        if (!isAdmin(msg, env.ADMIN_CHAT_ID)) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            `I don't know that command yet. Try /help, /ping, or /latest.`);
          return okJson({ ok: true, handled: "unknown" });
        }
        if (lc === "/keys") {
          const status = {
            env_gemini: !!env.GEMINI_KEY,
            kv_gemini: await env.KV.get(kvKeyName("gemini")),
            env_news: !!env.NEWS_TOKEN,
            kv_news: await env.KV.get(kvKeyName("news")),
          };
          await tgSendMessage(env.BOT_TOKEN, chatId, renderKeyStatus(status));
          return okJson({ ok: true, handled: "admin_keys" });
        }
        const parsed = parseKeyCommand(txt);
        if (!parsed) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            "usage: /setkey gemini|news <value>   or   /delkey gemini|news");
          return okJson({ ok: true, handled: "admin_keys_usage" });
        }
        if (parsed.op === "set") {
          await env.KV.put(kvKeyName(parsed.name), parsed.value);
          await tgSendMessage(env.BOT_TOKEN, chatId,
            `✓ ${parsed.name} key stored (${maskValue(parsed.value)}). Workers pick it up on the next read.`);
        } else {
          await env.KV.delete(kvKeyName(parsed.name));
          await tgSendMessage(env.BOT_TOKEN, chatId, `✓ ${parsed.name} key deleted from KV.`);
        }
        return okJson({ ok: true, handled: "admin_key_" + parsed.op });
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

// ─── admin gating (Phase 2 preview — full panel comes with the admin worker) ──

/**
 * Pure: is this Telegram update from the configured admin?
 * Compares numeric from.id against ADMIN_CHAT_ID (stored as a string secret).
 * No ADMIN_CHAT_ID configured → nobody is admin.
 */
export function isAdmin(msg, adminChatId) {
  if (!adminChatId || !msg?.from?.id) return false;
  return String(msg.from.id) === String(adminChatId);
}

/**
 * Pure: format statsRows() output into a compact admin status message.
 * Separate from renderStatsJSON (HTTP shape) — this one reads like a DM.
 */
export function renderAdminStats(stats) {
  const s = stats || {};
  const total = s.total_whales || 0;
  const accTotal = s.accuracy_total || 0;
  const accCorrect = s.accuracy_correct || 0;
  const accRate = accTotal > 0 ? `${Math.round((accCorrect / accTotal) * 100)}%` : "n/a";
  const lines = [
    "📊 WhaleSignal admin stats",
    `Whales: ${total} total | ${s.count_24h ?? 0} last 24h | ${s.count_7d ?? 0} last 7d`,
    `Volume: ${fmtUSD(s.total_volume || 0)} | Largest: ${fmtUSD(s.largest_transfer || 0)}`,
    `Signals: 🟢 ${s.bullish || 0} · 🔴 ${s.bearish || 0} · ⚪ ${s.neutral || 0}`,
    `Accuracy: ${accRate} (${accCorrect}/${accTotal} evaluated)`,
  ];
  return lines.join("\n");
}

// ─── admin key management (rotate API keys from the DM, no redeploy) ────────

// KV-backed keys workers can pick up at runtime. Whitelist keeps /setkey from
// becoming an arbitrary-write primitive.
const MANAGEABLE_KEYS = new Set(["gemini", "news", "model"]);
const kvKeyName = (name) => (name === "model" ? "config:model" : `key:${name}`);
const maskValue = (v) => (v && v.length > 6 ? `…${String(v).slice(-4)} (${String(v).length} chars)` : "(set)");

/**
 * Pure: parse "/setkey <name> <value>" / "/delkey <name>".
 * Returns {op, name, value?} or null when malformed or not whitelisted.
 */
export function parseKeyCommand(text) {
  let m = /^\/setkey\s+(\S+)\s+([\s\S]+)$/.exec(String(text || "").trim());
  if (m) {
    const name = m[1].toLowerCase();
    return MANAGEABLE_KEYS.has(name) ? { op: "set", name, value: m[2].trim() } : null;
  }
  m = /^\/delkey\s+(\S+)$/.exec(String(text || "").trim());
  if (m) {
    const name = m[1].toLowerCase();
    return MANAGEABLE_KEYS.has(name) ? { op: "del", name } : null;
  }
  return null;
}

/**
 * Pure: build the /keys status message.
 * @param {{env_gemini:boolean, kv_gemini:string|null, env_news:boolean, kv_news:string|null}} s
 */
export function renderKeyStatus(s) {
  const fmt = (fromEnv, kvVal) => {
    if (kvVal) return "KV " + maskValue(kvVal);
    if (fromEnv) return "worker secret ✓";
    return "— missing —";
  };
  return [
    "🔑 key status",
    `gemini: ${fmt(s.env_gemini, s.kv_gemini)}`,
    `news:   ${fmt(s.env_news, s.kv_news)}`,
  ].join("\n");
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
 * Paginated history query. Filters: chain, symbol, signal, min_usd.
 * Sort: detected_at DESC. Returns joined whale+analysis rows.
 */
export async function historyRows(env, opts = {}) {
  const { page = 1, limit = 20, chain = null, symbol = null, signal = null, min_usd = null } = opts;
  const n = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
  const offset = Math.max(0, (Math.trunc(Number(page) || 1) - 1) * n);

  let sql = "SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol, " +
    "w.usd_value, w.tx_type, w.block_number, w.detected_at, w.interesting_score, " +
    "a.headline, a.interpretation, a.signal, a.confidence, a.related_factor " +
    "FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id " +
    "WHERE w.analysis_status IN ('done', 'skipped')";
  const binds = [];
  if (chain) { sql += " AND w.chain = ?"; binds.push(chain.toLowerCase()); }
  if (symbol) { sql += " AND w.symbol = ?"; binds.push(symbol.toUpperCase()); }
  if (signal) { sql += " AND a.signal = ?"; binds.push(signal.toLowerCase()); }
  if (min_usd) { sql += " AND w.usd_value >= ?"; binds.push(Number(min_usd)); }
  sql += " ORDER BY w.detected_at DESC LIMIT ? OFFSET ?";
  binds.push(n, offset);

  const stmt = env.DB.prepare(sql);
  for (let i = 0; i < binds.length; i++) stmt.bind(binds[i]);
  const { results } = await stmt.all();
  return results || [];
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
  const addr = String(address || "").toLowerCase();
  let sql = "SELECT address, chain, label, type, reputation, tx_count, total_volume, first_seen, last_seen FROM wallets WHERE address = ?";
  const binds = [addr];
  if (chain) { sql += " AND chain = ?"; binds.push(chain.toLowerCase()); }
  sql += " LIMIT 1";
  const profile = await env.DB.prepare(sql).bind(...binds).first();

  // Recent txs involving this wallet (as from or to), joined with analysis.
  const txs = await env.DB.prepare(
    "SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol, " +
    "w.usd_value, w.tx_type, w.detected_at, w.interesting_score, " +
    "a.signal, a.headline, a.confidence " +
    "FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id " +
    "WHERE (w.from_address = ? OR w.to_address = ?) " +
    (chain ? "AND w.chain = ? " : "") +
    "ORDER BY w.detected_at DESC LIMIT 20"
  ).bind(chain ? [addr, addr, chain.toLowerCase()] : [addr, addr]).all();

  return { profile, txs: txs?.results || [] };
}

/** Pure. Build the /wallet/:addr JSON payload. */
export function renderWalletJSON(profile, txs) {
  if (!profile) {
    return { ok: false, reason: "wallet not in database", address: null, txs: [] };
  }
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
    recent_txs: (txs || []).map((t) => ({
      id: t.id,
      chain: (t.chain || "?").toUpperCase(),
      tx_hash: t.tx_hash,
      direction: t.from_address === profile.address ? "out" : "in",
      counterpart: t.from_address === profile.address ? t.to_address : t.from_address,
      amount: t.amount,
      symbol: t.symbol,
      usd_value: t.usd_value,
      tx_type: t.tx_type,
      detected_at: t.detected_at,
      interesting_score: t.interesting_score ?? 0,
      signal: t.signal || null,
      headline: t.headline || null,
      confidence: t.confidence ?? null,
    })),
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
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM whales " +
    "WHERE to_address = ? AND chain = ? AND detected_at >= ? AND detected_at <= ? AND id != ?"
  ).bind(toAddress, chain, since, detectedAt + windowMs, currentWhaleId).first();
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
      try { body = JSON.parse(m.body); } catch { body = {}; }
      if (body.kind === "public_alert") {
        // kill switch: skip public delivery when the admin panel paused us
        let paused = {};
        try { paused = JSON.parse(await env.KV.get("config:paused") || "{}"); } catch {}
        let chainOfWhale = null;
        try {
          const w = await env.DB.prepare("SELECT chain FROM whales WHERE id = ?").bind(body.whale_id).first();
          chainOfWhale = w?.chain ?? null;
        } catch {}
        if (paused.global || (chainOfWhale && paused[chainOfWhale])) {
          console.warn(`[bot] paused via admin — suppressing alert ${body.whale_id}`);
          m.ack();
          continue;
        }
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

  // Event clustering: count other whales to the same destination in the last 15 min.
  const clusterCount = await countCluster(env, whale.to_address, whale.chain, whale.detected_at, whaleId);
  const clusterNote = formatClusterNote(clusterCount);

  let text = formatAlert(whale, {
    headline: whale.headline,
    interpretation: whale.interpretation,
    signal: whale.signal,
    confidence: whale.confidence,
    related_factor: whale.related_factor,
  }, market);
  if (clusterNote) text = clusterNote + "\n" + text;

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
