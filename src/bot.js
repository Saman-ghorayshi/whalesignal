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
import { taSnapshot } from "./ta.js";
import { volSpikeClass } from "./worker-utils.js";

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

// Published vol-spike rates (config:vol_spikes, written by the laptop
// research loop) — isolate-cached 5 min. Missing → no field, honest.
let volSpikeCache = { rates: null, ts: 0 };
async function getVolSpikeRates(env) {
  if (volSpikeCache.rates && Date.now() - volSpikeCache.ts < 300_000) return volSpikeCache.rates;
  try { volSpikeCache.rates = JSON.parse(await env.KV.get("config:vol_spikes") || "null"); } catch { volSpikeCache.rates = null; }
  volSpikeCache.ts = Date.now();
  return volSpikeCache.rates;
}

// ─── alert formatting (pure, testable) ────────────────────────────────

/**
 * Pure. Match cached headlines against this whale's asset + flow direction —
 * the cheap, LLM-free answer to "why did the whale move?". A headline must
 * mention the asset AND a directionally-relevant keyword; anything else
 * would be noise dressed up as context.
 */
export function relatedHeadlines(news, symbol, txType, max = 2) {
  if (!Array.isArray(news) || !news.length || !symbol) return [];
  const sym = String(symbol).toUpperCase();
  const assetKw = {
    BTC: /\b(bitcoin|btc|etf|halving|mining|miner)\b/i,
    ETH: /\b(ethereum|ether|eth|staking)\b/i,
    USDT: /\b(tether|usdt|stablecoin|depeg)\b/i,
    USDC: /\b(usdc|circle|stablecoin|depeg)\b/i,
  }[sym] || new RegExp(`\\b${sym.toLowerCase()}\\b`, "i");
  // deposits sell, withdrawals accumulate — headlines that plausibly explain
  // the DIRECTION, not just the asset
  const flowKw = txType === "exchange_inflow"
    ? /\b(sell|dump|profit|outflow|deposit|withdrawal halt|hack|exploit|lawsuit|sec|ban|fear|crash|liquidat)/i
    : txType === "exchange_outflow"
      ? /\b(buy|accumulate|inflow|custody|self-custody|reserve proof|adoption|treasury|stash|cold wallet)/i
      : /./;
  const hits = [];
  for (const n of news) {
    const title = n?.title || "";
    if (assetKw.test(title) && flowKw.test(title)) hits.push(title);
    if (hits.length >= max) break;
  }
  return hits;
}

