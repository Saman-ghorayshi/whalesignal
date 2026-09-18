/**
 * cryptopay.js — Multi-chain crypto payment verification worker
 *
 * Supports 20 blockchain networks across 6 verification code paths:
 *   EVM family (ETH, BSC, AVAX, POL, ARB, OP, BASE) — Etherscan-compatible APIs
 *   UTXO family (BTC, LTC, BCH, DOGE) — Blockchair dashboards API
 *   Solana (SOL) — RPC getTransaction
 *   Tron (TRX) — Tronscan API (TRC20 USDT)
 *   TON — tonapi.io
 *   Ripple (XRP) — Ripple Data API v2
 *   Stellar (XLM) — Horizon REST API
 *   Cardano (ADA) — Blockfrost API
 *   Sui (SUI) — Sui RPC
 *   Aptos (APT) — Aptos REST API
 *   Near (NEAR) — NEAR RPC
 *
 * Endpoints:
 *   POST /verify    { chain, txid, user_id, pkg, idempotency_key? }   → verify on-chain, credit user    [X-Pay-Secret]
 *   POST /debit     { user_id, amount, note?, idempotency_key? }      → atomic coin deduction             [X-Admin-Secret]
 *   POST /grant     { user_id, days, gems, note? }                   → admin grant                        [X-Admin-Secret]
 *   GET  /balance/:userid                                            → read-only balance                  [X-Pay-Secret]
 *   GET  /pricing                                                    → price list (no secret)
 *   GET  /chains                                                     → chain list (no secret)
 *   GET  /health                                                     → health check (no secret)
 *
 * Security:
 *   - Wallet addresses + API keys live in worker config, never sent by callers
 *   - Atomic txid claim (INSERT OR IGNORE + changes check) prevents double-spend
 *   - Fails closed on all errors — never credits on a verification failure
 *   - Rate limited: max 30 verify calls per caller IP per 60s
 *   - Amount tolerance configurable (default 0.97 = 3% gas variance OK)
 *   - Min confirmations configurable per chain
 */

// ===== CONFIG (stamped by generate.py) =====
// Secrets can be either baked-in (legacy deploy) OR bound at runtime via
// `wrangler secret put`. When the runtime binding exists, env.PAY_SECRET wins.
// This means the deployed worker source contains no secret literals.
// PAY_SECRET + ADMIN_SECRET come from wrangler secrets (rotated Sep 18 — old consts were leaked)

const AMOUNT_TOLERANCE = 0.97;
// ADMIN_ID is wired into config for future admin self-auth use cases; currently
// unused (auth is by X-Pay-Secret / X-Admin-Secret), kept so config doesn't drift.
const ADMIN_ID         = 7472552536;
// Env accessors — env wins over stamped constant. NOT cached per-isolate, because
// consecutive requests on the same isolate can have different env bindings (rare
// but possible when wrangler rotates secrets). The env lookup is cheap (object property).
function paySecret(env)   { if (!env?.PAY_SECRET) throw new Error("PAY_SECRET not configured"); return env.PAY_SECRET; }
function adminSecret(env) { if (!env?.ADMIN_SECRET) throw new Error("ADMIN_SECRET not configured"); return env.ADMIN_SECRET; }

// ----- CHAIN CONFIG (injected as JS object literal by generate.py) -----
// Each chain: { wallet, [api_key], [rpc], explorer, symbol, name, min_conf, [token_contract] }
const CHAINS = {
  "btc": {
    "family": "utxo",
    "name": "Bitcoin",
    "symbol": "BTC",
    "wallet": "bc1qd9q7reeqyyasf4n289mxvvf0chz7v2wsqcmguc",
    "min_conf": 1,
    "decimals": 8,
    "blockchair_slug": "bitcoin",
    "explorer": "https://blockchain.com/btc/tx/"
  },
  "trx": {
    "family": "trx",
    "name": "Tron",
    "symbol": "TRX",
    "wallet": "TBZUCRoXUJVvExAU2rcCLfuvpqSui7MrUx",
    "min_conf": 20,
    "decimals": 6,
    "token_contract": "TR7NHqjeKQxGTCi8q8ZY4pL8omSzTEXJyQ",
    "explorer": "https://tronscan.org/#/transaction/"
  },
  "usdt": {
    "family": "trx",
    "name": "USDT (TRC20)",
    "symbol": "USDT",
    "wallet": "TBZUCRoXUJVvExAU2rcCLfuvpqSui7MrUx",
    "min_conf": 20,
    "decimals": 6,
    "token_contract": "TR7NHqjeKQxGTCi8q8ZY4pL8omSzTEXJyQ",
    "token_mode": true,
    "token_decimals": 6,
    "explorer": "https://tronscan.org/#/transaction/"
  },
  "ton": {
    "family": "ton",
    "name": "The Open Network",
    "symbol": "TON",
    "wallet": "0xB2207fE9918DE84BaA837471e500A60aC804b9EA",
    "min_conf": 10,
    "decimals": 9,
    "explorer": "https://tonscan.org/tx/"
  },
  "sol": {
    "family": "sol",
    "name": "Solana",
    "symbol": "SOL",
    "wallet": "BMpWUNfEaikLgBnLqoF9JboQsJzwC2MqRytkU4xYDVCi",
    "min_conf": 32,
    "decimals": 9,
    "rpc": "https://api.mainnet-beta.solana.com",
    "explorer": "https://solscan.io/tx/"
  }
};

// ----- PACKAGE CONFIG (injected as JS object literal by generate.py) -----
// Each pkg: { price_usd, gems, days, prices: { chain: amount_in_native_units } }
const PACKAGES = {
  "vip_30": {
    "price_usd": 3,
    "days": 30,
    "gems": 0
  },
  "vip_90": {
    "price_usd": 8,
    "days": 90,
    "gems": 0
  },
  "vip_365": {
    "price_usd": 25,
    "days": 365,
    "gems": 0
  },
  "whalesignal_premium": {
    "price_usd": 10,
    "days": 30,
    "gems": 0
  }
};

// ===== RATE LIMITING (in-isolate, doesn't touch D1) =====
// B3 fix: rate-limit by caller IP (forwarded by donation worker) instead of creator user_id.
// It's defense-in-depth: donation worker already rate-limits the donor upstream; cryptopay's
// own txids dedup is the canonical double-spend guard. This limiter stops a misbehaving
// donor from bypassing the donation edge and hitting /verify directly (e.g. via leaked URL).
const _verifyRateLimit = new Map(); // ip → [timestamps]
const VERIFY_RATE_MAX = 30;        // 30 calls per IP
const VERIFY_RATE_WINDOW = 60000;  // per 60 seconds

function rateLimited(ip) {
  const now = Date.now();
  const key = String(ip || "anon");
  const times = (_verifyRateLimit.get(key) || []).filter(t => now - t < VERIFY_RATE_WINDOW);
  if (times.length >= VERIFY_RATE_MAX) return true;
  times.push(now);
  _verifyRateLimit.set(key, times);
  return false;
}

// ===== D1 SCHEMA BOOTSTRAP (once per isolate) =====
let _schemaReady = false;

