// src/worker-utils.js
// Shared helpers used by scanner/analyst/bot. Pure functions where possible
// so tests can import them without a Workers runtime.
//
// Exported:
//   fetchJSON(url, {headers, timeoutMs})    -> throws AbortError on timeout
//   classifyTx(fromLabel, toLabel)           -> { tx_type: 'exchange_inflow'|... }  (pure)
//   shortAddr(addr, head=6, tail=4)          -> "0x28C6...d3c4"   (pure)
//   usdValue(amount, symbol, market)         -> number            (pure)
//   labelFor(address, walletMap)             -> label string|null (pure)
//   buildWalletMap(rows)                     -> Map addr->{label,type}  (pure)
//   raiseRateLimited(env)                    -> Response 429
//   errJson(msg, status=500)                 -> Response JSON
//   okJson(payload)                          -> Response JSON
//   nowMs()                                  -> Date.now() wrapper (mockable)
//
// Note on KV/D1/Queue: we pass them via `env`, not import them. The three
// workers get env from the runtime; tests construct a fake env.

export const WALLETS_TABLE = "wallets";

// ─── pure utility helpers ────────────────────────────────────────────

/** Shorten an address: "0x28C6c0...d3c4" / "bc1qgd...ud7p" */
export function shortAddr(addr, head = 6, tail = 4) {
  if (!addr) return "";
  const a = String(addr);
  if (a.length <= head + tail + 1) return a; // not long enough to truncate
  return `${a.slice(0, head)}...${a.slice(-tail)}`;
}

/** Look up label for an address in a wallet Map built by buildWalletMap(). */
export function labelFor(address, walletMap) {
  if (!address || !walletMap) return null;
  // try exact, also try lowercase for evm
  const e = walletMap.get(address) ?? walletMap.get(String(address).toLowerCase());
  return e ? e.label : null;
}

/** Normalize a wallet-row array into a Map keyed by (lowercase for evm) address. */
export function buildWalletMap(rows) {
  const m = new Map();
  if (!rows) return m;
  for (const r of rows) {
    if (!r || !r.address) continue;
    m.set(String(r.address).toLowerCase(), { label: r.label, type: r.type, chain: r.chain });
    // also keep raw for non-evm chains where case matters (btc)
    m.set(String(r.address), { label: r.label, type: r.type, chain: r.chain });
  }
  return m;
}

/**
 * Classify a tx direction based on labels of from/to.
 * Pure. Returns { tx_type } — exchange_inflow | exchange_outflow |
 * exchange_internal | wallet_to_wallet | unknown.
 */
export function classifyTx(fromType, toType) {
  const fromEx = fromType === "exchange";
  const toEx = toType === "exchange";
  if (fromEx && toEx) return { tx_type: "exchange_internal" };
  if (!fromEx && toEx) return { tx_type: "exchange_inflow" };
  if (fromEx && !toEx) return { tx_type: "exchange_outflow" };
  return { tx_type: "wallet_to_wallet" };
}

/**
 * Multiply amount by the cached market price for `symbol`.
 * Pure. `market` is the KV market_cache object.
 * Returns NaN if price is missing — caller should skip those whales rather
 * than inserting a NaN usd_value into D1.
 */
export function usdValue(amount, symbol, market) {
  if (!market) return NaN;
  const s = String(symbol).toLowerCase();
  const p = market[s]?.price ?? market[s + "_price"] ?? null;
  if (p == null) return NaN;
  return amount * p;
}

/** Current time in ms. indirection so tests can stub it. */
export function nowMs() {
  return Date.now();
}

// ─── HTTP helpers ────────────────────────────────────────────────────

/**
 * fetch + JSON parse with a timeout. AbortController cap is critical on
 * Workers — without it a slow API can burn the whole request envelope.
 */
export async function fetchJSON(url, opts = {}) {
  const { headers = {}, timeoutMs = 8000 } = opts;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url} — ${body.slice(0, 200)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

/** Standard JSON HTTP responses for the webhook worker. */
export function okJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errJson(msg, status = 500) {
  return okJson({ ok: false, error: msg }, status);
}

/** Telegram webhook: when over the rate cap, return 429 so Telegram retries later. */
export function rateLimited() {
  return new Response('{"ok":false,"error":"rate_limited"}', {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "15" },
  });
}

// ─── Telegram ────────────────────────────────────────────────────────