/**
 * Format a whale + its analysis into the channel alert text. Pure.
 *
 * @param {object} whale — whales row
 *   {chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, block_time, detected_at}
 * @param {object|null} analysis — analysis row
 *   {headline, interpretation, signal, confidence, related_factor}
 * @param {object|null} market — KV market_cache (for the footer)
 * @param {object} opts — { explorerBase, related: string[] — matched headlines }
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
  // "why did the whale move?" — matched headlines, only when they exist
  if (Array.isArray(opts.related) && opts.related.length) {
    lines.push("📰 Related headlines:");
    for (const t of opts.related) lines.push(`• ${t}`);
    lines.push("");
  }
  // Herremans-style direction-agnostic signal: historical odds that this
  // flow class precedes a >=2% dailyized vol move
  if (opts.volSpike != null) {
    lines.push(`⚡ Vol-spike odds for this flow class: ~${opts.volSpike}% (historical)`);
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

// ─── D1 payload cache (read-budget survival) ──────────────────────────
//
// /stats, /netflow and /graph each full-scan the whales table. One dashboard
// visitor polling /stats every 60s burns ~200K D1 row reads/hour — the entire
// free-tier daily cap (5M) in under a day, after which EVERY D1 read on the
// account 500s until midnight UTC. stats_cache collapses that to 1 row per
// request: first caller in a TTL window pays the scan, everyone else reads
// one cached payload. When the read cap IS hit, the last cached payload is
// still served (stale) instead of 500ing the dashboard.
const CACHE_TTL_MS = 180_000; // 3 min → ≤480 cache writes/day, well under caps

// Cache-key explosion guard: the cache key includes the query params, so a
// scripted client could request window=1,2,3…720 and force a fresh full scan
// per value. Quantize params to fixed tiers — the key space stays tiny and
// every "weird" request simply snaps to the nearest tier we already serve.
const NETFLOW_WINDOWS = [24, 72, 168, 720];
export function quantizeWindow(h) {
  const n = Math.max(1, Math.min(720, Math.trunc(Number(h) || 24)));
  let best = NETFLOW_WINDOWS[0];
  for (const w of NETFLOW_WINDOWS) {
    if (Math.abs(w - n) < Math.abs(best - n)) best = w;
  }
  return best;
}

const MIN_USD_TIERS = [0, 1_000_000, 5_000_000, 10_000_000, 50_000_000];
const LIMIT_TIERS = [10, 30, 50, 100, 150];
function nearestTier(v, tiers) {
  const n = Math.max(tiers[0], Math.min(tiers[tiers.length - 1], Math.trunc(Number(v) || 0)));
  let best = tiers[0];
  for (const t of tiers) if (Math.abs(t - n) < Math.abs(best - n)) best = t;
  return best;
}
export function quantizeGraphParams(minUsd, limit) {
  return { minUsd: nearestTier(minUsd, MIN_USD_TIERS), limit: nearestTier(limit, LIMIT_TIERS) };
}

export async function cachedPayload(env, key, compute, ttlMs = CACHE_TTL_MS) {
  let cachedRow = null;
  try {
    cachedRow = await env.DB.prepare(
      "SELECT payload, updated_at FROM stats_cache WHERE k = ?"
    ).bind(key).first();
  } catch { /* cache table missing — compute directly */ }
  if (cachedRow && Date.now() - cachedRow.updated_at < ttlMs) {
    return JSON.parse(cachedRow.payload);
  }
  try {
    const payload = await compute();
    try {
      await env.DB.prepare(
        `INSERT INTO stats_cache (k, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(k) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).bind(key, JSON.stringify(payload), Date.now()).run();
    } catch { /* caching is best-effort */ }
    return payload;
  } catch (e) {
    if (cachedRow) return JSON.parse(cachedRow.payload); // degrade to stale, not 500
    throw e;
  }
}

// ─── premium subscriptions via cryptopay (pull-based) ────────────────
//
// Only activates when CRYPTOPAY_URL + PAY_SECRET secrets exist on the bot
// worker. Until then /premium stays in waitlist mode — graceful degradation.
// REQUIRES a matching "whalesignal_premium" package in cryptopay's PRICING
// config (price_usd: 10) — /verify looks the package up there.
const PREMIUM_PRICE_USD = 10;
const PREMIUM_DAYS = 30;

function cryptopayConfigured(env) {
  return !!(env.CRYPTOPAY_URL && env.PAY_SECRET);
}

async function cryptopayCall(env, path, body) {
  const payload = JSON.stringify(body);
  const headers = { "content-type": "application/json", "X-Pay-Secret": env.PAY_SECRET };
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 8000);
  try {
    let res;
    if (env.CRYPTOPAY) {
      // service binding: worker-to-worker, no public URL involved
      res = await env.CRYPTOPAY.fetch("https://cryptopay" + path, { method: "POST", headers, body: payload });
    } else {
      res = await fetch(env.CRYPTOPAY_URL + path, { method: "POST", headers, body: payload, signal: ctl.signal });
    }
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

async function isActiveSubscriber(env, chatId) {
  try {
    const row = await env.DB.prepare(
      "SELECT 1 FROM subscribers WHERE chat_id = ? AND status = 'active' AND expires_at > ?"
    ).bind(chatId, Date.now()).first();
    return !!row;
  } catch { return false; }
}

async function handlePremiumPayment(env, chatId, txid) {
  const result = await cryptopayCall(env, "/verify", {
    txid, user_id: parseInt(chatId, 10) || 0,
    pkg: "whalesignal_premium",
    idempotency_key: "ws-prem-" + txid.slice(0, 40),
  });
  if (!result.ok || !result.verified) {
    return "❌ Payment not verified yet. If the transaction just landed, try again in a few minutes (confirmations take time).";
  }
  const now = Date.now();
  const periodEnd = now + PREMIUM_DAYS * 86_400_000;
  // renewal extends from the LATER of (remaining expiry, now); a fresh
  // subscriber gets exactly 30 days — the old MAX()+30d formula handed
  // first-timers a accidental 60-day term.
  await env.DB.prepare(
    `INSERT INTO subscribers (chat_id, plan, txid, status, expires_at, created_at, updated_at)
     VALUES (?, 'premium', ?, 'active', ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       status = 'active', txid = excluded.txid, updated_at = excluded.updated_at,
       expires_at = CASE
         WHEN subscribers.status = 'active' AND subscribers.expires_at > ?2
           THEN subscribers.expires_at + ${PREMIUM_DAYS} * 86400000
         ELSE ?2 END`
  ).bind(chatId, txid, periodEnd, now, now, now).run();
  return "✅ Premium active for 30 days. You now receive every directional alert instantly by DM — before the channel, before clustering.";
}

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
      const payload = await cachedPayload(env, "stats:v1", async () => {
        const stats = await statsRows(env);
        const bySymbol = await statsBySymbol(env);
        const hourly = await statsHourly(env);
        let market = null;
        try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
        return renderStatsJSON(stats, bySymbol, hourly, market);
      });
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
      const { profile, txs, flow, counterparties, track } = await walletProfile(env, addr, chain);
      const payload = renderWalletJSON(profile, txs, flow, counterparties, track);
      return jsonResponse(payload, profile ? 200 : 404);
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /netflow?window=24&chain=btc — exchange netflow index ──
  // The aggregate bullish/bearish meter: USD flowing INTO exchanges (sell-
  // side supply) minus OUT (self-custody accumulation) over a window.
  if (request.method === "GET" && path === "/netflow") {
    try {
      const windowHours = quantizeWindow(url.searchParams.get("window"));
      const chainParam = url.searchParams.get("chain");
      const chain = chainParam ? String(chainParam).toLowerCase() : null;
      const payload = await cachedPayload(env, `netflow:v1:${windowHours}:${chain || "all"}`, async () => {
        const since = Date.now() - windowHours * 3600_000;
        const totals = await netflowTotals(env, since, chain);
        const perExchange = await netflowByExchange(env, since, chain);
        const baseline = await netflowBaseline(env, chain);
        const stableCtx = await stablecoinContext(env);
        return renderNetflowJSON(totals, perExchange, windowHours, chain, baseline, stableCtx);
      });
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

  // ─── public GET /graph?chain=btc&window=24&min_usd=&limit= — flow graph ──
  // Aggregated whale flow edges for the dashboard's network view.
  if (request.method === "GET" && path === "/graph") {
    try {
      const windowHours = quantizeWindow(url.searchParams.get("window"));
      const chainParam = url.searchParams.get("chain");
      const chain = chainParam ? String(chainParam).toLowerCase() : null;
      const q = quantizeGraphParams(url.searchParams.get("min_usd"), url.searchParams.get("limit"));
      const minUsd = q.minUsd;
      const limit = q.limit;
      const payload = await cachedPayload(env, `graph:v1:${windowHours}:${chain || "all"}:${minUsd}:${limit}`, async () => {
        const since = Date.now() - windowHours * 3600_000;
        const edges = await graphEdges(env, { since, chain, minUsd, limit });
        // labels only for the addresses actually in the edge set (chunked) —
        // the old full-table read scaled with wallets table growth
        const addrs = [...new Set(edges.flatMap((e) => [e.from_address, e.to_address]).filter(Boolean))];
        const walletRows = [];
        for (let i = 0; i < addrs.length; i += 80) {
          const chunk = addrs.slice(i, i + 80);
          const variants = chunk.flatMap((c) => [c, String(c).toLowerCase()]);
          const r = await env.DB.prepare(
            "SELECT address, chain, label, type FROM wallets WHERE address IN (" + variants.map(() => "?").join(",") + ")"
          ).bind(...variants).all();
          walletRows.push(...(r?.results || []));
        }
        return renderGraphJSON(edges, walletRows, { windowHours, chain, minUsd });
      });
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

  // ─── public GET /health — component status for ops ─────────────────
  if (request.method === "GET" && path === "/health") {
    try {
      const payload = await cachedPayload(env, "health:v1", async () => {
        const out = { ok: true, generated_at: Date.now(), components: {} };
        try {
          const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM counters").first();
          out.components.d1 = { ok: true, counters: c?.n ?? 0 };
        } catch (e) { out.components.d1 = { ok: false, error: e.message.slice(0, 80) }; }
        try {
          const m = JSON.parse(await env.KV.get("market_cache") || "null");
          out.components.market_cache = { age_min: m?.updated_at ? Math.round((Date.now() - m.updated_at) / 60000) : null, prices_from: m?.prices_from ?? null, funding: !!m?.funding };
        } catch { out.components.market_cache = { ok: false }; }
        try {
          const n = JSON.parse(await env.KV.get("news_cache") || "null");
          out.components.news_cache = { age_min: n?.updated_at ? Math.round((Date.now() - n.updated_at) / 60000) : null, source: n?.source ?? null, headlines: n?.headlines?.length ?? 0 };
        } catch { out.components.news_cache = { ok: false }; }
        return out;
      });
      return jsonResponse(payload);
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /feed.xml — RSS 2.0 of the latest directional alerts ──
  // Free distribution surface: feed readers, IFTTT/Zapier triggers, embeds.
  // Directional calls only (neutral plumbing stays on the API). Cached 5 min.
  if (request.method === "GET" && path === "/feed.xml") {
    try {
      const payload = await cachedPayload(env, "feed:v1", async () => {
        const { results } = await env.DB.prepare(
          "SELECT w.id, w.chain, w.symbol, w.usd_value, w.detected_at, a.headline, a.signal, a.confidence, a.interpretation, w.tx_hash FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id WHERE w.analysis_status = 'done' AND a.signal IN ('bullish','bearish') ORDER BY w.detected_at DESC LIMIT 30"
        ).all();
        return (results || []).map((r) => ({
          id: r.id, chain: r.chain, symbol: r.symbol, usd_value: r.usd_value,
          detected_at: r.detected_at, headline: r.headline || "", signal: r.signal || "",
          interpretation: r.interpretation || "", tx_hash: r.tx_hash,
        }));
      });
      const escXml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const items = payload.map((a) => {
        const link = (a.chain === "BTC" ? "https://blockchain.com/tx/" : "https://etherscan.io/tx/") + (a.tx_hash || "");
        return "  <item><title>" + escXml(a.signal.toUpperCase() + ": " + (a.headline || a.usd_value + " " + a.symbol)) + "</title><link>" + escXml(link) + "</link><guid>whale-" + a.id + "</guid><pubDate>" + new Date(a.detected_at).toUTCString() + "</pubDate><description>" + escXml(a.interpretation) + "</description></item>";
      }).join("\n");
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>WhaleSignal — directional whale calls</title><link>https://saman-ghorayshi.github.io/whalesignal/</link><description>Graded whale-flow alerts (directional only)</description>\n' + items + "\n</channel></rss>";
      return new Response(xml, { status: 200, headers: { "Content-Type": "application/rss+xml", "Cache-Control": "public, max-age=300" } });
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /news?limit=20 — recent keyword-matching headlines ────
  // The "why did whales move" history: what the news cache saw, deduped.
  if (request.method === "GET" && path === "/news") {
    try {
      const limit = Math.max(1, Math.min(100, Math.trunc(Number(url.searchParams.get("limit")) || 20)));
      const payload = await cachedPayload(env, `news:v1:${limit}`, async () => {
        const rows = await env.DB.prepare(
          "SELECT title, source, symbols, sentiment, first_seen FROM news ORDER BY first_seen DESC LIMIT ?"
        ).bind(limit).all();
        return {
          ok: true,
          count: rows?.results?.length || 0,
          news: (rows?.results || []).map((r) => ({
            title: r.title,
            source: r.source || null,
            symbols: r.symbols ? r.symbols.split(",") : [],
            sentiment: r.sentiment ?? 0,
            first_seen: r.first_seen,
          })),
        };
      });
      return jsonResponse(payload);
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /alerts/export?limit=200 — NDJSON alert stream ────────
  // The paper-trading loop's data source (plain GET + line-delimited JSON —
  // the same contract the R2 export had, without needing R2).
  if (request.method === "GET" && path === "/alerts/export") {
    try {
      const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get("limit")) || 200)));
      // since_id lets the trading loop poll cheaply (only rows newer than the
      // last one it processed); without it the latest window is cached 60s.
      const sinceId = Math.max(0, Math.trunc(Number(url.searchParams.get("since_id")) || 0));
      const cacheKey = sinceId > 0 ? null : `alerts-export:v1:${limit}`;
      const payload = await (cacheKey
        ? cachedPayload(env, cacheKey, () => exportRows(env, { limit, sinceId }))
        : exportRows(env, { limit, sinceId }));
      const lines = payload.map((row) => JSON.stringify(row));
      return new Response(lines.join("\n") + (lines.length ? "\n" : ""), {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    } catch (e) {
      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);
    }
  }

  // ─── public GET /market — chart-reading snapshot (TA regimes) ─────────
  // RSI/EMA/regime per coin from the hourly price snapshots, plus F&G.
  if (request.method === "GET" && path === "/market") {
    try {
      const payload = await cachedPayload(env, "market:v1", async () => {
        const out = { ok: true, generated_at: Date.now(), btc: null, eth: null, fear_greed: null, fear_greed_label: null };
        for (const coin of ["btc", "eth"]) {
          try {
            const { results } = await env.DB.prepare(
              "SELECT ts, price FROM price_history WHERE coin = ? ORDER BY ts DESC LIMIT 400"
            ).bind(coin).all();
            if (results && results.length >= 51) out[coin] = taSnapshot(results.slice().reverse());
          } catch { /* table empty */ }
        }
        try {
          const m = JSON.parse(await env.KV.get("market_cache") || "null");
          out.fear_greed = m?.fear_greed ?? null;
          out.fear_greed_label = m?.fear_greed_label ?? null;
          out.prices_from = m?.prices_from ?? null;
        } catch {}
        return out;
      });
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

// alert-export query shared by the route (cached or since_id polled)
async function exportRows(env, { limit, sinceId }) {
  const rows = await env.DB.prepare(
    `SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol,
            w.usd_value, w.tx_type, w.detected_at,
            a.headline, a.interpretation, a.signal, a.confidence,
            wf.label AS from_label, wt.label AS to_label
     FROM whales w
     LEFT JOIN analysis a ON a.whale_id = w.id
     LEFT JOIN wallets wf ON wf.address = w.from_address AND wf.chain = w.chain
     LEFT JOIN wallets wt ON wt.address = w.to_address AND wt.chain = w.chain
     WHERE w.analysis_status = 'done' AND w.id > ?
     ORDER BY w.detected_at DESC LIMIT ?`
  ).bind(sinceId, limit).all();
  let market = null;
  try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
  return (rows?.results || []).map((w) => buildAlertJSON(w, market)).filter(Boolean);
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
  // inline-keyboard reactions from the channel: every 👍/👎 is a free human
  // label on a graded call. ACK via answerCallbackQuery so Telegram stops
  // showing the spinner; never treat feedback as a DM command.
  if (update.callback_query?.data?.startsWith("fb:")) {
    const cq = update.callback_query;
    const [, idStr, reaction] = String(cq.data).split(":");
    try {
      if (reaction === "up" || reaction === "down") {
        const reactor = "tg:" + (cq.from?.id ?? cq.message?.message_id ?? "anon");
        await env.DB.prepare(
          "INSERT OR IGNORE INTO alert_feedback (whale_id, reactor, reaction, created_at) VALUES (?, ?, ?, ?)"
        ).bind(parseInt(idStr, 10) || 0, reactor, reaction, Date.now()).run();
        await env.DB.prepare(
          "INSERT INTO counters (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
        ).bind("feedback:" + reaction).run();
      }
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: cq.id, text: reaction === "up" ? "Noted — thanks!" : "Noted — helps the model" }),
      }).catch(() => {});
    } catch (e) {
      console.warn("[bot] feedback handler failed:", e.message);
    }
    return okJson({ ok: true, handled: "feedback" });
  }

  const msg = update.message || update.channel_post;
  // Commands are a DM feature. Channel echoes must NEVER be answered: every
  // alert the bot posts into PUBLIC_CHANNEL comes back to this webhook as a
  // channel_post update — and answering those ("I don't know that command
  // yet…") created a reply→post→echo→reply loop spamming the channel.
  const selfBotId = String(env.BOT_TOKEN || "").split(":")[0];
  const fromIsSelfOrBot = !!msg?.from &&
    (msg.from.is_bot === true || String(msg.from.id) === selfBotId);
  const isDmCommand = !!msg?.text
    && msg.chat?.type !== "channel"
    && !fromIsSelfOrBot;
  if (isDmCommand) {
    // Idempotency guard: Telegram delivers webhooks at-least-once (retries
    // after our old 5xx era, manual setWebhook nudges, network blips). Record
    // every update we're about to ANSWER; a replayed update_id is ACKed with
    // no side effects so users never get double replies.
    const uid = update?.update_id;
    if (uid != null) {
      try {
        const ins = await env.DB.prepare(
          "INSERT OR IGNORE INTO webhook_seen (update_id, seen_at) VALUES (?, ?)"
        ).bind(uid, Date.now()).run();
        if (ins.meta && ins.meta.changes === 0) {
          return okJson({ ok: true, handled: "dup" });
        }
        // bounded growth: prune 48h+ rows on ~2% of writes (cheap)
        if (Math.random() < 0.02) {
          await env.DB.prepare("DELETE FROM webhook_seen WHERE seen_at < ?")
            .bind(Date.now() - 48 * 3600 * 1000).run();
        }
      } catch (e) {
        // fail open: missing table / D1 hiccup must not break replying
        console.warn("webhook_seen guard skipped:", e.message);
      }
    }
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
      if (lc === "/premium") {
        try {
          if (cryptopayConfigured(env)) {
            if (await isActiveSubscriber(env, chatId)) {
              await tgSendMessage(env.BOT_TOKEN, chatId, "⭐ Your premium is already active. Thank you!");
              return okJson({ ok: true, handled: "premium_active" });
            }
            if (lc.startsWith("/premium ")) {
              // /premium <txid> — verify the payment
              const txid = txt.slice(9).trim();
              const msg = await handlePremiumPayment(env, chatId, txid);
              await tgSendMessage(env.BOT_TOKEN, chatId, msg);
              return okJson({ ok: true, handled: "premium_paid" });
            }
            // create the invoice via cryptopay (failure → explicit user reply,
            // never a silent ACK — the outer catch would leave them hanging)
            let inv = null;
            try {
              inv = await cryptopayCall(env, "/invoice", { user_id: parseInt(chatId, 10) || 0, pkg: "whalesignal_premium", usd: PREMIUM_PRICE_USD });
            } catch (e) {
              await tgSendMessage(env.BOT_TOKEN, chatId, "⚠️ Payment system is unavailable right now — try /premium again in a few minutes.");
              return okJson({ ok: true, handled: "premium_invoice_error" });
            }
            if (!inv?.ok && !inv?.chains?.length) {
              await tgSendMessage(env.BOT_TOKEN, chatId, "⚠️ Could not create a payment invoice right now — try /premium again shortly.");
              return okJson({ ok: true, handled: "premium_invoice_failed" });
            }
            await env.DB.prepare(
              `INSERT INTO subscribers (chat_id, plan, status, invoice, created_at, updated_at)
               VALUES (?, 'premium', 'awaiting_payment', ?, ?, ?)
               ON CONFLICT(chat_id) DO UPDATE SET status = 'awaiting_payment', invoice = excluded.invoice, updated_at = excluded.updated_at`
            ).bind(chatId, JSON.stringify(inv), Date.now(), Date.now()).run();
            const lines = ["⭐ WhaleSignal Premium — " + PREMIUM_PRICE_USD + " USD / " + PREMIUM_DAYS + " days", ""];
            for (const c of inv.chains || []) {
              lines.push("Send " + c.amount + " " + c.symbol + " to:");
              lines.push(c.wallet);
              lines.push("");
            }
            lines.push("After paying, send me: /premium <your transaction hash>");
            lines.push("Instant DM alerts · before the channel · cancels anytime.");
            await tgSendMessage(env.BOT_TOKEN, chatId, lines.join("\n"));
            return okJson({ ok: true, handled: "premium_invoice" });
          }
          // cryptopay not configured — waitlist mode
          await env.DB.prepare(
            "INSERT OR IGNORE INTO waitlist (chat_id, joined_at) VALUES (?, ?)"
          ).bind(chatId, Date.now()).run();
          const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first();
          await tgSendMessage(env.BOT_TOKEN, chatId, [
            "⭐ WhaleSignal Premium — waitlist (you are #" + (row?.n ?? 1) + ")",
            "",
            "Planned: instant DM alerts before channel clustering, full wallet track records, deeper flow graph windows, and the weekly edge report.",
            "",
            "It opens once our public accuracy ledger has enough graded predictions to be worth paying for. Waitlist members get the first month free.",
          ].join("\n"));
        } catch (e) {
          await tgSendMessage(env.BOT_TOKEN, chatId, "Waitlist is unavailable right now — try again later.");
        }
        return okJson({ ok: true, handled: "premium" });
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
            kv_groq: await env.KV.get(kvKeyName("groq")),
            kv_etherscan: await env.KV.get(kvKeyName("etherscan")),
            kv_model: await env.KV.get(kvKeyName("model")),
            kv_model_groq: await env.KV.get(kvKeyName("model_groq")),
            kv_chain: await env.KV.get("config:llm_chain"),
            kv_min_usd: await env.KV.get("config:min_usd"),
            kv_score: await env.KV.get("config:score_cutoff"),
            kv_max_blocks: await env.KV.get("config:max_blocks"),
          };
          await tgSendMessage(env.BOT_TOKEN, chatId, renderKeyStatus(status));
          return okJson({ ok: true, handled: "admin_keys" });
        }
        const parsed = parseKeyCommand(txt);
        if (!parsed) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            "usage:\n/setkey groq|gemini|news|etherscan|model|model_groq <value>\n/delkey <name>\n/chain groq gemini  (set LLM fallback order)\n/cfg min_usd 250000  (set scan threshold)\n/cfg score_cutoff 50  (set min alert score)\n/cfg max_blocks 5  (set blocks per tick)");
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
      if (lc.startsWith("/chain ")) {
        if (!isAdmin(msg, env.ADMIN_CHAT_ID)) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            `I don't know that command yet. Try /help, /ping, or /latest.`);
          return okJson({ ok: true, handled: "unknown" });
        }
        const parsed = parseChainCommand(txt);
        if (!parsed) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            "usage: /chain groq gemini\nor /chain gemini (single provider)\nowned: groq, gemini");
          return okJson({ ok: true, handled: "admin_chain_usage" });
        }
        await env.KV.put("config:llm_chain", JSON.stringify(parsed));
        await tgSendMessage(env.BOT_TOKEN, chatId,
          `✓ LLM chain → ${parsed.join(" → ")}\nWorkers use this fallback order for the next analysis call.`);
        return okJson({ ok: true, handled: "admin_chain" });
      }
      if (lc.startsWith("/cfg ")) {
        if (!isAdmin(msg, env.ADMIN_CHAT_ID)) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            `I don't know that command yet. Try /help, /ping, or /latest.`);
          return okJson({ ok: true, handled: "unknown" });
        }
        const parsed = parseCfgCommand(txt);
        if (!parsed) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            "usage: /cfg min_usd 250000\n/cfg score_cutoff 50\n/cfg max_blocks 5\nThese affect scanner thresholds (read on each tick).");
          return okJson({ ok: true, handled: "admin_cfg_usage" });
        }
        await env.KV.put(parsed.kvKey, String(parsed.value));
        await tgSendMessage(env.BOT_TOKEN, chatId,
          `✓ ${parsed.name} → ${parsed.value}\nScanner reads this on the next tick.`);
        return okJson({ ok: true, handled: "admin_cfg" });
      }
      // unknown
      await tgSendMessage(env.BOT_TOKEN, chatId,
        `I don't know that command yet. Try /help, /ping, or /latest.`);
      return okJson({ ok: true, handled: "unknown" });
    } catch (e) {
      // A failed reply (chat not found, bot blocked, markdown parse error,
      // transient 4xx/5xx from Telegram) must NOT surface as a webhook 5xx.
      // Telegram treats any non-2xx as "delivery failed" and redelivers the
      // same update forever ("Wrong response from the webhook: 502 Bad
      // Gateway"). Log it and ACK with 200 instead; the queue-consumer path
      // (alerts) keeps its own retry semantics and is unaffected.
      console.error("bot update handling failed:", e.message);
      return okJson({ ok: true, handled: "error" });
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
const MANAGEABLE_KEYS = new Set(["gemini", "news", "model", "groq", "etherscan", "model_groq"]);
const kvKeyName = (name) => ({ model: "config:model", model_groq: "config:model_groq", etherscan: "key:etherscan" }[name] || `key:${name}`);
const maskValue = (v) => (v && v.length > 6 ? `…${String(v).slice(-4)} (${String(v).length} chars)` : "(set)");

/** Pure: parse "/chain groq gemini" → ["groq","gemini"] or null */
export function parseChainCommand(text) {
  const known = new Set(["groq", "gemini"]);
  const parts = String(text || "").trim().split(/\s+/).slice(1);
  if (parts.length === 0 || !parts.every(p => known.has(p))) return null;
  return parts;
}

/** Pure: parse "/cfg <name> <number>" → { kvKey, name, value } or null */
export function parseCfgCommand(text) {
  const whitelist = {
    min_usd:    { kvKey: "config:min_usd",    name: "min_usd",    fn: Number },
    score_cutoff: { kvKey: "config:score_cutoff", name: "score_cutoff", fn: Number },
    max_blocks: { kvKey: "config:max_blocks",  name: "max_blocks",  fn: Number },
    channel_mode: { kvKey: "config:channel_mode", name: "channel_mode", fn: (v) => v.toLowerCase(),
                    allowed: ["all", "directional", "high"] },
  };
  const m = /^\/cfg\s+(\S+)\s+(.+)$/.exec(String(text || "").trim());
  if (!m) return null;
  const def = whitelist[m[1].toLowerCase()];
  if (!def) return null;
  const v = def.fn(m[2].trim());
  if (def.allowed) {
    if (!def.allowed.includes(v)) return null;
    return { kvKey: def.kvKey, name: def.name, value: v };
  }
  if (!Number.isFinite(v) || v < 0 || v > 1_000_000) return null;
  return { kvKey: def.kvKey, name: def.name, value: v };
}

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
  const kvOnly = (kvVal) => (kvVal ? "KV " + maskValue(kvVal) : "— missing —");
  const num = (v, d) => (v != null ? Number(v) : d);
  let chain = [];
  try { chain = JSON.parse(s.kv_chain || "null"); } catch {}
  if (!Array.isArray(chain) || !chain.length) chain = ["groq", "gemini"];
  return [
    "🔑 API keys",
    `  gemini:      ${fmt(s.env_gemini, s.kv_gemini)}`,
    `  groq:        ${kvOnly(s.kv_groq)}`,
    `  news:        ${fmt(s.env_news, s.kv_news)}`,
    `  etherscan:   ${kvOnly(s.kv_etherscan)}  (comma-sep rotate)`,
    `  model:       ${kvOnly(s.kv_model)}  (gemini override)`,
    `  model_groq:  ${kvOnly(s.kv_model_groq)}`,
    "",
    "⚙️ config",
    `  LLM chain:   ${chain.join(" → ")}`,
    `  min_usd:     ${num(s.kv_min_usd, "$500,000")}`,
    `  score_cutoff:${num(s.kv_score, 50)}`,
    `  max_blocks:  ${num(s.kv_max_blocks, 5)} / tick`,
  ].join("\n");
}