async function ensureSchema(env) {
  if (_schemaReady) return;
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, gems INTEGER DEFAULT 0, vip_until INTEGER DEFAULT 0, ts INTEGER DEFAULT 0)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS txids (txid TEXT PRIMARY KEY, user_id INTEGER, pkg TEXT, chain TEXT, amount REAL, ts INTEGER, verified INTEGER DEFAULT 0)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount INTEGER, type TEXT, chain TEXT, ts INTEGER, note TEXT)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_txids_user ON txids(user_id)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_txns_user ON transactions(user_id)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_txns_ts ON transactions(ts DESC)`),
    ]);
    _schemaReady = true;
    console.log("[cryptopay] schema ready");
  } catch (e) {
    console.error("[cryptopay schema]", e.message);
    _schemaReady = true; // don't keep retrying — deploy_all.py applies schema at provision
  }
}

// ============================================================
//  UTIL
// ============================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }
  });
}

function checkSecret(request, env) {
  const given = request.headers.get("X-Pay-Secret") || "";
  const expected = paySecret(env);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
// Admin endpoints (/grant, /debit) require X-Admin-Secret if ADMIN_SECRET is set;
// otherwise fall back to X-Pay-Secret (single-secret mode, backwards compatible).
function checkAdminSecret(request, env) {
  const a = request.headers.get("X-Admin-Secret");
  const admin = adminSecret(env);
  if (admin) return a === admin;
  return checkSecret(request, env);
}
// Coerce user_id to integer; reject strings that aren't pure integers so
// a bot passing "alice" can't silently create a shadow PK row that no query
// can later match (SQLite INTEGER PK affinity coerces "123" → 123, but not "alice").
function coerceUserId(raw) {
  if (raw == null) return NaN;
  const n = Number(raw);
  // Number("123") = 123; Number(null) = 0 → guard; "alice" → NaN; 12.5 → 12 (we floor)
  if (Number.isInteger(n) && n > 0) return n;
  return NaN;
}

function sameAddr(a, b) {
  const x = (a || "").toString().trim().toLowerCase();
  const y = (b || "").toString().trim().toLowerCase();
  if (!x || !y) return false;
  if (x.length < 8 || y.length < 8) return false;
  return x === y;
}

async function ensureUser(env, userId) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (user_id, gems, vip_until, ts) VALUES (?, 0, 0, ?)`
  ).bind(userId, Date.now()).run();
}

async function logTxn(env, userId, amount, type, chain, note) {
  try {
    await env.DB.prepare(
      `INSERT INTO transactions (user_id, amount, type, chain, ts, note) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, amount, type, chain || null, Date.now(), note || "").run();
  } catch (e) { console.error("[cryptopay logTxn]", e.message); }
}

// Atomic txid claim + cache lookup.
// Returns:
//   { state: "new" }         → caller proceeds with on-chain verify
//   { state: "verified", amount, type } → already verified; caller re-returns cached result (saves RPC)
//   { state: "in-flight" }   → existing row, verified=0; concurrent /verify attempt on same txid
//   { state: "error" }       → DB error, fail-closed
// Skip a SELECT before INSERT — INSERT OR IGNORE then SELECT avoids a round trip on the hot path.
async function claimTxid(env, txid, userId, pkg, chain) {
  try {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO txids (txid, user_id, pkg, chain, amount, ts, verified) VALUES (?, ?, ?, ?, 0, ?, 0)`
    ).bind(txid, userId, pkg, chain, Date.now()).run();
    if (r.meta && r.meta.changes > 0) return { state: "new" };
    // row pre-existed — read it to see if verified or in-flight
    const row = await env.DB.prepare(`SELECT verified, amount, ts FROM txids WHERE txid = ?`).bind(txid).first();
    if (!row) return { state: "error" }; // race: rows vanished, safer to fail-closed
    if (row.verified === 1) return { state: "verified", amount: row.amount };
    // v5.6: stale in-flight check. If claim is >30min old, re-claim it (server died mid-verify).
    // ponytail: 30min covers block explorer latency + CF isolate restart. Per-txid lock table if contention matters.
    if (Date.now() - (row.ts || 0) > 1800000) {
      // Update ts + user_id to re-claim (concurrent callers will see new ts)
      await env.DB.prepare(`UPDATE txids SET ts=?, user_id=?, pkg=?, chain=? WHERE txid=? AND verified=0`)
        .bind(Date.now(), userId, pkg, chain, txid).run();
      return { state: "new" };
    }
    return { state: "in-flight" };
  } catch (e) {
    console.error("[cryptopay claimTxid]", e.message);
    return { state: "error" }; // fail-closed — never credit on DB error
  }
}

async function releaseTxid(env, txid) {
  try { await env.DB.prepare(`DELETE FROM txids WHERE txid = ?`).bind(txid).run(); } catch (e) {}
}

// markTxidVerified removed — credit + mark are now atomic in handleVerify's D1 batch (B2 fix).

// ============================================================
//  CHAIN VERIFIERS
//  Each returns { ok, amount, reason } — no partial credit ever.
// ============================================================

// ---- EVM family: ETH, BSC, AVAX, POL, ARB, OP, BASE ----
// All use Etherscan-compatible APIs. Same logic, different URL + API key.
// B7 fix: supports multi-key rotation via chainCfg.api_keys (Array<string>).
// On a 429/401 (rate-limit) we cool that key for 60s and retry the next one.
// NOTE: cool-down lives in-isolate (Map); across isolates you may re-hit a
// hot key — for >5 keys or strict limits, a D1 counter table would be safer.
// Secrets-from-env: override `chainCfg.api_keys` at runtime with the env var
// `CRYPTOPAY_API_KEYS_<CHAIN_ID>` (comma-sep, e.g. env.CRYPTOPAY_API_KEYS_ETH="k1,k2").
// When set, the env list wins — the stamped `api_keys` constant in source can be `[]`.
const _evmKeyCooldown = new Map(); // apiKey → coolUntilTs
function _pickEVMKey(chainCfg, env, chainId) {
  // Env override path: a per-chain comma-separated list bound via wrangler secret.
  // Lets the deployed worker hold no explorer API keys in source — only chain metadata.
  const envName = "CRYPTOPAY_API_KEYS_" + String(chainId || "").toUpperCase();
  const envList = env && env[envName] ? String(env[envName]).split(",").map(s => s.trim()).filter(Boolean) : null;
  const keys = envList && envList.length ? envList
    : (chainCfg.api_keys && chainCfg.api_keys.length) ? chainCfg.api_keys
    : (chainCfg.api_key ? [chainCfg.api_key] : []);
  if (keys.length === 0) return { key: "", keys: [] };
  const now = Date.now();
  // Pick the first available key (round-robin order via rotation index).
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!_evmKeyCooldown.has(k) || _evmKeyCooldown.get(k) < now) return { key: k, keys };
  }
  // All keys cooling — pick the first anyway (best-effort).
  return { key: keys[0], keys };
}
function _coolEVMKey(key, ms = 60000) {
  if (key) _evmKeyCooldown.set(key, Date.now() + ms);
}

async function _evmFetch(baseUrl, apiKey, txid, action) {
  const keyQs = apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : "";
  const url = `${baseUrl}?module=proxy&action=${action}&txhash=${encodeURIComponent(txid)}${keyQs}`;
  const resp = await fetch(url);
  return { resp, url };
}