/**
 * Send a message via Telegram bot sendMessage. Returns the JSON response.
 * Throws on non-ok.
 *
 * parse_mode is OPT-IN ONLY and defaults to plain text (the key is omitted).
 * LLM-generated text breaks Telegram's Markdown parser (BT3: a single `*`
 * or `_` in AI output → 400 "can't parse entities" → retry loops), and an
 * empty-string parse_mode is not a documented Telegram value. Callers that
 * genuinely want Markdown must pass { parse_mode: "Markdown" } AND mdEscape()
 * every interpolated value.
 */
export async function tgSendMessage(botToken, chatId, text, opts = {}) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
  };
  if (opts.parse_mode) body.parse_mode = opts.parse_mode; // omit = plain text
  if (opts.reply_markup) body.reply_markup = opts.reply_markup;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (!j.ok) {
      const err = new Error(`Telegram sendMessage failed: ${j.description || "unknown"}`);
      err.payload = j;
      throw err;
    }
    return j;
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Send a photo (by URL) with a caption. Used for whale alerts with a
 * QuickChart price chart. Falls back gracefully — callers should catch and
 * fall back to tgSendMessage when the photo send fails.
 */
export async function tgSendPhoto(botToken, chatId, photoUrl, caption, opts = {}) {
  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  const body = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    disable_web_page_preview: true,
  };
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (!j.ok) {
      const err = new Error(`Telegram sendPhoto failed: ${j.description || "unknown"}`);
      err.payload = j;
      throw err;
    }
    return j;
  } finally {
    clearTimeout(tid);
  }
}

// ─── number formatting ────────────────────────────────────────────────