const HELP_TEXT = `🐋 WhaleSignal — AI whale alerts

Phase 1 (MVP). Commands:
  /ping    — health check
  /help    — this message
  /latest  — recently posted whale moves
  /premium — join the premium waitlist

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
    // hide the chain tag when it just repeats the symbol ("BTC btc" → "BTC")
    const tag = String(w.chain || "").toLowerCase() === String(w.symbol || "").toLowerCase()
      ? "" : ` ${w.chain}`;
    return `${emoji} ${fmtUSD(w.usd_value)} ${w.symbol}${tag} — ${w.headline || "(no headline)"}\n  ${shortAddr(w.from_address)} → ${shortAddr(w.to_address)}`;
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

// ─── /stats endpoint (rollup-backed) ──────────────────────────────────

/**
 * Lifetime counters — one small table, read wholesale (tens of rows).
 * Replaces full scans of whales for every /stats request.
 */
export async function readCounters(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM counters").all();
  const map = new Map((results || []).map((r) => [r.k, r.v]));
  return map;
}

/**
 * Aggregate stats from rollups: counters + hourly_stats windows.
 * Reads ~200 rows total regardless of how large whales grows.
 * Accuracy still reads the analysis table (prediction_outcome rows are few;
 * once the evaluator writes back at scale, add an outcome counter).
 */
export async function statsRows(env) {
  const now = Date.now();
  // each query wrapped in its own async fn: a synchronous prepare() throw
  // then becomes that fn's rejection (handled by Promise.all) instead of an
  // orphaned rejected promise racing the array literal's construction
  const windowsQ = async () =>
    (await env.DB.prepare(
      `SELECT chain,
         SUM(CASE WHEN hour_bucket > ? THEN events ELSE 0 END) AS c24,
         SUM(CASE WHEN hour_bucket > ? THEN events ELSE 0 END) AS c7d,
         SUM(events) AS events
       FROM hourly_stats GROUP BY chain`
    ).bind(now - 86_400_000, now - 7 * 86_400_000).all())?.results || [];
  const [counters, rows] = await Promise.all([readCounters(env), windowsQ()]);
  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  // accuracy from grading counters: rate excludes "no_move" results
  const correct = counters.get("outcome:correct") || 0;
  const wrong = counters.get("outcome:wrong") || 0;
  return {
    total_whales: counters.get("total_whales") || 0,
    total_volume: counters.get("total_volume") || 0,
    largest_transfer: counters.get("largest_transfer") || 0,
    bullish: counters.get("signal:bullish") || 0,
    bearish: counters.get("signal:bearish") || 0,
    neutral: counters.get("signal:neutral") || 0,
    count_24h: sum("c24"),
    count_7d: sum("c7d"),
    accuracy_total: correct + wrong,
    accuracy_correct: correct,
    feedback_up: counters.get("feedback:up") || 0,
    feedback_down: counters.get("feedback:down") || 0,
  };
}

/** Per-symbol breakdown from counters (`symbol:<SYM>:count/volume`). */
export async function statsBySymbol(env) {
  const counters = await readCounters(env);
  const symbols = new Map();
  for (const [k, v] of counters) {
    const m = /^symbol:([A-Z0-9]+):(count|volume)$/.exec(k);
    if (!m) continue;
    const cur = symbols.get(m[1]) || { symbol: m[1], count: 0, volume: 0 };
    if (m[2] === "count") cur.count = v;
    else cur.volume = v;
    symbols.set(m[1], cur);
  }
  return [...symbols.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}

/** Hourly whale activity for the last 24h, from hourly_stats. */
export async function statsHourly(env) {
  const { results } = await env.DB.prepare(
    `SELECT hour_bucket, SUM(events) AS count, SUM(volume_usd) AS volume
     FROM hourly_stats WHERE hour_bucket > ? GROUP BY hour_bucket ORDER BY hour_bucket ASC`
  ).bind(Date.now() - 24 * 86_400_000).all();
  return (results || []).map((r) => ({ hour_bucket: r.hour_bucket, count: r.count, volume: r.volume }));
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

// ─── /netflow endpoint — exchange netflow index (rollup-backed) ───────

/**
 * Totals per chain for directional exchange flows in the window, read from
 * hourly_stats — a few hundred rows max, whatever the whales table grows to.
 */
export async function netflowTotals(env, since, chain = null) {
  let sql = `SELECT chain,
    SUM(inflow_usd) AS inflow_usd, SUM(outflow_usd) AS outflow_usd,
    SUM(stable_inflow_usd) AS stable_inflow_usd, SUM(stable_outflow_usd) AS stable_outflow_usd,
    SUM(inflow_count) AS inflow_count, SUM(outflow_count) AS outflow_count
  FROM hourly_stats
  WHERE hour_bucket > ? AND (inflow_count > 0 OR outflow_count > 0)`;
  const binds = [since];
  if (chain) { sql += " AND chain = ?"; binds.push(chain); }
  sql += " GROUP BY chain ORDER BY chain";
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

/**
 * Per-exchange flow totals in the window, from exchange_netflow_hourly.
 * Reads one row per (hour × exchange) in the window instead of scanning raw.
 */
export async function netflowByExchange(env, since, chain = null, limit = 12) {
  const n = Math.max(1, Math.min(25, Math.trunc(Number(limit) || 12)));
  let sql = `SELECT chain, exchange,
    SUM(inflow_usd) AS inflow_usd, SUM(outflow_usd) AS outflow_usd,
    SUM(inflow_count) AS inflow_count, SUM(outflow_count) AS outflow_count
  FROM exchange_netflow_hourly
  WHERE hour_bucket > ?`;
  const binds = [since];
  if (chain) { sql += " AND chain = ?"; binds.push(chain); }
  sql += ` GROUP BY chain, exchange
    ORDER BY (SUM(inflow_usd) + SUM(outflow_usd)) DESC LIMIT ?`;
  binds.push(n);
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

/**
 * Trailing baseline: average ABSOLUTE daily netflow over the 7 days before
 * yesterday. Raw $ netflow is meaningless without context — $214M onto
 * exchanges is noise on a $60B-volume day and a roar on a quiet one.
 * Pure SQL over hourly_stats; null when there's no history yet.
 */
export async function netflowBaseline(env, chain = null) {
  const until = Date.now() - 86_400_000; // up to yesterday
  const since = until - 7 * 86_400_000;
  let sql = `SELECT AVG(ABS(day_net)) AS avg_abs_net_daily FROM (
    SELECT (hour_bucket / 86400000) * 86400000 AS day,
           SUM(inflow_usd - outflow_usd) AS day_net
    FROM hourly_stats
    WHERE hour_bucket > ? AND hour_bucket <= ? AND (inflow_count > 0 OR outflow_count > 0)`;
  const binds = [since, until];
  if (chain) { sql += " AND chain = ?"; binds.push(chain); }
  sql += " GROUP BY day)";
  const row = await env.DB.prepare(sql).bind(...binds).first();
  return { avg_abs_net_daily: row?.avg_abs_net_daily ?? null };
}

/**
 * Pure. Build the /netflow JSON payload. Sign convention: net_inflow_usd =
 * inflow − outflow, so POSITIVE means coins moved ONTO exchanges (potential
 * sell-side supply, bearish pressure) and NEGATIVE means coins left
 * exchanges (self-custody accumulation, bullish pressure). bias is
 * directional only when BOTH hold:
 *   1. |net| ≥ 5% of gross volume in the window, AND
 *   2. |net| ≥ 1.5× the trailing 7-day daily average (when a baseline
 *      exists) — a raw number without history context is not a signal.
 */
/**
 * Stablecoin supply trend from the daily snapshots: the research caveat —
 * flows during flat supply are rotation; during rising supply, fresh capital.
 */
export async function stablecoinContext(env) {
  const { results } = await env.DB.prepare(
    "SELECT day, total_usd FROM stablecoin_supply ORDER BY day DESC LIMIT 8"
  ).all();
  if (!results || results.length < 2) return null;
  const latest = results[0].total_usd, oldest = results[results.length - 1].total_usd;
  const delta = Math.round(latest - oldest);
  const pct = oldest > 0 ? Math.round((delta / oldest) * 10000) / 100 : null;
  const read = pct == null ? "unknown" : pct > 1 ? "fresh capital entering the system" : pct < -1 ? "capital exiting the system" : "roughly flat — flows are mostly rotation";
  return { days: results.length, delta_usd: delta, pct, read };
}
export function renderNetflowJSON(totals, perExchange, windowHours, chain = null, baseline = null, stableCtx = null) {
  let inflow = 0, outflow = 0, inflowCount = 0, outflowCount = 0;
  const byChain = new Map();
  for (const r of totals || []) {
    const inU = r.inflow_usd || 0, outU = r.outflow_usd || 0;
    inflow += inU; outflow += outU;
    inflowCount += r.inflow_count || 0;
    outflowCount += r.outflow_count || 0;
    const key = r.chain || "?";
    const cur = byChain.get(key) || { chain: key, inflow_usd: 0, outflow_usd: 0, inflow_count: 0, outflow_count: 0 };
    cur.inflow_usd += inU; cur.outflow_usd += outU;
    cur.inflow_count += r.inflow_count || 0;
    cur.outflow_count += r.outflow_count || 0;
    byChain.set(key, cur);
  }
  let sIn = 0, sOut = 0;
  for (const r of totals || []) {
    sIn += r.stable_inflow_usd || 0;
    sOut += r.stable_outflow_usd || 0;
  }
  const stableNet = sIn - sOut;
  const stableGross = sIn + sOut;
  // stablecoin semantics are INVERTED: stables moving onto exchanges are
  // deployable buy-side, not sell-side (docs/SIGNAL_MODEL.md category 1)
  const stableBias = stableGross === 0 || Math.abs(stableNet) < stableGross * 0.05
    ? "balanced" : stableNet > 0 ? "bullish_pressure" : "bearish_pressure";
  const net = inflow - outflow;
  const gross = inflow + outflow;
  const baselineAvg = baseline?.avg_abs_net_daily ?? null;
  const vsAvg = baselineAvg ? Math.round((net / baselineAvg) * 100) / 100 : null;
  const bigEnough = gross > 0 && Math.abs(net) >= gross * 0.05;
  const loud = baselineAvg == null || Math.abs(net) >= 1.5 * baselineAvg;
  const bias = !bigEnough || !loud ? "balanced" : net > 0 ? "bearish_pressure" : "bullish_pressure";
  const contextNote = baselineAvg != null && gross > 0
    ? ` That is ${vsAvg}× the trailing 7-day daily average netflow.`
    : "";
  const interpretation = gross === 0
    ? "No directional exchange flows detected in this window yet."
    : bias === "balanced"
      ? `Exchange inflows and outflows are roughly balanced — no strong whale-side bias in this window.${contextNote}`
      : bias === "bearish_pressure"
        ? `Whales moved ${fmtUSD(net)} more ONTO exchanges than they withdrew — rising sell-side supply, historically read as bearish pressure.${contextNote}`
        : `Whales withdrew ${fmtUSD(-net)} more FROM exchanges than they deposited — coins moving to self-custody, historically read as accumulation.${contextNote}`;
  return {
    ok: true,
    window_hours: windowHours,
    chain: chain || "all",
    generated_at: Date.now(),
    totals: {
      inflow_usd: inflow,
      outflow_usd: outflow,
      net_inflow_usd: net,
      inflow_count: inflowCount,
      outflow_count: outflowCount,
      baseline_avg_abs_net_daily: baselineAvg,
      net_vs_7d_daily_avg: vsAvg,
      bias,
      interpretation,
      stablecoin: {
        inflow_usd: sIn,
        outflow_usd: sOut,
        net_inflow_usd: stableNet,
        bias: stableBias,
        supply_context: stableCtx,
        note: "Stablecoin flows are read INVERSELY to native assets: inflows are deployable buying power, not sell-side supply." + (stableCtx ? " Supply 7d: " + (stableCtx.delta_usd >= 0 ? "+" : "") + fmtUSD(stableCtx.delta_usd) + " (" + stableCtx.read + ")." : ""),
      },
    },
    by_chain: [...byChain.values()].map((c) => ({
      chain: c.chain,
      inflow_usd: c.inflow_usd,
      outflow_usd: c.outflow_usd,
      net_inflow_usd: c.inflow_usd - c.outflow_usd,
      inflow_count: c.inflow_count,
      outflow_count: c.outflow_count,
    })),
    by_exchange: (perExchange || []).map((e) => ({
      chain: e.chain,
      exchange: e.exchange,
      inflow_usd: e.inflow_usd || 0,
      outflow_usd: e.outflow_usd || 0,
      net_inflow_usd: (e.inflow_usd || 0) - (e.outflow_usd || 0),
      events: (e.inflow_count || 0) + (e.outflow_count || 0),
    })),
  };
}

// ─── /graph endpoint — aggregated flow edges (rollup-backed) ──────────

/**
 * Top whale-flow edges in the window, from flow_edges_hourly — the PK
 * prefix on hour_bucket means a window query reads only that window's rows.
 * min_usd filters the AGGREGATED edge volume (relationship weight), not each
 * individual transfer. Rollups don't carry last_seen (edge freshest hour is
 * implied by the window); clients get null.
 */
export async function graphEdges(env, { since, chain = null, minUsd = 0, limit = 50 }) {
  let sql = `SELECT chain, from_address, to_address,
    SUM(volume_usd) AS volume,
    SUM(cnt) AS cnt,
    SUM(inflow_cnt) AS inflow_cnt,
    SUM(outflow_cnt) AS outflow_cnt
  FROM flow_edges_hourly
  WHERE hour_bucket > ?`;
  const binds = [since];
  if (chain) { sql += " AND chain = ?"; binds.push(chain); }
  sql += ` GROUP BY chain, from_address, to_address
    HAVING SUM(volume_usd) >= ?
    ORDER BY volume DESC LIMIT ?`;
  binds.push(minUsd, limit);
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

/**
 * Pure. Build the /graph JSON payload: nodes (wallets + labels from the
 * wallets table) and edges (aggregated flows). Node id is chain:address so
 * the same address on two chains stays distinct.
 */
export function renderGraphJSON(edges, walletRows, opts = {}) {
  const labelMap = new Map();
  for (const w of walletRows || []) {
    if (!w?.address) continue;
    labelMap.set(`${w.chain}:${w.address}`, w);
    // evm addresses are case-insensitive — index lowercase too
    if (w.chain === "eth") labelMap.set(`eth:${String(w.address).toLowerCase()}`, w);
  }
  const nodeInfo = (chain, addr) => {
    const hit = labelMap.get(`${chain}:${addr}`)
      || (chain === "eth" ? labelMap.get(`eth:${String(addr).toLowerCase()}`) : null)
      || null;
    return {
      label: hit?.label || null,
      type: hit?.type || (hit ? "whale" : "unknown"),
    };
  };

  const nodes = new Map();
  const outEdges = [];
  let maxVolume = 0;
  for (const e of edges || []) {
    const chain = e.chain || "?";
    const fromId = `${chain}:${e.from_address}`;
    const toId = `${chain}:${e.to_address}`;
    maxVolume = Math.max(maxVolume, e.volume || 0);
    for (const [id, addr] of [[fromId, e.from_address], [toId, e.to_address]]) {
      if (!nodes.has(id)) {
        const info = nodeInfo(chain, addr);
        nodes.set(id, { id, address: addr, chain, label: info.label, type: info.type, volume: 0 });
      }
      const n = nodes.get(id);
      n.volume += e.volume || 0;
    }
    outEdges.push({
      source: fromId,
      target: toId,
      chain,
      volume_usd: e.volume || 0,
      count: e.cnt || 0,
      inflow_cnt: e.inflow_cnt || 0,
      outflow_cnt: e.outflow_cnt || 0,
      last_seen: e.last_seen || null,
    });
  }
  return {
    ok: true,
    window_hours: opts.windowHours ?? 24,
    chain: opts.chain || "all",
    min_usd: opts.minUsd ?? 0,
    generated_at: Date.now(),
    max_edge_volume: maxVolume,
    nodes: [...nodes.values()],
    edges: outEdges,
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

  // D1 gotcha: .bind() REPLACES bindings — it must be called ONCE with all
  // values. The old loop called it per-value, so only the last (offset)
  // survived → "Wrong number of parameter bindings" 500s on real D1.
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
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
 * Lifetime directional flow stats for one wallet, computed from the whales
 * table. "Deposited to exchange" = rows the wallet SENT classified as
 * exchange_inflow (sell-side); "withdrawn from exchange" = rows the wallet
 * RECEIVED classified as exchange_outflow (accumulation). One query.
 */
export async function walletFlowStats(env, address, chain = null) {
  const addr = String(address || "");
  let sql = `SELECT
    COALESCE(SUM(CASE WHEN w.from_address = ? AND w.tx_type = 'exchange_inflow'  THEN w.usd_value END), 0) AS deposited_to_exchange,
    COALESCE(SUM(CASE WHEN w.to_address   = ? AND w.tx_type = 'exchange_outflow' THEN w.usd_value END), 0) AS withdrawn_from_exchange,
    COALESCE(SUM(CASE WHEN w.from_address = ? THEN w.usd_value END), 0) AS sent_total,
    COALESCE(SUM(CASE WHEN w.to_address   = ? THEN w.usd_value END), 0) AS received_total,
    COUNT(*) AS events
  FROM whales w WHERE (w.from_address = ? OR w.to_address = ?)`;
  const binds = [addr, addr, addr, addr, addr, addr];
  if (chain) { sql += " AND w.chain = ?"; binds.push(String(chain).toLowerCase()); }
  const row = await env.DB.prepare(sql).bind(...binds).first();
  return row || { deposited_to_exchange: 0, withdrawn_from_exchange: 0, sent_total: 0, received_total: 0, events: 0 };
}

/**
 * Most-connected counterparties for a wallet (top 5 by USD volume ever).
 * This is the per-wallet "graph": who this whale actually transacts with.
 */
export async function walletCounterparties(env, address, chain = null, limit = 5) {
  const addr = String(address || "");
  const n = Math.max(1, Math.min(10, Math.trunc(Number(limit) || 5)));
  let sql = `SELECT CASE WHEN w.from_address = ? THEN w.to_address ELSE w.from_address END AS counterparty,
    COALESCE(SUM(w.usd_value), 0) AS volume, COUNT(*) AS cnt, MAX(w.detected_at) AS last_seen
  FROM whales w
  WHERE (w.from_address = ? OR w.to_address = ?) AND w.from_address != w.to_address`;
  const binds = [addr, addr, addr];
  if (chain) { sql += " AND w.chain = ?"; binds.push(String(chain).toLowerCase()); }
  sql += " GROUP BY counterparty ORDER BY volume DESC LIMIT ?";
  binds.push(n);
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

/**
 * Pure. Classify a wallet's net on-chain posture from its exchange flows.
 * net = withdrawn − deposited: positive → accumulator (pulling coins off
 * exchanges), negative → distributor (pushing coins onto exchanges).
 * Balanced when |net| is under 20% of gross exchange flow.
 */
export function flowDirection(stats) {
  if (!stats) return null;
  const deposited = stats.deposited_to_exchange || 0;
  const withdrawn = stats.withdrawn_from_exchange || 0;
  const gross = deposited + withdrawn;
  if (gross === 0) return null;
  const net = withdrawn - deposited;
  const direction = Math.abs(net) < gross * 0.2 ? "balanced" : net > 0 ? "accumulator" : "distributor";
  return { direction, net_exchange_usd: net, gross_exchange_usd: gross };
}

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

  // UNION ALL instead of OR: each branch seeks its own index (idx_whales_from_time
  // / idx_whales_to_time). The OR version can\'t use either index on 110K rows.
  const txsFrom = await env.DB.prepare(
    "SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol, " +
    "w.usd_value, w.tx_type, w.detected_at, w.interesting_score, " +
    "a.signal, a.headline, a.confidence " +
    "FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id " +
    "WHERE w.from_address = ? " + (chain ? "AND w.chain = ? " : "") +
    "ORDER BY w.detected_at DESC LIMIT 20"
  ).bind(chain ? [addr, chain.toLowerCase()] : [addr]).all();
  const txsTo = await env.DB.prepare(
    "SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol, " +
    "w.usd_value, w.tx_type, w.detected_at, w.interesting_score, " +
    "a.signal, a.headline, a.confidence " +
    "FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id " +
    "WHERE w.to_address = ? " + (chain ? "AND w.chain = ? " : "") +
    "ORDER BY w.detected_at DESC LIMIT 20"
  ).bind(chain ? [addr, chain.toLowerCase()] : [addr]).all();
  // merge + dedupe by id
  const seen = new Set();
  const txs = { results: [] };
  for (const r of [...(txsFrom?.results || []), ...(txsTo?.results || [])]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    txs.results.push(r);
  }
  txs.results.sort((x, y) => y.detected_at - x.detected_at);
  txs.results = txs.results.slice(0, 20);

  const flow = await walletFlowStats(env, addr, chain);
  const counterparties = await walletCounterparties(env, addr, chain);
  // track record: graded vs correct directional calls involving this wallet
  let track = null;
  if (profile) {
    track = await env.DB.prepare(
      "SELECT graded, correct FROM wallet_stats WHERE address = ? AND chain = ?"
    ).bind(profile.address, profile.chain).first().catch(() => null);
  }

  return { profile, txs: txs?.results || [], flow, counterparties, track };
}

/** Pure. Build the /wallet/:addr JSON payload. */
export function renderWalletJSON(profile, txs, flow = null, counterparties = [], track = null) {
  if (!profile) {
    return { ok: false, reason: "wallet not in database", address: null, txs: [] };
  }
  const dir = flowDirection(flow);
  const trackRecord = track && track.graded > 0 ? {
    graded: track.graded,
    correct: track.correct,
    rate: Math.round((track.correct / track.graded) * 100),
  } : null;
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
    flow: flow ? {
      deposited_to_exchange: flow.deposited_to_exchange || 0,
      withdrawn_from_exchange: flow.withdrawn_from_exchange || 0,
      net_exchange_usd: dir?.net_exchange_usd ?? 0,
      direction: dir?.direction ?? "unknown",
    } : null,
    track_record: trackRecord,
    top_counterparties: (counterparties || []).map((c) => ({
      address: c.counterparty,
      volume_usd: c.volume || 0,
      count: c.cnt || 0,
      last_seen: c.last_seen || null,
    })),
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

// ─── accountability engine — grade every directional call ─────────────
//
// Each bullish/bearish analysis is a verifiable prediction. 24h after
// detection we compare price_at_detect against the current cached price and
// write prediction_outcome ('correct' | 'wrong' | 'no_move' | 'no_data'),
// plus rollups: outcome counters (lifetime + per-confidence-bucket) and
// per-wallet graded/correct in wallet_stats. The ledger is complete — every
// directional call gets graded, right or wrong, nothing is cherry-picked.

export function gradeSignal(signal, priceAtDetect, priceNow, thresholdPct = 1.0) {
  if (signal !== "bullish" && signal !== "bearish") return "no_data";
  if (priceAtDetect == null || priceNow == null || !(priceAtDetect > 0)) return "no_data";
  const movePct = ((priceNow - priceAtDetect) / priceAtDetect) * 100;
  if (Math.abs(movePct) < thresholdPct) return "no_move";
  if (signal === "bullish") return movePct > 0 ? "correct" : "wrong";
  return movePct < 0 ? "correct" : "wrong";
}

/** Confidence bands for calibration stats: high ≥0.75, mid ≥0.60, low below. */
export function confidenceBucket(conf) {
  const c = Number(conf) || 0;
  if (c >= 0.75) return "high";
  if (c >= 0.6) return "mid";
  return "low";
}

/** Price for a symbol from the market cache; stablecoins sit at ~1.0 so
 *  stablecoin flows grade as no_move — honest, they don't move. */
function priceForSymbol(market, symbol) {
  if (!market || !symbol) return null;
  const sym = String(symbol).toLowerCase();
  if (market[sym]?.price != null) return market[sym].price;
  // BTC-pegged aliases fall back to BTC
  if (sym === "wbtc") return market.btc?.price ?? null;
  return null;
}

/**
 * Grade all directional analyses older than minAgeHours (default 24).
 * Bounded to 50 rows per run; each row is graded exactly once (the UPDATE
 * only fires while prediction_outcome IS NULL, and rollups only run when
 * that UPDATE actually changed a row).
 */
/**
 * Pure: is this event due for grading? Returns 'due' (24-36h old — the
 * honest window), 'young' (not yet 24h), or 'expired' (missed the window;
 * graded as 'expired' so the ledger never pretends a late price read was
 * the 24h mark).
 */
/**
 * Pure: vol-adaptive grading threshold. A flat 1% is a huge move in quiet
 * markets and noise in violent ones — grade each call against its asset's
 * own recent volatility instead (7d of hourly closes → dailyized stdev,
 * threshold = max(1%, half the daily vol)).
 */
export function volThreshold(hourlyPrices) {
  const prices = (hourlyPrices || []).map((p) => (typeof p === "object" ? p.price : p)).filter((p) => p > 0);
  if (prices.length < 24) return 1.0;
  const rets = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const dailyPct = Math.sqrt(24) * sd * 100;
  return Math.round(Math.max(1.0, 0.5 * dailyPct) * 100) / 100;
}

export function gradeWindowCheck(detectedAt, now, minHours = 24, maxHours = 36) {
  const ageH = (now - detectedAt) / 3_600_000;
  if (ageH < minHours) return "young";
  if (ageH > maxHours) return "expired";
  return "due";
}

export async function gradePending(env, opts = {}) {
  const now = Date.now();
  const minAgeHours = Number(opts.minAgeHours ?? 24);
  const minAgeMs = (Number.isFinite(minAgeHours) && minAgeHours >= 0 ? minAgeHours : 24) * 3600_000;
  let market = null;
  try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch { /* null */ }
  if (!market) return { graded: 0, skipped: "no_market_cache" };
  // stale prices would write wrong outcomes into the permanent ledger —
  // skip this tick and grade when a fresh price lands (15 min later)
  if (market.updated_at && Date.now() - market.updated_at > 30 * 60_000) {
    return { graded: 0, skipped: "stale_market_cache" };
  }

  const now0 = Date.now();
  // rows past the honest window are closed as 'expired' so they never get
  // graded against a price that isn't the 24h mark. minAgeMs is already in
  // ms — the old Math.max(minAgeMs, 36) * 3_600_000 multiplied a ms value by
  // 3.6M and NEVER matched anything (found by audit).
  const maxAgeHours = Math.max(Number(opts.minAgeHours) || 24, 24) + 12;
  await env.DB.prepare(
    `UPDATE analysis SET prediction_outcome = 'expired', evaluated_at = ?
     WHERE prediction_outcome IS NULL AND signal IN ('bullish','bearish')
       AND whale_id IN (SELECT id FROM whales WHERE detected_at < ?)`
  ).bind(now0, now0 - maxAgeHours * 3_600_000).run();

  // per-asset vol-adaptive thresholds (BTC/ETH), computed once per run —
  // a flat 1% is huge in quiet markets and noise in violent ones
  const thresholds = {};
  for (const coin of ["btc", "eth"]) {
    try {
      const { results: ph } = await env.DB.prepare(
        "SELECT price FROM price_history WHERE coin = ? ORDER BY hour_bucket DESC LIMIT 168"
      ).bind(coin).all();
      thresholds[coin] = volThreshold(ph || []);
    } catch { thresholds[coin] = 1.0; }
  }
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.chain, w.symbol, w.usd_value, w.detected_at, w.price_at_detect, w.from_address,
            a.signal, a.confidence
     FROM whales w JOIN analysis a ON a.whale_id = w.id
     WHERE a.signal IN ('bullish','bearish') AND a.prediction_outcome IS NULL
       AND w.detected_at < ?
     ORDER BY w.detected_at ASC LIMIT 50`
  ).bind(now - minAgeMs).all();

  let graded = 0;
  for (const row of results || []) {
    const priceNow = priceForSymbol(market, row.symbol);
    const outcome = gradeSignal(row.signal, row.price_at_detect, priceNow, thresholds[String(row.chain).toLowerCase()] || 1.0);
    // CAS-style: only grade if still ungraded (guards against overlapping runs)
    const upd = await env.DB.prepare(
      `UPDATE analysis SET prediction_outcome = ?, price_at_eval = ?, evaluated_at = ?
       WHERE whale_id = ? AND prediction_outcome IS NULL`
    ).bind(outcome, priceNow, now, row.id).run();
    if (!upd.meta || upd.meta.changes === 0) continue; // someone else graded it

    const bucket = confidenceBucket(row.confidence);
    const stmts = [
      env.DB.prepare("INSERT INTO counters (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1")
        .bind(`outcome:${outcome}`),
      env.DB.prepare("INSERT INTO counters (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1")
        .bind(`outcome:${bucket}:${outcome}`),
      env.DB.prepare(
        `INSERT INTO wallet_stats (address, chain, graded, correct) VALUES (?, ?, 1, ?)
         ON CONFLICT(address, chain) DO UPDATE SET graded = graded + 1, correct = correct + excluded.correct`
      ).bind(row.from_address, row.chain, outcome === "correct" ? 1 : 0),
    ];
    try { await env.DB.batch(stmts); } catch (e) {
      console.warn(`[bot] grade rollups failed for whale ${row.id}: ${e.message}`);
    }
    graded++;
  }
  return { graded, considered: (results || []).length };
}