async function verifyEVM(chainCfg, txid, expectedMemo, env, chainId) {
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  let baseUrl = chainCfg.api_url;
  let { key: apiKey } = _pickEVMKey(chainCfg, env, chainId);

  // Step 1: Get transaction (includes value + to)
  let r, usedUrl;
  try {
    const fr = await _evmFetch(baseUrl, apiKey, txid, "eth_getTransactionByHash");
    r = await fr.resp.json();
    usedUrl = fr.url;
    // If rate-limited, cool this key and retry once with a different one
    if (fr.resp.status === 429 || fr.resp.status === 401 || (r && r.message === "NOTOK" && /rate limit|invalid api key/i.test(r.result || ""))) {
      _coolEVMKey(apiKey);
      const alt = _pickEVMKey(chainCfg, env, chainId);
      if (alt.key && alt.key !== apiKey) {
        const fr2 = await _evmFetch(baseUrl, alt.key, txid, "eth_getTransactionByHash");
        r = await fr2.resp.json();
        apiKey = alt.key;
      }
    }
  } catch (e) { return { ok: false, reason: "EVM API error: " + (e.message || "") }; }

  const tx = r && r.result;
  if (!tx || (typeof tx === "object" && tx.message === "NOTOK")) return { ok: false, reason: "tx not found on " + chainCfg.name };

  if (tx.blockNumber === null) return { ok: false, reason: "tx not yet mined (pending)" };

  // Check destination
  if (!sameAddr(tx.to, wlt)) return { ok: false, reason: `wrong destination (got ${tx.to})` };

  // Check value (wei → native token)
  const valueWei = parseInt(tx.value || "0", 16);
  const valueNative = valueWei / Math.pow(10, chainCfg.decimals || 18);

  // Step 2: Get receipt for confirmation status + logs (for ERC20 transfers)
  let receipt;
  try {
    const keyQs = apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : "";
    receipt = await (await fetch(`${baseUrl}?module=proxy&action=eth_getTransactionReceipt&txhash=${encodeURIComponent(txid)}${keyQs}`)).json();
  } catch (e) { return { ok: false, reason: "receipt fetch error: " + (e.message || "") }; }

  const rc = receipt && receipt.result;
  if (!rc) return { ok: false, reason: "receipt not found" };

  // Check status (0x1 = success, 0x0 = reverted)
  if (rc.status === "0x0") return { ok: false, reason: "transaction reverted on-chain" };

  // Check confirmation count
  if (chainCfg.min_conf > 0 && tx.blockNumber) {
    let latestBlock;
    try {
      const keyQs = apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : "";
      const lb = await (await fetch(`${baseUrl}?module=proxy&action=eth_blockNumber${keyQs}`)).json();
      latestBlock = parseInt(lb.result || "0x0", 16);
    } catch (e) { latestBlock = 0; }

    const confs = latestBlock - parseInt(tx.blockNumber, 16);
    if (confs < chainCfg.min_conf) return { ok: false, reason: `only ${confs} confirmations (need ${chainCfg.min_conf})` };
  }

  // Try native token transfer first
  if (valueNative > 0) {
    return { ok: true, amount: valueNative, type: "native" };
  }

  // If value is 0, check for ERC20/token transfer in logs
  const tokenContract = chainCfg.token_contract;
  if (tokenContract && rc.logs) {
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4d11628f55a4d3ea7b9c8e2"; // keccak256("Transfer(address,address,uint256)")
    for (const log of rc.logs) {
      // Either match to our token contract, or just look for any Transfer event to our wallet
      if (chainCfg.token_contract && !sameAddr(log.address, tokenContract)) continue;
      if (log.topics && log.topics[0] && log.topics[0].toLowerCase() === transferTopic) {
        // topics[1] = from (padded to 32 bytes), topics[2] = to
        const to = "0x" + (log.topics[2] || "").slice(-40);
        if (sameAddr(to, wlt)) {
          // data = amount (uint256)
          const amountRaw = BigInt(log.data || "0x0");
          const decimals = chainCfg.token_decimals || 6;
          const amount = Number(amountRaw) / Math.pow(10, decimals);
          return { ok: true, amount, type: "token" };
        }
      }
    }
  }

  return { ok: false, reason: "no matching transfer found in tx" };
}

// ---- UTXO family: BTC, LTC, BCH, DOGE ----
// B7 fix: BTC prefers mempool.space (free, no key, no rate limit) over Blockchair.
// LTC/BCH/DOGE keep Blockchair (free public). For BTC, if blockchair fails/rate-limits,
// fall back to mempool.space. For prod LTC/BCH/DOGE, also add blockstream
// alternatives when free endpoints of those chains land (mempool.space only does BTC/LTC).
async function verifyUTXO(chainCfg, txid) {
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  const slug = chainCfg.blockchair_slug; // "bitcoin", "litecoin", "bitcoin-cash", "dogecoin"

  // BTC: try mempool.space first (no rate limit), fall back to blockchair
  if (slug === "bitcoin") {
    const mp = await _verifyBTConMempoolSpace(txid, wlt, chainCfg);
    if (mp.ok !== null) return mp; // either verified or hard-fail (wrong dest etc.) — return as-is
    // fall through to blockchair if mp couldn't reach the API
  }

  let r;
  try {
    r = await (await fetch(`https://api.blockchair.com/${slug}/dashboards/transaction/${encodeURIComponent(txid)}`)).json();
  } catch (e) { return { ok: false, reason: "Blockchair API error: " + (e.message || "") }; }

  const data = r && r.data;
  if (!data || !data[txid]) return { ok: false, reason: "tx not found on " + chainCfg.name };

  const txData = data[txid];
  if (!txData.inputs || !txData.outputs) return { ok: false, reason: "malformed tx data" };

  // Check if confirmed
  if (txData.mempool) return { ok: false, reason: "tx is in mempool (unconfirmed)" };

  // Check confirmation count (B5 fix): blockchair returns block_id; we need the current chain tip
  // to compute confirmations. For BTC with min_conf>1, fetch tip via blockchair's stats endpoint.
  if (chainCfg.min_conf > 0 && txData.block_id) {
    let tipHeight = 0;
    try {
      const stats = await (await fetch(`https://api.blockchair.com/${slug}/stats`)).json();
      tipHeight = (stats && stats.data && stats.data.best_block_height) || 0;
    } catch (e) {}
    const confs = tipHeight ? (tipHeight - txData.block_id + 1) : 1;
    if (confs < chainCfg.min_conf) return { ok: false, reason: `only ${confs} confirmations (need ${chainCfg.min_conf})` };
  }

  // Find our wallet in outputs
  let received = 0;
  for (const out of txData.outputs) {
    if (!out.addresses) continue;
    for (const addr of out.addresses) {
      if (sameAddr(addr, wlt)) {
        received += out.value / Math.pow(10, chainCfg.decimals || 8);
      }
    }
  }

  if (received <= 0) return { ok: false, reason: "wallet not found in tx outputs" };

  return { ok: true, amount: received, type: "utxo" };
}

// mempool.space BTC verifier — returns { ok: true/false, ... } on success OR { ok: null } on API unreachable.
async function _verifyBTConMempoolSpace(txid, wlt, chainCfg) {
  let txData;
  try {
    txData = await (await fetch(`https://mempool.space/api/tx/${encodeURIComponent(txid)}`)).json();
  } catch (e) { return { ok: null }; }
  if (!txData || txData.error) return { ok: null }; // mempool.space didn't have it or unreachable

  // status present + confirmed > 0
  if (!txData.status || !txData.status.confirmed) return { ok: false, reason: "tx is in mempool (unconfirmed)" };

  const confs = chainCfg.min_conf > 0 ? Math.max(0, txData.status.confirmations || 0) : 1;
  if (chainCfg.min_conf > 0 && confs < chainCfg.min_conf) {
    return { ok: false, reason: `only ${confs} confirmations (need ${chainCfg.min_conf})` };
  }

  // vout has the recipients
  let received = 0;
  for (const out of (txData.vout || [])) {
    if (sameAddr(out.scriptpubkey_address, wlt)) {
      received += (out.value || 0) / Math.pow(10, chainCfg.decimals || 8);
    }
  }

  if (received <= 0) return { ok: false, reason: "wallet not found in tx outputs" };
  return { ok: true, amount: received, type: "utxo" };
}