/** Format an integer-ish USD value with M/B suffixes. "$33.5M" or "$1.2B". */
export function fmtUSD(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Markdown-escape characters that break Telegram's Markdown parser. */
export function mdEscape(s) {
  if (s == null) return "";
  return String(s).replace(/([_*`\[\](){}~>#+=|\\.!-])/g, "\\$1");
}

// ─── Telegram safety helpers (BT4, S2, BT10) ──────────────────────────

/** Telegram hard limit is 4096 chars; we cap below it to leave headroom. */
export const TG_SAFE_MAX_LEN = 4000;

/**
 * Truncate text to a Telegram-safe length, code-point-safe (no split
 * surrogate pairs / emoji). Appends a truncation marker so readers know
 * content was cut. BT4: without this, long AI output → Telegram 400
 * "message is too long" → queue retry ×3 → silent alert loss.
 */
export function truncateTelegram(text, maxLen = TG_SAFE_MAX_LEN) {
  const s = String(text ?? "");
  const pts = Array.from(s); // code-point-safe: emoji count as one
  if (pts.length <= maxLen) return s;
  return pts.slice(0, maxLen).join("") + "\n…(truncated)";
}

/**
 * Sanitize LLM-generated text before it is posted to a public channel (S2).
 * Strips C0 control characters (keeping \n and \t), trims, and caps length.
 * This is a hygiene layer, not a security boundary: the channel sends plain
 * text (no parse_mode), so there is no markup-injection vector, but control
 * characters and multi-KB model ramblings still don't belong in an alert.
 */
export function sanitizeAIText(s, maxLen = 2000) {
  if (s == null) return "";
  const cleaned = String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  const pts = Array.from(cleaned);
  if (pts.length <= maxLen) return cleaned;
  return pts.slice(0, maxLen).join("").trimEnd() + "…";
}

/**
 * Constant-time string comparison for secrets (webhook secret_token, etc.).
 * Length is checked first (lengths of real secrets aren't secret).
 * Uses crypto.subtle.timingSafeEqual where available (Workers), otherwise a
 * manual constant-time loop so it also works under node:test.
 */
export function secretsEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  const ex = new TextEncoder().encode(x);
  const ey = new TextEncoder().encode(y);
  if (ex.length !== ey.length) return false;
  const tse = globalThis.crypto?.subtle?.timingSafeEqual;
  if (typeof tse === "function") {
    try {
      // Workers' subtle.timingSafeEqual returns a boolean synchronously.
      const r = tse.call(globalThis.crypto.subtle, ex, ey);
      return r === true;
    } catch {
      return false;
    }
  }
  let diff = 0;
  for (let i = 0; i < ex.length; i++) diff |= ex[i] ^ ey[i];
  return diff === 0;
}

/**
 * Admin auth for diagnostic HTTP endpoints. Fail-closed: if ADMIN_TOKEN
 * is not configured, nobody is authorized. Accepts ?key= or x-admin-key.
 */
export function isAuthorizedAdmin(request, env) {
  const secret = env?.ADMIN_TOKEN;
  if (!secret) return false;
  let provided = null;
  try {
    provided = new URL(request.url).searchParams.get("key");
  } catch { /* ignore */ }
  if (!provided && request.headers?.get) {
    provided = request.headers.get("x-admin-key");
  }
  return secretsEqual(provided || "", secret);
}

/**
 * KV-backed fixed-window rate limiter. Returns { ok, limited, remaining?,
 * retryAfterSec? }. Fail-OPEN when KV is missing (tests, local dev) with a
 * warning — production always has KV bound. Concurrent increments can race;
 * this is a soft abuse throttle, not an accounting primitive.
 *
 * @param {object} env — worker env (needs env.KV)
 * @param {string} key — bucket id, e.g. `tgcmd:12345`
 * @param {number} maxHits — allowed hits per window
 * @param {number} windowSec — window length in seconds
 */
// In-memory rate limit store (per-isolate). No KV writes — prevents
// KV write-quota exhaustion attacks. Per-isolate is fine for best-effort
// rate limiting; a determined attacker with many IPs was already bypassing
// per-IP limits anyway.
const _rlStore = new Map();

export async function checkRateLimit(env, key, maxHits = 10, windowSec = 60) {
  const now = Date.now();
  const rlKey = `rl:${key}`;
  let state = _rlStore.get(rlKey);

  // Cleanup expired entries opportunistically (avoid unbounded growth)
  if (_rlStore.size > 10000) {
    for (const [k, v] of _rlStore) {
      if (v.resetAt && now >= v.resetAt) _rlStore.delete(k);
      if (_rlStore.size <= 5000) break;
    }
  }

  if (!state || typeof state.count !== "number" || (state.resetAt && now >= state.resetAt)) {
    _rlStore.set(rlKey, { count: 1, resetAt: now + windowSec * 1000 });
    return { ok: true, limited: false, remaining: maxHits - 1 };
  }
  if (state.count >= maxHits) {
    return {
      ok: false,
      limited: true,
      retryAfterSec: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
    };
  }
  state.count += 1;
  _rlStore.set(rlKey, state);
  return { ok: true, limited: false, remaining: maxHits - state.count };
}

/**
 * D1 safe-mode guard — prevents burn-loop when the free-tier quota is hit.
 *
 * How it works:
 * - When any worker catches a D1 quota/lock error, it calls noteD1Lock(env).
 * - noteD1Lock sets a KV flag `d1_safe_mode` with 6h TTL.
 * - Workers call isD1SafeMode(env) before heavy D1 work; if set, they skip
 *   the D1 work for this tick (log + return) instead of hammering a locked DB.
 * - The flag auto-expires; workers resume on next tick after expiry.
 * - In-memory cache per isolate avoids a KV read on every check.
 */
let _d1SafeCache = { value: false, at: 0 };
const D1_SAFE_TTL_MS = 6 * 3600 * 1000;
const D1_SAFE_CACHE_MS = 60000;

export function isD1LockedError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  // Tight matching: a naive `includes("limit")` false-positives on URLs like
  // "?limit=200" in unrelated fetch errors (caught live: TRON scan engaged
  // safe mode because the TronGrid URL contained "&limit=200").
  // Real D1 quota errors look like: "exceeded D1's free tier daily row read
  // limit ... [code: 7500]".
  if (msg.includes("code: 7500")) return true;
  if (msg.includes("d1_error")) return true;
  if (msg.includes("d1") && msg.includes("exceeded")) return true;
  if (msg.includes("row read limit") || msg.includes("daily row")) return true;
  if (msg.includes("quota exceeded")) return true;
  return false;
}

export async function noteD1Lock(env) {
  try {
    await env.KV.put("d1_safe_mode", String(Date.now()), { expirationTtl: 6 * 3600 });
  } catch {}
  _d1SafeCache = { value: true, at: Date.now() };
  console.warn("[d1] safe mode ENGAGED — quota/lock detected, D1 work paused 6h");
}

export async function isD1SafeMode(env) {
  if (Date.now() - _d1SafeCache.at < D1_SAFE_CACHE_MS) return _d1SafeCache.value;
  try {
    const raw = await env.KV.get("d1_safe_mode");
    const locked = !!raw && (Date.now() - parseInt(raw, 10)) < D1_SAFE_TTL_MS;
    _d1SafeCache = { value: locked, at: Date.now() };
    return locked;
  } catch {
    return _d1SafeCache.value;
  }
}

export async function clearD1SafeMode(env) {
  try { await env.KV.delete("d1_safe_mode"); } catch {}
  _d1SafeCache = { value: false, at: Date.now() };
}