// ─── event clustering ─────────────────────────────────────────────────

/** Pure. Build the daily scoreboard text. Plain text, no markdown. */
export function renderScoreboard({ accuracy, graded24, correct24, wrong24, nomove24, topCalls }) {
  const lines = [];
  lines.push("📊 WhaleSignal scoreboard — every call gets graded");
  lines.push("");
  lines.push(`Graded last 24h: ${graded24} → ✅ ${correct24} correct · ❌ ${wrong24} wrong · ➖ ${nomove24} no-move`);
  if (accuracy && accuracy.total > 0) {
    const rate = Math.round((accuracy.correct / accuracy.total) * 100);
    lines.push(`Running accuracy: ${rate}% (${accuracy.correct}/${accuracy.total} directional calls)`);
  } else {
    lines.push("Running accuracy: building — first grades land 24h after each call.");
  }
  if (topCalls && topCalls.length) {
    lines.push("");
    lines.push("Biggest closed calls:");
    for (const c of topCalls) {
      const emoji = c.signal === "bullish" ? "🟢" : "🔴";
      const conf = c.confidence != null ? Number(c.confidence).toFixed(2) : "—";
      let move = "—";
      if (c.price_at_detect > 0 && c.price_at_eval != null) {
        const pct = ((c.price_at_eval - c.price_at_detect) / c.price_at_detect) * 100;
        move = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
      }
      const mark = c.prediction_outcome === "correct" ? "✅ CORRECT" : "❌ WRONG";
      const sym = c.symbol || "?";
      lines.push(`${emoji} ${fmtUSD(c.usd_value)} ${sym} (${c.signal}, conf ${conf}) → ${sym} ${move} in 24h → ${mark}`);
    }
  }
  lines.push("");
  lines.push("No cherry-picking: every bullish/bearish call is graded 24h later against real prices, right or wrong. \"No-move\" results count as graded but not toward accuracy.");
  return lines.join("\n");
}