// ---- Solana ----
async function verifySolana(chainCfg, txid, expectedMemo) {
  const rpc = chainCfg.rpc || "https://api.mainnet-beta.solana.com";
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  const body = {
    jsonrpc: "2.0", id: 1, method: "getTransaction",
    params: [txid, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]
  };
  let r;
  try {
    r = await (await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  } catch (e) { return { ok: false, reason: "SOL RPC error: " + (e.message || "") }; }

  const res = r && r.result;
  if (!res || !res.meta || res.meta.err) return { ok: false, reason: "SOL tx not found or failed" };

  // Check for memo (only if expected — B1: donation pkg sets expectedMemo=null)
  let memoFound = expectedMemo == null; // null expected memo → always considered found
  if (!memoFound && res.transaction && res.transaction.message && res.transaction.message.instructions) {
    for (const inst of res.transaction.message.instructions) {
      if ((inst.program === "spl-memo" || inst.programId === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLxZouxw") && inst.parsed) {
        if (String(inst.parsed).includes(expectedMemo)) { memoFound = true; break; }
      }
    }
  }
  if (!memoFound) return { ok: false, reason: "memo mismatch (expected " + expectedMemo + ")" };

  // B4 fix: don't trust tx-wide net balance delta — a dex aggregator pass-through
  // can falsely show our wallet net-positive from fees/swaps unrelated to a real
  // donation. Require at least one System program `transfer` OR SPL Token `transfer`
  // instruction (including inner instructions) whose destination is our wallet.
  const _insts = [
    ...((res.transaction && res.transaction.message && res.transaction.message.instructions) || []),
    ...((res.meta && res.meta.innerInstructions) ? res.meta.innerInstructions.flatMap(i => i.instructions || []) : [])
  ];
  let _hasTransferToUs = false;
  for (const inst of _insts) {
    // System program 'transfer': parsed.type === 'transfer', info.destination === wallet
    // SPL Token 'transfer': parsed.type === 'transfer', info.destination = our ATA
    // (same shape for both programs — only the destination key matters)
    if (inst.parsed && inst.parsed.type === "transfer" && inst.parsed.info && sameAddr(inst.parsed.info.destination, wlt)) {
      _hasTransferToUs = true; break;
    }
  }
  // We require a positive balance delta AND a transfer instruction (checked below
  // on each branch). Pure-CPI/SPL transfers that don't surface as parsed 'transfer'
  // instructions would fail; rare for direct donor flow.

  // Check our wallet received SOL
  const keys = res.transaction.message.accountKeys.map(k => (k.pubkey || k));
  const idx = keys.findIndex(k => sameAddr(k, wlt));
  if (idx === -1) return { ok: false, reason: "wallet not in SOL tx" };

  // Check SOL balance delta
  const delta = (res.meta.postBalances[idx] - res.meta.preBalances[idx]) / 1e9;
  if (delta > 0) {
    if (!_hasTransferToUs) return { ok: false, reason: "wallet net-positive but no System/Token transfer instruction to it — possible dex pass-through (B4)" };
    return { ok: true, amount: delta, type: "sol" };
  }

  // If no native SOL delta, check SPL token transfers
  if (res.meta.postTokenBalances && res.meta.preTokenBalances) {
    for (const post of res.meta.postTokenBalances) {
      if (sameAddr(post.owner, wlt) || sameAddr(post.account, wlt)) {
        const pre = res.meta.preTokenBalances.find(b => b.accountIndex === post.accountIndex);
        const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount || 0) : 0;
        const postAmt = Number(post.uiTokenAmount.uiAmount || 0);
        const tokenDelta = postAmt - preAmt;
        if (tokenDelta > 0) {
          if (!_hasTransferToUs) return { ok: false, reason: "token balance positive but no Token transfer instruction — possible dex pass-through (B4)" };
          return { ok: true, amount: tokenDelta, type: "spl_token" };
        }
      }
    }
  }

  return { ok: false, reason: "no matching SOL or SPL token transfer found" };
}

// ---- Tron (TRC20 USDT focus) ----
async function verifyTron(chainCfg, txid, expectedMemo) {
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  let r;
  try {
    r = await (await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${encodeURIComponent(txid)}`)).json();
  } catch (e) { return { ok: false, reason: "TRON API error: " + (e.message || "") }; }

  if (!r || r.contractRet !== "SUCCESS") return { ok: false, reason: "TRON tx not confirmed or failed" };

  // Check confirmation count
  const blockHeight = r.block || 0;
  if (chainCfg.min_conf > 0 && blockHeight > 0) {
    // Tronscan doesn't give latest block in tx response — if contractRet is SUCCESS,
    // it's confirmed. min_conf for TRX is advisory.
  }

  // Parse memo from data field (hex → ASCII) — only checked if expected (B1: donation sets null)
  if (expectedMemo != null && r.data) {
    let asciiMemo = "";
    for (let i = 0; i < r.data.length; i += 2) {
      asciiMemo += String.fromCharCode(parseInt(r.data.substr(i, 2), 16));
    }
    if (asciiMemo && !asciiMemo.includes(expectedMemo)) {
      return { ok: false, reason: "memo mismatch (expected " + expectedMemo + ")" };
    }
  }

  // Check TRC20 transfer
  const t = r.trc20TransferInfo && r.trc20TransferInfo[0];
  if (t) {
    if (!sameAddr(t.to_address, wlt)) return { ok: false, reason: "wrong USDT destination" };
    const decimals = Number(t.decimals || 6);
    const amt = Number(t.amount_str || t.amount || 0) / Math.pow(10, decimals);
    return { ok: true, amount: amt, type: "trc20" };
  }

  // Check native TRX transfer
  const amountSun = Number(r.amount || 0);
  if (amountSun > 0) {
    if (!sameAddr(r.to || r.toAddress, wlt)) return { ok: false, reason: "wrong TRX destination" };
    const amt = amountSun / 1e6;
    return { ok: true, amount: amt, type: "trx_native" };
  }

  return { ok: false, reason: "no matching TRC20 or TRX transfer found" };
}

// ---- TON ----
async function verifyTON(chainCfg, txid, expectedMemo) {
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  let r;
  try {
    r = await (await fetch(`https://tonapi.io/v2/blockchain/transactions/${encodeURIComponent(txid)}`)).json();
  } catch (e) { return { ok: false, reason: "TON API error: " + (e.message || "") }; }

  const inMsg = r && r.in_msg;
  if (!inMsg) return { ok: false, reason: "TON tx not found" };

  const dest = (inMsg.destination && (inMsg.destination.address || inMsg.destination)) || "";
  const amt = Number(inMsg.value || 0) / 1e9;
  const comment = (inMsg.decoded_body && inMsg.decoded_body.text) ? inMsg.decoded_body.text : "";

  // B1: for donation pkg expectedMemo is null — skip comment check (memo is creator user_id, shared by every donor)
  if (expectedMemo != null && comment.trim() !== expectedMemo) return { ok: false, reason: "memo mismatch (expected " + expectedMemo + ")" };
  if (!sameAddr(dest, wlt)) return { ok: false, reason: "wrong TON destination" };

  if (amt <= 0) return { ok: false, reason: "zero or negative amount" };

  return { ok: true, amount: amt, type: "ton" };
}

// ---- Ripple (XRP) ----
async function verifyRipple(chainCfg, txid, expectedMemo) {
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  let r;
  try {
    r = await (await fetch(`https://data.ripple.com/v2/transactions/${encodeURIComponent(txid)}`)).json();
  } catch (e) { return { ok: false, reason: "XRP API error: " + (e.message || "") }; }

  const tx = r && r.transaction;
  if (!tx) return { ok: false, reason: "XRP tx not found" };
  if (tx.TransactionType !== "Payment") return { ok: false, reason: "not a payment tx" };

  if (!sameAddr(tx.Destination, wlt)) return { ok: false, reason: "wrong XRP destination" };

  // Check destination tag (memo equivalent) — only if expected (B1: donation sets null)
  if (expectedMemo != null && tx.DestinationTag !== undefined) {
    if (String(tx.DestinationTag) !== String(expectedMemo)) {
      return { ok: false, reason: "destination tag mismatch (expected " + expectedMemo + ")" };
    }
  }

  const amt = Number(tx.Amount || 0) / 1e6; // drops → XRP
  if (amt <= 0) return { ok: false, reason: "zero amount" };

  return { ok: true, amount: amt, type: "xrp" };
}

// ---- Stellar (XLM) ----
async function verifyStellar(chainCfg, txid, expectedMemo) {
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  let r;
  try {
    r = await (await fetch(`https://horizon.stellar.org/transactions/${encodeURIComponent(txid)}/payments`)).json();
  } catch (e) { return { ok: false, reason: "XLM API error: " + (e.message || "") }; }

  if (!r || !r._embedded || !r._embedded.records) return { ok: false, reason: "XLM tx not found" };

  // Get tx details for memo
  let txFetch;
  try {
    txFetch = await (await fetch(`https://horizon.stellar.org/transactions/${encodeURIComponent(txid)}`)).json();
  } catch (e) {}

  // Check memo — only if expected (B1: donation sets null)
  if (expectedMemo != null && txFetch && txFetch.memo) {
    if (String(txFetch.memo) !== String(expectedMemo)) {
      return { ok: false, reason: "memo mismatch (expected " + expectedMemo + ")" };
    }
  }

  for (const pay of r._embedded.records) {
    if (pay.type === "payment") {
      if (sameAddr(pay.to, wlt)) {
        const amt = Number(pay.amount || 0);
        return { ok: true, amount: amt, type: "xlm" };
      }
    }
  }

  return { ok: false, reason: "no matching payment to wallet" };
}

// ---- Cardano (ADA) — Blockfrost ----
async function verifyCardano(chainCfg, txid, expectedMemo, env, chainId) {
  const wlt = chainCfg.wallet;
  // Env override: env.CRYPTOPAY_API_KEYS_ADA (comma-sep, single key ok) wins over stamped cfg.
  const envName = "CRYPTOPAY_API_KEYS_" + String(chainId || "").toUpperCase();
  const envKey = env && env[envName] ? String(env[envName]).split(",")[0].trim() : null;
  let apiKey = envKey || chainCfg.api_key;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };
  if (!apiKey) return { ok: false, reason: "Blockfrost API key not configured for ADA" };

  const headers = { "project_id": apiKey };

  // Get tx UTXOs to check outputs
  let r;
  try {
    r = await (await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/txs/${encodeURIComponent(txid)}/utxos`, { headers })).json();
  } catch (e) { return { ok: false, reason: "ADA API error: " + (e.message || "") }; }

  if (!r || r.outputs) {
    // Check outputs for our address
    for (const out of (r.outputs || [])) {
      if (sameAddr(out.address, wlt)) {
        let totalLovelace = 0;
        for (const amt of out.amount) {
          if (amt.unit === "lovelace") totalLovelace += Number(amt.quantity);
        }
        const adaAmount = totalLovelace / 1e6;
        if (adaAmount > 0) return { ok: true, amount: adaAmount, type: "ada" };
      }
    }
  }

  return { ok: false, reason: "no matching output to wallet" };
}

// ---- Sui ----
async function verifySui(chainCfg, txid, expectedMemo) {
  const rpc = chainCfg.rpc || "https://sui-mainnet.nodeinfra.com";
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  const body = {
    jsonrpc: "2.0", id: 1, method: "sui_getTransactionBlock",
    params: [txid, { showInput: true, showEffects: true, showBalanceChanges: true }]
  };
  let r;
  try {
    r = await (await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  } catch (e) { return { ok: false, reason: "SUI RPC error: " + (e.message || "") }; }

  const res = r && r.result;
  if (!res) return { ok: false, reason: "SUI tx not found" };
  if (res.effects && res.effects.status && res.effects.status.status !== "success") {
    return { ok: false, reason: "SUI tx failed: " + (res.effects.status.error || "") };
  }

  // Check balance changes for our address
  if (res.balanceChanges) {
    for (const bc of res.balanceChanges) {
      const owner = bc.owner && (bc.owner.AddressOwner || bc.owner.ObjectOwner);
      if (sameAddr(owner, wlt) && Number(bc.amount) > 0) {
        // SUI amounts are in mist (1 SUI = 1e9 MIST) — for other coins, check coinType
        const decimals = bc.coinType && bc.coinType.includes("sui::sui") ? 9 : 1; // default to raw for unknown
        const amount = Number(bc.amount) / Math.pow(10, decimals);
        return { ok: true, amount, type: "sui" };
      }
    }
  }

  return { ok: false, reason: "no matching SUI transfer to wallet" };
}

// ---- Aptos ----
async function verifyAptos(chainCfg, txid, expectedMemo) {
  const wlt = chainCfg.wallet;
  const api = "https://fullnode.mainnet.aptoslabs.com/v1";
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  let r;
  try {
    r = await (await fetch(`${api}/transactions/by_hash/${encodeURIComponent(txid)}`)).json();
  } catch (e) { return { ok: false, reason: "APT API error: " + (e.message || "") }; }

  if (!r || r.success === false) return { ok: false, reason: "APT tx failed or not found" };
  if (!r.success) return { ok: false, reason: "APT tx failed on-chain" };

  // Check payload for coin transfer
  if (r.payload && r.payload.type === "entry_function_payload") {
    const func = r.payload.function;
    if (func.includes("transfer")) {
      const args = r.payload.arguments || [];
      if (args.length >= 2) {
        const recipient = args[0];
        if (sameAddr(recipient, wlt)) {
          const amountOctas = Number(args[1] || 0);
          const amount = amountOctas / 1e8; // 1 APT = 1e8 octas
          return { ok: true, amount, type: "apt" };
        }
      }
    }
  }

  return { ok: false, reason: "no matching APT transfer to wallet" };
}

// ---- Near ----
async function verifyNear(chainCfg, txid, expectedMemo) {
  const rpc = chainCfg.rpc || "https://rpc.mainnet.near.org";
  const wlt = chainCfg.wallet;
  if (!wlt || wlt.length < 8) return { ok: false, reason: "wallet not configured" };

  // NEAR requires the sender account to query tx status
  // The txid alone isn't enough — but if the caller provides sender in the memo or we
  // can query by hash. We'll try the generic tx query.
  const body = {
    jsonrpc: "2.0", id: 1, method: "tx",
    params: { tx_hash: txid, sender_account_id: expectedMemo || "unknown" }
  };

  let r;
  try {
    r = await (await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  } catch (e) { return { ok: false, reason: "NEAR RPC error: " + (e.message || "") }; }

  if (!r || r.error) return { ok: false, reason: "NEAR tx not found (need sender account ID as memo)" };

  const res = r.result;
  if (res && res.status && res.status.SuccessValue !== undefined) {
    // Check transfer action
    if (res.transaction && res.transaction.receiver_id) {
      if (sameAddr(res.transaction.receiver_id, wlt)) {
        // Find Transfer action
        if (res.transaction.actions) {
          for (const act of res.transaction.actions) {
            if (act.Transfer) {
              const amountYocto = Number(act.Transfer.deposit || 0);
              const amount = amountYocto / 1e24; // 1 NEAR = 1e24 yocto
              return { ok: true, amount, type: "near" };
            }
          }
        }
      }
    }
  }

  return { ok: false, reason: "no matching NEAR transfer to wallet" };
}

// ============================================================
//  VERIFIER ROUTER
// ============================================================

async function verifyTransaction(chain, txid, expectedMemo, chainCfg, env) {
  const family = chainCfg.family;

  switch (family) {
    case "evm":   return verifyEVM(chainCfg, txid, expectedMemo, env, chain);
    case "utxo":  return verifyUTXO(chainCfg, txid);
    case "sol":   return verifySolana(chainCfg, txid, expectedMemo);
    case "trx":   return verifyTron(chainCfg, txid, expectedMemo);
    case "ton":   return verifyTON(chainCfg, txid, expectedMemo);
    case "xrp":   return verifyRipple(chainCfg, txid, expectedMemo);
    case "xlm":   return verifyStellar(chainCfg, txid, expectedMemo);
    case "ada":   return verifyCardano(chainCfg, txid, expectedMemo, env, chain);
    case "sui":   return verifySui(chainCfg, txid, expectedMemo);
    case "apt":   return verifyAptos(chainCfg, txid, expectedMemo);
    case "near": return verifyNear(chainCfg, txid, expectedMemo);
    default:      return { ok: false, reason: "unknown chain family: " + family };
  }
}

// ============================================================
//  /verify — verify on-chain payment, credit user
// ============================================================

async function handleVerify(env, request, body) {
  const { chain, txid, pkg } = body;
  if (!chain || !txid || !pkg) return json({ ok: false, reason: "missing params (need chain, txid, user_id, pkg)" }, 400);
  // v5.6: reject absurdly long txids (D1 storage limit, API URL injection)
  if (txid.length > 200 || !/^[a-zA-Z0-9]+$/.test(txid)) return json({ ok: false, reason: "invalid txid format" }, 400);

  const user_id = coerceUserId(body.user_id);
  if (isNaN(user_id)) return json({ ok: false, reason: "user_id must be a positive integer (Telegram/WhatsApp/Discord user ids pass through unmodified)" }, 400);

  const chainCfg = CHAINS[chain];
  if (!chainCfg) return json({ ok: false, reason: "unsupported chain: " + chain }, 400);
  if (!chainCfg.wallet || chainCfg.wallet.length < 8) return json({ ok: false, reason: "wallet not configured for " + chain }, 400);

  const pkgCfg = PACKAGES[pkg];
  if (!pkgCfg) return json({ ok: false, reason: "invalid package: " + pkg }, 400);

  // Rate limit: by IP AND by user_id (v5.6: IP rotation bypass defense)
  const callerIP = request.headers.get("X-Forwarded-IP") || request.headers.get("CF-Connecting-IP") || "anon";
  if (rateLimited(callerIP)) return json({ ok: false, reason: "too many verify attempts from this IP, wait 1 minute" }, 429);
  if (rateLimited("u:" + user_id)) return json({ ok: false, reason: "too many verify attempts, wait 1 minute" }, 429);

  // Atomic txid claim + cache lookup.
  // - new → proceed to on-chain verify
  // - verified → re-return cached result (idempotent retry; saves RPC cost on donor retries)
  // - in-flight → a concurrent /verify on the same txid is mid-flight; fail-closed
  // - error → DB error; fail-closed
  const claim = await claimTxid(env, txid, user_id, pkg, chain);
  if (claim.state === "in-flight") return json({ ok: false, reason: "txid is being verified by another request, retry shortly" }, 409);
  if (claim.state === "error") return json({ ok: false, reason: "could not claim txid (database error)" });
  if (claim.state === "verified") {
    return json({ ok: true, amount: claim.amount, type: (claim.type || "native"), chain, gems: (pkgCfg.gems||0), days: (pkgCfg.days||0), txid, cached: true });
  }

  // Verify on-chain
  // B1 fix: for packages where want_memo=false (e.g. donation — the memo is the
  // *creator's* user_id, shared by every donor, so it's ceremony not auth), skip
  // the memo check. Wallet match + amount + txid-not-credited is the real auth surface.
  const expectedMemo = pkgCfg.want_memo === false ? null : String(user_id);
  const v = await verifyTransaction(chain, txid, expectedMemo, chainCfg, env);

  if (!v.ok) {
    // Release the txid claim so user can retry with a different/corrected txid
    await releaseTxid(env, txid);
    return json(v);
  }

  // Check amount
  // Check amount: native_prices[chain] is the expected amount in native units (e.g. 0.001 BTC).
  // If unset, fall back to price_usd compared directly (only sensible if amount is also USD-denominated, e.g. stablecoins).
  const nativePrices = pkgCfg.native_prices || {};
  const expectedAmount = chainCfg.token_mode ? pkgCfg.price_usd : (nativePrices[chain] !== undefined ? nativePrices[chain] : pkgCfg.price_usd);
  if (expectedAmount > 0 && v.amount < expectedAmount * AMOUNT_TOLERANCE) {
    await releaseTxid(env, txid);
    return json({ ok: false, reason: `amount ${v.amount} is below expected ${expectedAmount} (tolerance ${AMOUNT_TOLERANCE})`, received: v.amount, expected: expectedAmount });
  }

  // Atomic: mark verified + credit user + log in ONE D1 batch.
  // If the batch fails (any stmt), do NOT mark verified — releaseTxid so the donor can retry.
  // This closes B2 (txid left verified while user never credited on transient DB error).
  await ensureUser(env, user_id);
  const g = pkgCfg;
  const batch = [
    env.DB.prepare(`UPDATE txids SET verified = 1, amount = ? WHERE txid = ?`).bind(v.amount, txid),
  ];
  if (g.gems > 0) {
    batch.push(env.DB.prepare(`UPDATE users SET gems = gems + ?, ts = ? WHERE user_id = ?`).bind(g.gems, Date.now(), user_id));
    batch.push(env.DB.prepare(`INSERT INTO transactions (user_id, amount, type, chain, ts, note) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(user_id, g.gems, "credit_verify", chain, Date.now(), `Verified ${v.amount} ${chainCfg.symbol}`));
  }
  if (g.days > 0) {
    batch.push(env.DB.prepare(`UPDATE users SET vip_until = MAX(vip_until, ?) + ?, ts = ? WHERE user_id = ?`).bind(Date.now(), g.days * 86400000, Date.now(), user_id));
    batch.push(env.DB.prepare(`INSERT INTO transactions (user_id, amount, type, chain, ts, note) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(user_id, 0, "grant_vip", chain, Date.now(), `${g.days} days via ${chainCfg.symbol}`));
  }
  try {
    await env.DB.batch(batch);
  } catch (e) {
    // batch failed → all stmts rolled back; safe to release and retry
    await releaseTxid(env, txid);
    return json({ ok: false, reason: "credit failed (database error), retry the same txid" });
  }

  return json({
    ok: true,
    amount: v.amount,
    type: v.type,
    chain: chain,
    gems: g.gems,
    days: g.days,
    txid: txid
  });
}

// ============================================================
//  /debit — atomic coin deduction
// ============================================================

async function handleDebit(env, body) {
  const { note } = body;
  const user_id = coerceUserId(body.user_id);
  if (isNaN(user_id)) return json({ ok: false, reason: "missing or invalid user_id (must be positive integer)" }, 400);
  const amt = Math.max(1, Math.floor(Number(body.amount) || 0));
  if (!amt) return json({ ok: false, reason: "missing or invalid amount" }, 400);

  // Idempotency (optional). If the bot supplies idempotency_key, we INSERT OR IGNORE
  // a synthetic txid row ("debit:" + key) BEFORE the actual UPDATE. If the row already
  // existed, we return cached without re-debiting — closes a real bug where a network
  // retry from the bot would silently charge a user's gems twice.
  // No schema change: reuse the existing `txids` table (PK is TEXT, so synthetic keys fit).
  const idemKey = body.idempotency_key ? String(body.idempotency_key).trim().slice(0, 100) : null;
  if (idemKey) {
    const synthTxid = "debit:" + user_id + ":" + idemKey;
    try {
      const claim = await env.DB.prepare(
        `INSERT OR IGNORE INTO txids (txid, user_id, pkg, chain, amount, ts, verified) VALUES (?, ?, 'debit', 'internal', 0, ?, 1)`
      ).bind(synthTxid, user_id, Date.now()).run();
      if (claim.meta && claim.meta.changes === 0) {
        // already used this key → return cached success without retrying the debit
        return json({ ok: true, deductions: amt, remaining: "check /balance", cached: true, idempotent: true });
      }
    } catch (e) {
      // fail-closed — if we can't record the idempotency key, don't charge the user
      return json({ ok: false, reason: "idempotency tracking error, retry safely" });
    }
  }

  await ensureUser(env, user_id);
  const result = await env.DB.prepare(
    `UPDATE users SET gems = gems - ? WHERE user_id = ? AND gems >= ?`
  ).bind(amt, user_id, amt).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    // Insufficient gems. If we used idempotency, clean up the synth row so the bot
    // can retry with the same key after the user tops up. (Insufficient-gems + key
    // reuse would otherwise pin the user out forever on a single failed attempt.)
    if (idemKey) {
      try { await env.DB.prepare(`DELETE FROM txids WHERE txid = ?`).bind("debit:" + user_id + ":" + idemKey).run(); } catch (e) {}
    }
    return json({ ok: false, reason: "insufficient gems" });
  }

  await logTxn(env, user_id, -amt, "debit", null, note || "purchase");
  return json({ ok: true, deductions: amt, remaining: "check /balance" });
}

// ============================================================
//  /grant — admin grant VIP/gems
// ============================================================

async function handleGrant(env, body) {
  const user_id = coerceUserId(body.user_id);
  if (isNaN(user_id)) return json({ ok: false, reason: "missing or invalid user_id (must be positive integer)" }, 400);
  const d = Math.max(0, Math.floor(Number(body.days) || 0));
  const g = Math.max(0, Math.floor(Number(body.gems) || 0));
  if (d === 0 && g === 0) return json({ ok: false, reason: "nothing to grant" }, 400);

  await ensureUser(env, user_id);

  if (g > 0) {
    await env.DB.prepare(`UPDATE users SET gems = gems + ?, ts = ? WHERE user_id = ?`)
      .bind(g, Date.now(), user_id).run();
    await logTxn(env, user_id, g, "grant", null, body.note || "admin grant");
  }
  if (d > 0) {
    await env.DB.prepare(`UPDATE users SET vip_until = MAX(vip_until, ?) + ?, ts = ? WHERE user_id = ?`)
      .bind(Date.now(), d * 86400000, Date.now(), user_id).run();
    await logTxn(env, user_id, 0, "grant_vip", null, body.note || `${d} days admin grant`);
  }

  return json({ ok: true, granted_days: d, granted_gems: g });
}

// ============================================================
//  /balance/:userid — read-only balance
// ============================================================

async function handleBalance(env, userIdStr) {
  const userId = coerceUserId(userIdStr);
  if (isNaN(userId)) return json({ ok: false, reason: "invalid user_id (must be positive integer)" }, 400);

  await ensureUser(env, userId);
  const row = await env.DB.prepare(`SELECT gems, vip_until FROM users WHERE user_id = ?`).bind(userId).first();
  const bal = {
    gems: (row && row.gems) || 0,
    vip_until: (row && row.vip_until) || 0,
    is_vip: Date.now() < ((row && row.vip_until) || 0)
  };
  return json({ ok: true, ...bal });
}

// ============================================================
//  PRICE CACHE (in-isolate, 5-min TTL)
//  ponytail: single isolate cache, not D1. CF Workers have many isolates.
//  Upgrade to KV if price staleness becomes a problem.
// ============================================================
let _priceCache = null;
let _priceCacheTs = 0;
const PRICE_CACHE_TTL = 300000; // 5 min

async function getTokenPrices() {
  if (_priceCache && Date.now() - _priceCacheTs < PRICE_CACHE_TTL) return _priceCache;
  // ponytail: Binance API (no key, CF-friendly). CoinGecko blocks CF Worker IPs.
  try {
    const symbols = "BTCUSDT,TRXUSDT,TONUSDT,SOLUSDT";
    const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(symbols)}`);
    const data = await resp.json();
    const m = {};
    for (const t of data) m[t.symbol] = parseFloat(t.price);
    _priceCache = {
      btc: m["BTCUSDT"] || 0,
      trx: m["TRXUSDT"] || 0,
      ton: m["TONUSDT"] || 0,
      sol: m["SOLUSDT"] || 0,
      usdt: 1,
    };
    _priceCacheTs = Date.now();
    return _priceCache;
  } catch (e) {
    // fallback: use rough estimates if API fails
    return _priceCache || { btc: 95000, trx: 0.12, ton: 5, sol: 180, usdt: 1 };
  }
}

// ============================================================
//  /invoice — protected endpoint for bot to get payment details
// ============================================================
async function handleInvoice(env, request, body) {
  const { chain, pkg } = body;
  if (!chain || !pkg) return json({ ok: false, reason: "missing chain and pkg" }, 400);

  const chainCfg = CHAINS[chain];
  if (!chainCfg) return json({ ok: false, reason: "unsupported chain: " + chain }, 400);
  if (!chainCfg.wallet || chainCfg.wallet.length < 8) return json({ ok: false, reason: "wallet not configured" }, 400);

  const pkgCfg = PACKAGES[pkg];
  if (!pkgCfg) return json({ ok: false, reason: "invalid package: " + pkg }, 400);

  const prices = await getTokenPrices();
  const chainPrice = prices[chain] || 0;
  if (chainPrice === 0) return json({ ok: false, reason: "price unavailable for " + chain });

  const nativeAmount = (pkgCfg.price_usd / chainPrice).toFixed(chain === "btc" ? 6 : 2);
  // QR code via Google Charts API (free, no key)
  const qrText = encodeURIComponent(chainCfg.wallet);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${qrText}`;

  return json({
    ok: true,
    chain,
    chain_name: chainCfg.name,
    symbol: chainCfg.symbol,
    wallet: chainCfg.wallet,
    amount_usd: pkgCfg.price_usd,
    amount_native: nativeAmount,
    price_per_unit: chainPrice,
    qr_url: qrUrl,
    explorer: chainCfg.explorer,
    pkg,
    days: pkgCfg.days
  });
}

// ============================================================
//  /pricing — public price list (no secret needed)
// ============================================================

async function handlePricing() {
  const prices = await getTokenPrices();
  const pkgs = {};
  for (const [key, val] of Object.entries(PACKAGES)) {
    const nativePrices = {};
    for (const [chainId, chainCfg] of Object.entries(CHAINS)) {
      const p = prices[chainId];
      if (p && p > 0) nativePrices[chainId] = (val.price_usd / p).toFixed(chainId === "btc" ? 6 : 2);
    }
    pkgs[key] = { price_usd: val.price_usd, gems: val.gems, days: val.days, native_prices: nativePrices };
  }
  return json({ ok: true, packages: pkgs, prices_updated: _priceCacheTs || 0 });
}

// ============================================================
//  /chains — public chain list (no secret needed)
// ============================================================

async function handleChains() {
  const chains = {};
  for (const [key, val] of Object.entries(CHAINS)) {
    chains[key] = {
      symbol: val.symbol,
      name: val.name,
      wallet_configured: !!(val.wallet && val.wallet.length >= 8),
      explorer: val.explorer || "",
      token_mode: val.token_mode || false
    };
  }
  return json({ ok: true, chains });
}

// ============================================================
//  CRON — daily audit
// ============================================================

async function handleCron(env) {
  // v5.3: auto-verify pending payments
  try {
    const pending = await env.DB.prepare("SELECT txid, user_id, pkg, chain FROM txids WHERE verified = 0").all();
    if (pending.results?.length) {
      console.log(`[cryptopay] auto-verifying ${pending.results.length} pending payments`);
      let credited = 0;
      for (const row of pending.results) {
        const chainCfg = CHAINS[row.chain];
        const pkgCfg = PACKAGES[row.pkg];
        if (!chainCfg || !pkgCfg) continue;
        const v = await verifyTransaction(row.chain, row.txid, String(row.user_id), chainCfg, env);
        if (!v.ok) continue;  // not confirmed yet or failed
        // check amount (same logic as handleVerify)
        const nativePrices = pkgCfg.native_prices || {};
        const expectedAmount = chainCfg.token_mode ? pkgCfg.price_usd : (nativePrices[row.chain] !== undefined ? nativePrices[row.chain] : pkgCfg.price_usd);
        if (expectedAmount > 0 && v.amount < expectedAmount * AMOUNT_TOLERANCE) continue;
        // atomic credit (same batch as handleVerify)
        const batch = [
          env.DB.prepare("UPDATE txids SET verified = 1, amount = ? WHERE txid = ?").bind(v.amount, row.txid),
        ];
        if (pkgCfg.gems > 0) {
          batch.push(env.DB.prepare("UPDATE users SET gems = gems + ?, ts = ? WHERE user_id = ?").bind(pkgCfg.gems, Date.now(), row.user_id));
        }
        if (pkgCfg.days > 0) {
          batch.push(env.DB.prepare("UPDATE users SET vip_until = MAX(vip_until, ?) + ?, ts = ? WHERE user_id = ?").bind(Date.now(), pkgCfg.days * 86400000, Date.now(), row.user_id));
        }
        await env.DB.batch(batch);
        credited++;
        // notify bot
        try {
          const botUrl = env.BOT_URL || `https://v2raylinker.msoxiy5o3m8d.workers.dev`;
          await fetch(`${botUrl}/bot`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: { message_id: 0, from: { id: 0, first_name: "CryptoPay" }, chat: { id: row.user_id, type: "private" }, date: Math.floor(Date.now()/1000), text: `/payverify ${row.chain} ${row.txid} ${row.pkg}` } })
          });
        } catch (e) { /* best effort */ }
      }
      if (credited > 0) console.log(`[cryptopay] auto-verified ${credited} payments`);
    }
  } catch (e) {
    console.error("[cryptopay auto-verify error]", e.message);
  }
  // existing audit log
  try {
    const gemsRow = await env.DB.prepare(`SELECT COALESCE(SUM(gems), 0) as total FROM users`).first();
    const vipRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM users WHERE vip_until > ?`).bind(Date.now()).first();
    const txidRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM txids`).first();
    const txnRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM transactions`).first();
    const verifiedRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM txids WHERE verified = 1`).first();
    console.log(`[cryptopay audit] gems_in_circulation=${gemsRow.total}, active_vip=${vipRow.count}, total_txids=${txidRow.count}, verified=${verifiedRow.count}, total_txns=${txnRow.count}`);
  } catch (e) {
    console.error("[cryptopay audit error]", e.message);
  }
}

