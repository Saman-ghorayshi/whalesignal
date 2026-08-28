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
  // behavioral labels beat exchange plumbing: a treasury print or bridge
  // hop tells a better story than "one side is an exchange"
  if (fromType === "treasury") return { tx_type: "mint" };
  if (toType === "treasury") return { tx_type: "burn" };
  if (fromType === "bridge" || toType === "bridge") return { tx_type: "bridge_flow" };
  if (fromType === "miner" || toType === "miner") return { tx_type: "miner_flow" };

  const fromEx = fromType === "exchange";
  const toEx = toType === "exchange";
  if (fromEx && toEx) return { tx_type: "exchange_internal" };
  if (!fromEx && toEx) return { tx_type: "exchange_inflow" };
  if (fromEx && !toEx) return { tx_type: "exchange_outflow" };
  return { tx_type: "wallet_to_wallet" };
}

/** ERC20 mint/burn sentinels — Transfer events touching these are supply ops. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_SUFFIXES = ["dead", "dEaD", "DEAD"];

/**
 * True when the address is a conventional burn sink (0x0 or ...dEaD).
 * Pure, case-tolerant.
 */
export function isBurnSink(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase();
  if (a === ZERO_ADDRESS) return true;
  return DEAD_SUFFIXES.some((sfx) => a.endsWith(sfx));
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
  const { headers = {}, timeoutMs = 8000, maxBytes = 0, method = "GET", body } = opts;
  // Workers send no User-Agent by default and some public APIs (CoinGecko)
  // 403 requests without one. Merge caller headers over a descriptive default.
  const allHeaders = {
    "User-Agent": "whalesignal/1.0 (Cloudflare Worker; +https://github.com/Saman-ghorayshi/whalesignal)",
    ...headers,
  };
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: allHeaders, signal: ctl.signal, body });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url} — ${body.slice(0, 200)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    // size gate: a payload too big to parse within the free-tier CPU budget
    // would otherwise kill the whole invocation (exceededCpu can't be caught).
    // Caller decides what "too big" means; 0 disables the check.
    if (maxBytes > 0) {
      const len = parseInt(res.headers.get("content-length") || "0", 10);
      if (len > maxBytes) {
        const err = new Error(`payload too large: ${len} bytes > ${maxBytes} limit for ${url}`);
        err.tooLarge = true;
        throw err;
      }
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
 */
export async function tgSendMessage(botToken, chatId, text, opts = {}) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode ?? "Markdown",
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
  };
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