/**
 * Post the daily scoreboard to the public channel. Idempotent per day via a
 * KV marker (auto-expires). Skips silently when nothing was graded in 24h.
 */
export async function postScoreboard(env) {
  const day = new Date().toISOString().slice(0, 10);
  const marker = `scoreboard:${day}`;
  try {
    if (await env.KV.get(marker)) return { skipped: "already_posted" };
  } catch { /* KV hiccup — posting twice is better than never */ }

  const since = Date.now() - 86_400_000;
  const [outcomes24, counters, topCallsQ] = await Promise.all([
    // one scan of analysis per day is fine (bounded by evaluated_at rows)
    env.DB.prepare(
      "SELECT prediction_outcome, COUNT(*) AS n FROM analysis WHERE evaluated_at > ? AND prediction_outcome IS NOT NULL GROUP BY prediction_outcome"
    ).bind(since).all(),
    readCounters(env),
    env.DB.prepare(
      `SELECT w.usd_value, w.symbol, a.signal, a.confidence, a.prediction_outcome, a.price_at_detect, a.price_at_eval
       FROM whales w JOIN analysis a ON a.whale_id = w.id
       WHERE a.evaluated_at > ? AND a.prediction_outcome IN ('correct','wrong')
       ORDER BY w.usd_value DESC LIMIT 3`
    ).bind(since).all(),
  ]);
  const byOutcome = new Map((outcomes24?.results || []).map((r) => [r.prediction_outcome, r.n]));
  const graded24 = [...byOutcome.values()].reduce((s, n) => s + n, 0);
  if (graded24 === 0) return { skipped: "nothing_graded_yet" };

  const correct = counters.get("outcome:correct") || 0;
  const wrong = counters.get("outcome:wrong") || 0;
  const payload = {
    graded24,
    correct24: byOutcome.get("correct") || 0,
    wrong24: byOutcome.get("wrong") || 0,
    nomove24: byOutcome.get("no_move") || 0,
    accuracy: correct + wrong > 0 ? { total: correct + wrong, correct } : null,
    topCalls: topCallsQ?.results || [],
  };
  const text = renderScoreboard(payload);
  await tgSendMessage(env.BOT_TOKEN, env.PUBLIC_CHANNEL, text, { parse_mode: "" });
  try { await env.KV.put(marker, "1", { expirationTtl: 2 * 86400 }); } catch { /* best effort */ }
  return { posted: true, graded24 };
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

/**
 * Pure: does this alert clear the channel mode gate? Modes:
 *   all          — everything (current behavior, default)
 *   directional  — only bullish/bearish calls
 *   high         — directional with confidence >= 0.65
 * Set via /cfg channel_mode <mode>. Neutral events are still analyzed,
 * graded and shown on the dashboard — this only gates channel spam.
 */
export function channelAllows(mode, signal, confidence) {
  const m = String(mode || "all").toLowerCase();
  if (m === "directional") return signal === "bullish" || signal === "bearish";
  if (m === "high") return (signal === "bullish" || signal === "bearish") && (Number(confidence) || 0) >= 0.65;
  return true;
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

  // channel mode gate (flooding control): skipped alerts stay analyzed,
  // graded and on the dashboard — only channel posting is gated
  let channelMode = "all";
  try { channelMode = await env.KV.get("config:channel_mode") || "all"; } catch {}
  if (!channelAllows(channelMode, whale.signal, whale.confidence)) {
    console.log(`[bot] whale ${whaleId} held by channel_mode=${channelMode} (signal ${whale.signal}, conf ${whale.confidence})`);
    return;
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

  // "why the whale moved": match cached headlines against asset + direction
  let news = null;
  try { news = JSON.parse(await env.KV.get("news_cache") || "null"); } catch {}
  const related = relatedHeadlines(news?.headlines, whale.symbol, whale.tx_type);

  // Event clustering: count other whales to the same destination in the last 15 min.
  const clusterCount = await countCluster(env, whale.to_address, whale.chain, whale.detected_at, whaleId);
  const clusterNote = formatClusterNote(clusterCount);

  const vsRates = await getVolSpikeRates(env);
  const vsKey = vsRates ? volSpikeClass(whale.chain, whale.tx_type, whale.usd_value) : null;
  const volSpike = vsKey && vsRates[vsKey] ? vsRates[vsKey].pct : null;

  let text = formatAlert(whale, {
    headline: whale.headline,
    interpretation: whale.interpretation,
    signal: whale.signal,
    confidence: whale.confidence,
    related_factor: whale.related_factor,
  }, market, { related, volSpike });
  if (clusterNote) text = clusterNote + "\n" + text;

  // Telegram bot pacing: ~1 msg/sec per chat and channels punish bursts
  // during whale clusters. Queue consumers can afford a small wait; enforce a
  // ≥3.5s gap between channel posts via a KV timestamp marker.
  try {
    const last = parseInt(await env.KV.get("tg_last_channel_send") || "0", 10);
    const wait = 3500 - (Date.now() - last);
    if (wait > 0 && wait < 4000) await new Promise((r) => setTimeout(r, wait));
    await env.KV.put("tg_last_channel_send", String(Date.now()));
  } catch { /* pacing is best-effort */ }

  await tgSendMessage(env.BOT_TOKEN, chatId, text, {
    parse_mode: "" /* plain text */,
    reply_markup: { inline_keyboard: [[
      { text: "👍 right call", callback_data: `fb:${whaleId}:up` },
      { text: "👎 wrong call", callback_data: `fb:${whaleId}:down` },
    ]] },
  });

  // R2 export for the Python trading loop (trading_loop.py polls this)
  const alertJSON = buildAlertJSON(whale, market);
  if (alertJSON) await postAlertToR2(env, alertJSON);

  // Fire GitHub Actions (triggers trade.yml via repository_dispatch)
  if (alertJSON) await fireGitHubDispatch(env, alertJSON);

  await env.DB.prepare(
    "INSERT OR IGNORE INTO delivered (whale_id, chat_id, delivered_at) VALUES (?, ?, ?)"
  ).bind(whaleId, chatId, Date.now()).run();

  // premium DM delivery: instant copy to active subscribers (channel gets
  // the same post; subscribers get it seconds earlier, before pacing)
  try {
    const subs = await env.DB.prepare(
      "SELECT chat_id FROM subscribers WHERE status = 'active' AND expires_at > ? LIMIT 50"
    ).bind(Date.now()).all();
    for (const sub of subs?.results || []) {
      try {
        await tgSendMessage(env.BOT_TOKEN, sub.chat_id, "⚡ PREMIUM:\n\n" + text, { parse_mode: "" });
      } catch { /* blocked bot / dead chat — skip */ }
    }
  } catch (e) {
    console.warn("[bot] premium DM delivery failed:", e.message);
  }
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
  async scheduled(event, env, ctx) {
    try {
      // grade pending directional calls every 15 min (config:eval_min_age_h
      // overrides the 24h window — ops valve for demos/testing, delete when done)
      let minAge = 24;
      try { minAge = Number(await env.KV.get("config:eval_min_age_h") ?? 24); } catch {}
      const g = await gradePending(env, { minAgeHours: Number.isFinite(minAge) && minAge >= 0 ? minAge : 24 });
      console.log(`[bot] graded ${g.graded}/${g.considered} predictions (min age ${Number.isFinite(minAge) ? minAge : 24}h)`);
      // monthly raw-data retention: rollups keep forever, raw whale rows
      // past 18 months go (KEEP_RAW_DAYS toggles it for research)
      const day = new Date().getUTCDate();
      if (day === 1) {
        try {
          const keepMs = 545 * 86_400_000;
          const r = await env.DB.prepare("DELETE FROM whales WHERE detected_at < ?").bind(Date.now() - keepMs).run();
          await env.DB.prepare("DELETE FROM hourly_stats WHERE hour_bucket < ?").bind(Date.now() - 90 * 86_400_000).run();
          await env.DB.prepare("DELETE FROM exchange_netflow_hourly WHERE hour_bucket < ?").bind(Date.now() - 90 * 86_400_000).run();
          await env.DB.prepare("DELETE FROM flow_edges_hourly WHERE hour_bucket < ?").bind(Date.now() - 90 * 86_400_000).run();
          await env.DB.prepare("DELETE FROM news WHERE first_seen < ?").bind(Date.now() - 30 * 86_400_000).run();
          await env.DB.prepare("DELETE FROM webhook_seen WHERE seen_at < ?").bind(Date.now() - 7 * 86_400_000).run();
          await env.DB.prepare("DELETE FROM delivered WHERE delivered_at < ?").bind(Date.now() - 90 * 86_400_000).run();
          await env.DB.prepare("DELETE FROM price_history WHERE hour_bucket < ?").bind(Date.now() - 90 * 86_400_000).run();
          await env.DB.prepare("DELETE FROM alert_feedback WHERE created_at < ?").bind(Date.now() - 90 * 86_400_000).run();
          console.log(`[bot] retention prune: ${r.meta?.changes ?? 0} raw rows`);
        } catch (e) { console.warn("[bot] prune failed:", e.message); }
      }

            // daily scoreboard to the public channel at 18:00 UTC (analyst
      // generates the narrative brief; bot delivers — only bot touches TG)
      if (event.cron === "0 18 * * *") {
        const s = await postScoreboard(env);
        console.log(`[bot] scoreboard: ${JSON.stringify(s)}`);
      }
      if (event.cron === "0 18 * * *") {
        try {
          const brief = JSON.parse(await env.KV.get("daily_brief") || "null");
          if (brief?.text) {
            await tgSendMessage(env.BOT_TOKEN, env.PUBLIC_CHANNEL, "🌅 Daily brief\n\n" + brief.text, { parse_mode: "" });
            console.log("[bot] daily brief posted");
          }
        } catch (e) { console.warn("[bot] brief post failed:", e.message); }
      }
    } catch (e) {
      console.error("[bot] scheduled failed:", e.message);
    }
  },
};