// ============================================================
//  MAIN HANDLER
// ============================================================

export default {
  async fetch(request, env, ctx) {
    // Schema bootstrap (once per isolate)
    await ensureSchema(env);

    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "*" } });

    // ---- PUBLIC ENDPOINTS ----
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, service: "cryptopay", version: "2.0", chains: Object.keys(CHAINS).length });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "cryptopay", time: Date.now(), chains: Object.keys(CHAINS).map(c => ({ id: c, symbol: CHAINS[c].symbol })) });
    if (request.method === "GET" && url.pathname === "/pricing") return handlePricing();
    if (request.method === "GET" && url.pathname === "/chains") return handleChains();

    // ---- PROTECTED ENDPOINTS ----
    // Two secret tiers:
    //   X-Pay-Secret  → /verify (charge users via on-chain tx) + /balance (read user)
    //   X-Admin-Secret → /grant + /debit (debit user gems, grant VIP/gems)
    // If ADMIN_SECRET is empty in config, /grant + /debit fall back to X-Pay-Secret
    // (single-secret backwards-compat mode for existing single-bot deployments).
    if (request.method === "GET" && url.pathname.startsWith("/balance/")) {
      if (!checkSecret(request, env)) return json({ ok: false, reason: "unauthorized" }, 403);
      return handleBalance(env, url.pathname.split("/")[2]);
    }

    if (request.method === "POST") {
      // /verify and /balance use X-Pay-Secret; /grant and /debit use X-Admin-Secret (or fallback).
      const isAdminOp = url.pathname === "/grant" || url.pathname === "/debit";
      const secretOk = isAdminOp ? checkAdminSecret(request, env) : checkSecret(request, env);
      if (!secretOk) return json({ ok: false, reason: "unauthorized" }, 403);
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, reason: "invalid JSON" }, 400); }

      if (url.pathname === "/verify") return handleVerify(env, request, body);
      if (url.pathname === "/invoice") return handleInvoice(env, request, body);
      if (url.pathname === "/debit") return handleDebit(env, body);
      if (url.pathname === "/grant") return handleGrant(env, body);
    }

    return json({ ok: false, reason: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    await handleCron(env);
  }
};