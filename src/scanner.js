// src/scanner.js
// Cron-triggered worker (every 1min — the Cloudflare free-tier cron floor).
// Scans BTC + ETH blocks for whale txs, writes new whales to D1, queues
// each one to the analyst for AI analysis.
//
// ALSO refreshes the market_cache in KV on a TTL gate (every ~5 min).
// RPCs cost API budget — keep them tight. NO API calls per-tx (use cached
// price from KV instead; the original plan said to cache it then the
// pseudocode ignored the cache — fixed here).
//
// Critical design choice: block catch-up is BATCHED. If the scanner was
// down for an hour and 300 ETH blocks piled up, we will NOT try to process
// them all in one 1-min cron tick. We process up to MAX_BLOCKS per tick and
// then update last_block and return. The next tick picks up the rest.
// This keeps us inside the Workers request envelope even after an outage.
//
// Second critical choice: last_block is persisted PER BLOCK (not once per
// batch). A crash mid-batch therefore never re-processes a completed block,
// which is what keeps the wallet-stats bumps idempotent in practice.
//
// Third: BTC blocks are paginated past blockstream's 25-tx page size, and
// pagination state (tx_offset) is persisted in scanner_state so a huge
// block spanning multiple ticks resumes instead of restarting.
//
// Bindings (env):
//   DB       — D1 database
//   KV       — KV namespace (for market_cache/others)
//   ANALYSTQ — Queue to analyst
//   ETHSCAN_KEY — optional etherscan key (BSCSCAN_KEY is legacy/unused)
//   ADMIN_TOKEN — required to use the /scan and /tick HTTP endpoints
//                 (fail-closed: endpoints 401 when unset)
//   MIN_USD  — string, overrides default 500000
//   MAX_BLOCKS — string, overrides default 2

import { fetchJSON, classifyTx, usdValue, buildWalletMap, labelFor } from "./worker-utils.js";
import { scanSolana } from "./solana.js";

// consts (also overrideable via env)
const DEFAULT_MIN_USD = 500_000;
const DEFAULT_MAX_BLOCKS = 2; // Keep bounded to stay safely under Cloudflare Workers 50 subrequests limit
// KV free tier = 1K writes/day. Scanner cron = 1/min (real cron floor), so
// we must NOT write per-tick. Instead we decay-cache: refresh market_cache
// only if the cached object is older than MARKET_CACHE_TTL_S. That gives us
// max ~1 cache write every 5 min = 288/day, well under the 1K cap with headroom.
const MARKET_CACHE_TTL_S = 300;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(addr,a,uint256)

// Primary tracked stablecoin contracts (USDT + USDC represent >95% of ERC20 whale transfer volume)
const TOKENS_BY_CONTRACT = {
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
};

// BSC (BNB Chain) BEP-20 tokens — same mechanism, different contracts
const BSC_TOKENS_BY_CONTRACT = {
  "0x55d398326f99059ff775485246999027b3197955": "USDT", // Binance-Peg USDT (verified)
  "0x8ac7230481977290e4d55a9c6e547a2b9df2a54c": "USDC",
  "0x7130d40692f8b028100d12b8546c800a15e65430": "BUSD",
};

// Base (Coinbase L2) — native USDC
const BASE_TOKENS_BY_CONTRACT = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
};

// ─── tunables ─────────────────────────────────────────────────────────

// Confirmation depth: never trust the unconfirmed tip. A reorged "$50M
// whale" alert is a credibility-killer; a 1-2 block lag costs nothing on a
// 1/min cadence.
const CONFIRMATIONS = { btc: 1, eth: 2, bsc: 3, base: 2, tron: 1, solana: 1 };
const EVM_CHAIN_IDS = { eth: 1, bsc: 56, base: 8453 };

// Workers allow 50 subrequests per invocation. Market+news+tip overhead is
// ~9-12, so the scan phase gets the rest. Shared across both chains per tick.
const SCAN_SUBREQUEST_BUDGET = 36;

// Hard cap on blockstream tx pages per block fetch (25 txs/page). A block
// can never legitimately exceed this; it bounds the pagination loop against
// a misbehaving API. Resume-across-ticks (tx_offset) handles genuinely big
// blocks instead.
const MAX_TX_PAGES_PER_BLOCK = 400; // 400 × 25 = 10,000 txs

/**
 * fetch + text with a timeout. Mirrors worker-utils fetchJSON but for
 * plain-text endpoints (blockstream /blocks/tip/height and
 * /block-height/{n} return bare text, not JSON).
 */
async function fetchText(url, opts = {}) {
  const { headers = {}, timeoutMs = 8000 } = opts;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url} — ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Convert a hex uint (wei, token raw units) to a decimal token amount.
 * Uses BigInt so 256-bit values don't lose precision — parseInt() caps at
 * 2^53, which corrupts the biggest native-ETH transfers (exactly the ones
 * we care about). Returns NaN for malformed input; caller skips those.
 * Pure. Exported for tests.
 */
export function hexToAmount(valueHex, decimals) {
  let v;
  try {
    v = BigInt(valueHex ?? "0x0");
  } catch {
    return NaN;
  }
  if (v < 0n) return NaN;
  const divisor = 10n ** BigInt(decimals);
  const whole = v / divisor;
  const frac = v % divisor;
  // `whole` is exact (real token supplies fit in a double's integer range);
  // the fractional part adds sub-unit precision.
  return Number(whole) + Number(frac) / Number(divisor);
}

/**
 * Parse an env override to int, falling back to the default when the value
 * is missing, empty, or not a number. (A garbage MAX_BLOCKS used to make
 * the scan loop silently process zero blocks every tick.)
 * Pure. Exported for tests.
 */
export function parseEnvInt(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Consume one subrequest from the shared per-tick budget. A null budget
 * means unlimited (tests / non-Workers contexts). Returns false when the
 * budget is exhausted — caller must stop fetching and persist progress.
 */
function takeSubrequest(budget) {
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

// ─── pure helpers (testable without env) ──────────────────────────────

/**
 * Filter a decoded chain block into BTC whale tx candidates.
 * Pure. Caller passes the cached market object + the block body.
 * Returns an array of normalized candidate objects, NOT yet filtered by min USD.
 * Each: { chain, tx_hash, from_address, to_address, amount, symbol,
 *          block_number, block_time, usd_value, is_self_transfer }
 *
 * Semantics: the whale is the SPENDER. `amount` is the NET OUTFLOW — the
 * sum of outputs paying addresses that are NOT among the inputs (i.e.
 * change back to the sender is excluded). `from_address` is the largest
 * input address; `to_address` is the largest external output's address.
 * A pure self-move/consolidation (every output is change) is kept with
 * is_self_transfer=1 and to_address="" so downstream scoring can discount
 * it instead of hallucinating a "whale transfer". Coinbase txs are skipped.
 */
export function extractCandidatesBTC(block, market) {
  const out = [];
  if (!block || !Array.isArray(block.tx)) return out;
  const bn = typeof block.height === "number" ? block.height : null;
  const bt = block.time ? block.time * 1000 : null; // unix s -> ms
  for (const tx of block.tx) {
    if (!tx.hash) continue;
    const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
    const outputs = Array.isArray(tx.out) ? tx.out : [];

    // Spender set + total input value. Both providers (blockstream via
    // prevout, blockchain.info via prev_out) carry input values; if a
    // provider ever stops, we fall back to output totals below.
    const spenderAddrs = new Set();
    let totalInSat = 0;
    let fromAddr = "";
    let largestIn = 0;
    for (const inp of inputs) {
      const po = inp.prev_out || {};
      const v = typeof po.value === "number" ? po.value : 0;
      totalInSat += v;
      if (po.addr) spenderAddrs.add(po.addr);
      if (v > largestIn) { largestIn = v; fromAddr = po.addr || ""; }
    }

    // Coinbase has no real sender — skip (block reward is noise anyway).
    if (spenderAddrs.size === 0) continue;

    // Net outflow: outputs NOT going back to the spender. BTC address
    // comparison is exact (base58check is case-sensitive; bech32 is
    // lowercase by spec) — a change output reuses the identical string.
    let toAddr = "";
    let largestOut = 0;
    let externalSat = 0;
    let totalOutSat = 0;
    for (const o of outputs) {
      const v = typeof o.value === "number" ? o.value : 0;
      totalOutSat += v;
      if (o.addr && spenderAddrs.has(o.addr)) continue; // change
      externalSat += v;
      if (v > largestOut) { largestOut = v; toAddr = o.addr || ""; }
    }

    // Satoshi math is exact: 21M BTC = 2.1e15 sat < 2^53, no BigInt needed.
    let amountSat;
    let isSelfTransfer = 0;
    if (externalSat > 0) {
      amountSat = externalSat;
    } else {
      // All change: self-move / consolidation. Keep it visible but flagged —
      // better than fabricating a recipient, better than silently dropping a
      // 10k-BTC cold-wallet rotation.
      isSelfTransfer = 1;
      amountSat = totalInSat > 0 ? totalInSat : totalOutSat;
    }
    if (amountSat <= 0) continue;

    const amountBtc = amountSat / 1e8;
    out.push({
      chain: "btc",
      tx_hash: tx.hash,
      from_address: fromAddr,
      to_address: toAddr,
      amount: amountBtc,
      symbol: "BTC",
      block_number: bn,
      block_time: bt,
      // precompute USD here so the scan loop stays pure
      usd_value: usdValue(amountBtc, "BTC", market),
      is_self_transfer: isSelfTransfer,
    });
  }
  return out;
}

/**
 * Filter an ETH block (from etherscan `proxy` eth_getBlockByNumber with full
 * tx objects) into native-ETH candidates. ERC20 candidates come from logs
 * and are filtered by extractERC20Candidates (separate, 1 additional RPC).
 * Pure.
 */
export function extractCandidatesETH(block, market, chain = "eth") {
  const out = [];
  if (!block || !Array.isArray(block.transactions)) return out;
  const nativeSym = chain === "bsc" ? "BNB" : "ETH"; // base uses ETH
  for (const tx of block.transactions) {
    if (typeof tx === "string") continue; // we asked for full txs
    if (!tx.hash) continue;
    if (tx.to == null) continue; // contract creation — a deployment, not a transfer
    const amount = hexToAmount(tx.value, 18); // wei -> native, BigInt-exact
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const from = tx.from || "";
    const to = tx.to || "";
    out.push({
      chain,
      tx_hash: tx.hash,
      from_address: from,
      to_address: to,
      amount,
      symbol: nativeSym,
      block_number: parseInt(block.number, 16),
      block_time: parseInt(block.timestamp, 16) * 1000,
      usd_value: usdValue(amount, nativeSym, market),
      is_self_transfer: from && from.toLowerCase() === to.toLowerCase() ? 1 : 0,
    });
  }
  return out;
}

/**
 * Filter ERC20 Transfer logs (from eth_getLogs filtered by topic0) into candidates.
 * Pure. `logs` = array of log entries with topics=[topic0, from, to] and data=hex amount.
 */
export function extractERC20Candidates(logs, market, chain = "eth") {
  const out = [];
  if (!Array.isArray(logs)) return out;
  for (const lg of logs) {
    if (!Array.isArray(lg.topics) || lg.topics.length < 3) continue;
    const contract = (lg.address || "").toLowerCase();
    const tokenMap = chain === "bsc" ? BSC_TOKENS_BY_CONTRACT : chain === "base" ? BASE_TOKENS_BY_CONTRACT : TOKENS_BY_CONTRACT;
    const sym = tokenMap[contract];
    if (!sym) continue; // not a tracked token
    // topics are 32-byte hex words; from = bytes12..32, to likewise
    const from = "0x" + (lg.topics[1] || "").slice(26);
    const to = "0x" + (lg.topics[2] || "").slice(26);
    // decimals differ per token AND per chain (BSC stables are 18, not 6)
    const decimals = chain === "bsc"
      ? (BSC_TOKEN_DECIMALS[sym] ?? 18)
      : (TOKEN_DECIMALS[sym] ?? 18);
    const amount = hexToAmount(lg.data, decimals); // BigInt-exact, NaN on malformed
    if (!Number.isFinite(amount)) continue;
    out.push({
      chain,
      tx_hash: lg.transactionHash,
      from_address: from,
      to_address: to,
      amount,
      symbol: sym,
      block_number: typeof lg.blockNumber === "string" ? parseInt(lg.blockNumber, 16) : lg.blockNumber,
      block_time: null, // filled later from the block
      usd_value: usdValue(amount, sym, market),
      is_self_transfer: from.toLowerCase() === to.toLowerCase() ? 1 : 0,
      _contract: contract,
    });
  }
  return out;
}

// token decimals (for converting log amounts)
const TOKEN_DECIMALS = {
  USDT: 6, USDC: 6, DAI: 18, WBTC: 8, LINK: 18,
};
// BSC quirk: Binance-Peg stables use 18 decimals, unlike Ethereum's 6.
// Using 6 would undercount by 1e12.
const BSC_TOKEN_DECIMALS = {
  USDT: 18, USDC: 18, BUSD: 18,
};

/** Apply the min-USD filter to a list of candidates. Pure. */
export function filterWhales(candidates, minUsd) {
  return candidates.filter((c) => Number.isFinite(c.usd_value) && c.usd_value >= minUsd);
}

// ─── interestingness score ──────────────────────────────────────────
//
// Pure 0-100 heuristic. Gates the AI queue: >= SCORE_THRESHOLD → Gemini,
// below → INSERT with analysis_status='skipped' (no queue message).
// Saves 50-90% of Gemini calls by killing noise.
//
// Factors (all already available at scan time, no extra fetches):
//   - transfer size (the raw magnitude)
//   - tx_type (exchange involvement is more interesting)
//   - wallet age (old wallets acting are rare)
//   - wallet tx_count (known whales are more interesting)
//   - dormancy (wallet silent for >1yr suddenly moves = high signal)
//   - spam penalty (>5 txs from same wallet in 24h = automation noise)
//
// hand-tuned weights, not ML. The knobs stay so the physical
// world (real alert quality feedback) can tune them. Upgrade path: if
// you ever have labeled "good vs bad alert" data, fit logistic regression
// weights on these same features and replace the constants.

export const SCORE_THRESHOLD = 50;

/**
 * Compute the interestingness score for a whale candidate.
 * Pure, no I/O. Exported for tests.
 *
 * @param {object} w — whale candidate (post-filterWhales, post-classifyWhales)
 *   { usd_value, tx_type, block_time, detected_at, from_address }
 * @param {object} walletInfo — row from loadWalletMap for from_address
 *   { label, type, chain, tx_count, first_seen, last_seen } or null
 *   (tx_count, first_seen, last_seen come from the wallets table — added
 *   to the SELECT when available; null/0 when unknown wallet)
 * @param {Array<object>} recentFromSameWallet — recently-detected whales
 *   from this from_address (for spam penalty). Pass [] when not available
 *   (first-sight scan). Each: { detected_at }
 * @returns {number} 0-100 integer
 */
export function computeInterestingness(w, walletInfo = null, recentFromSameWallet = []) {
  let score = 0;
  const usd = w.usd_value ?? 0;

  // ── size (0-80) ──
  if (usd >= 100_000_000) score += 80;       // $100M+
  else if (usd >= 50_000_000) score += 70;   // $50M+
  else if (usd >= 10_000_000) score += 60;   // $10M+
  else if (usd >= 5_000_000) score += 45;   // $5M+
  else if (usd >= 1_000_000) score += 30;    // $1M+
  else score += 15;                           // $500K-1M (min threshold)

  // ── exchange involvement (0-12) ──
  if (w.tx_type === "exchange_inflow" || w.tx_type === "exchange_outflow") score += 12;
  else if (w.tx_type === "exchange_internal") score += 6;
  else score += 3; // wallet_to_wallet

  // ── wallet age — known wallets with history are more interesting (0-15) ──
  if (walletInfo) {
    const txCount = walletInfo.tx_count ?? 0;
    if (txCount >= 10) score += 15;
    else if (txCount >= 3) score += 10;
    else if (txCount >= 1) score += 5;
  }

  // ── dormancy bonus — old wallet suddenly active (0-20) ──
  if (walletInfo && walletInfo.last_seen && walletInfo.first_seen) {
    const now = w.detected_at ?? Date.now();
    const silenceMs = now - walletInfo.last_seen;
    const walletAgeMs = now - walletInfo.first_seen;
    // dormant for more than 1 year = +20, more than 6mo = +12, more than 3mo = +6
    const ONE_DAY = 86_400_000;
    if (silenceMs > 365 * ONE_DAY) score += 20;
    else if (silenceMs > 180 * ONE_DAY) score += 12;
    else if (silenceMs > 90 * ONE_DAY) score += 6;
    // wallet existed for >3yr but was silent = extra credibility
    if (walletAgeMs > 3 * 365 * ONE_DAY) score += 5;
  }

  // ── spam penalty — many txs from same wallet in 24h = automation (0 to -25) ──
  if (recentFromSameWallet.length > 0) {
    const now = w.detected_at ?? Date.now();
    const oneDayAgo = now - 86_400_000;
    const count24h = recentFromSameWallet.filter((r) => (r.detected_at ?? 0) > oneDayAgo).length;
    if (count24h >= 10) score -= 25;
    else if (count24h >= 5) score -= 15;
    else if (count24h >= 3) score -= 8;
  }

  // ── stablecoin neutral penalty — $10M USDT is less interesting than $10M BTC ──
  // stablecoin transfers are usually exchange plumbing, not whale moves.
  // Reduce score for USDT/USDC/DAI unless the amount is very large.
  const sym = (w.symbol ?? "").toUpperCase();
  if ((sym === "USDT" || sym === "USDC" || sym === "DAI") && usd < 50_000_000) {
    score -= 10;
  }

  // ── self-transfer penalty — wallet sending to itself is not a whale move ──
  // (Audit found 1/3 of "whale volume" was self-transfers, incl. 4x $200M rotator.)
  if (w.is_self_transfer) {
    score -= 30;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Attach a tx_type (exchange_inflow etc.) using the wallet label map. Pure. */
export function classifyWhales(whales, walletMap) {
  return whales.map((w) => {
    const fromType = walletMap.get(String(w.from_address).toLowerCase())?.type || null;
    const toType = walletMap.get(String(w.to_address).toLowerCase())?.type || null;
    const { tx_type } = classifyTx(fromType, toType);
    return { ...w, tx_type };
  });
}

// ─── runtime: scan logic ──────────────────────────────────────────────

/** Get last_block (+ tx_offset, counters) for a chain (or nulls for first run). */
async function getState(env, chain) {
  const row = await env.DB.prepare(
    "SELECT last_block, total_whales, errors, tx_offset FROM scanner_state WHERE chain = ?"
  ).bind(chain).first();
  return row || { last_block: null, total_whales: 0, errors: 0, tx_offset: 0 };
}

/**
 * Mark last_block + last_scan for a chain and clear/advance the BTC tx
 * pagination offset. Called AFTER EACH BLOCK succeeds (not once per batch),
 * so a crash mid-batch never re-processes a completed block — which is
 * what keeps the wallet-stats bumps from double-counting on retry.
 * Also increments the lifetime total_whales counter (previously dead).
 */
async function persistState(env, chain, lastBlock, txOffset = 0, whalesDelta = 0) {
  // Upsert: INSERT if the row doesn't exist (first run), UPDATE otherwise.
  // The old UPDATE-only version silently did nothing on first run if
  // fetchLatestBlockHeight threw before persistState was called.
  await env.DB.prepare(
    `INSERT INTO scanner_state (chain, last_block, last_scan, errors, total_whales, tx_offset)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(chain) DO UPDATE SET
       last_block = excluded.last_block,
       last_scan = excluded.last_scan,
       errors = 0,
       total_whales = total_whales + excluded.total_whales,
       tx_offset = excluded.tx_offset`
  ).bind(chain, lastBlock, Date.now(), whalesDelta, txOffset).run();
}

/** Increment the consecutive-errors counter on a failure. */
/**
 * Detect D1 quota/limit errors (5M row reads/day, etc.).
 * When D1 is locked, all D1 ops fail — don't waste budget retrying chains.
 */
export function isD1LockedError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return msg.includes("limit") || msg.includes("quota") ||
         msg.includes("too many") || msg.includes("d1_error") ||
         msg.includes("exceeded");
}

async function bumpErrors(env, chain) {
  // Upsert: ensure the row exists so consecutive failures are actually counted.
  // The old UPDATE-only version silently did nothing if the chain had never
  // been primed (e.g. BSC/Base/Solana failing on first run).
  await env.DB.prepare(
    `INSERT INTO scanner_state (chain, last_block, last_scan, errors, total_whales, tx_offset)
     VALUES (?, NULL, ?, 1, 0, 0)
     ON CONFLICT(chain) DO UPDATE SET errors = errors + 1, last_scan = excluded.last_scan`
  ).bind(chain, Date.now()).run();
}

/**
 * Insert a new whale + conditionally queue it to analyst.
 * Returns true if newly inserted (regardless of whether queued).
 *
 * Sprint 1: the interestingness score gates whether we spend a Gemini call.
 * Score >= SCORE_THRESHOLD → queue to analyst (AI analysis).
 * Below → INSERT with analysis_status='skipped' (no AI cost, no queue msg).
 */
async function insertWhaleAndQueue(env, wh, walletMap, walletInfo, recentSameWallet, market) {
  const score = computeInterestingness(wh, walletInfo, recentSameWallet);
  const shouldAnalyze = score >= SCORE_THRESHOLD;

  // Price snapshot at detect time for AI accuracy evaluation.
  const sym = (wh.symbol || "").toLowerCase();
  const priceAtDetect = market?.[sym]?.price ?? market?.[wh.chain]?.price ?? null;

  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO whales
       (chain, tx_hash, from_address, to_address, amount, symbol, usd_value,
        tx_type, block_number, block_time, detected_at, analysis_status,
        interesting_score, price_at_detect, is_self_transfer, contract_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    wh.chain, wh.tx_hash,
    // Normalize EVM addresses to lowercase (checksum format varies by RPC).
    // Solana/Tron are case-sensitive — never touch them.
    ["eth", "bsc", "base"].includes(wh.chain) ? String(wh.from_address || "").toLowerCase() : wh.from_address,
    ["eth", "bsc", "base"].includes(wh.chain) ? String(wh.to_address || "").toLowerCase() : wh.to_address,
    wh.amount, wh.symbol, wh.usd_value, wh.tx_type,
    wh.block_number ?? null, wh.block_time ?? null,
    Date.now(),
    shouldAnalyze ? "pending" : "skipped",
    score,
    priceAtDetect,
    wh.is_self_transfer ? 1 : 0,
    wh._contract ?? null
  ).run();
  if (ins.meta.changes === 0) return false; // dup

  // Dedupe key is (chain, tx_hash, symbol): one tx can move native ETH
  // *and* ERC20s, and each is its own whale row.
  const row = await env.DB.prepare(
    "SELECT id FROM whales WHERE chain = ? AND tx_hash = ? AND symbol = ?"
  ).bind(wh.chain, wh.tx_hash, wh.symbol).first();
  if (!row?.id) return false;

  // Queue only for interesting whales — saves 50-90% of Gemini calls.
  // Enterprise: if queue send fails, mark as queue_failed (not queued) so
  // a retry job can pick it up. Never silently lose a whale.
  if (shouldAnalyze) {
    try {
      await env.ANALYSTQ.send(JSON.stringify({ whale_id: row.id, chain: wh.chain }));
    } catch (e) {
      console.error(`[scanner] queue send failed for whale ${row.id}:`, e.message);
      await env.DB.prepare("UPDATE whales SET analysis_status = 'queue_failed' WHERE id = ?")
        .bind(row.id).run().catch(() => {});
    }
  }

  // Bump wallet stats for non-exchange addresses.
  const fromType = walletMap?.get(String(wh.from_address).toLowerCase())?.type || null;
  const toType = walletMap?.get(String(wh.to_address).toLowerCase())?.type || null;
  const targets = statTargets(wh.from_address, wh.to_address, fromType, toType);
  if (targets.length > 0) {
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE wallets SET last_seen = ?, last_tx_hash = ?, " +
      "first_seen = COALESCE(first_seen, ?), " +
      "tx_count = tx_count + 1, total_volume = total_volume + ? " +
      "WHERE address IN (" + targets.map(() => "?").join(",") + ") AND chain = ?"
    ).bind(now, wh.tx_hash, now, wh.usd_value, ...targets, wh.chain).run();

    // Auto-label: if a wallet crosses 3 txs, label it as 'whale'.
    // dormancy reactivate: previously dormant wallet waking up.
    await autoLabelWallets(env, targets, wh.chain, walletMap, walletInfo);
  }
  return true;
}

/**
 * Auto-assign wallet reputation labels after stat bump.
 * - tx_count >= 3 → type='whale'
 * - dormant for >1yr and now active → pattern='reactivated'
 * - high frequency (>10 txs in 24h visible in our data) → pattern='high_frequency'
 *
 * 2 cheap UPDATEs piggybacking on the stats bump. No extra reads
 * — we use the walletMap we already loaded + the walletInfo from it.
 * Upgrade path: move to a scheduled cron job that recomputes all labels
 * from scratch if the rules get complex.
 */
async function autoLabelWallets(env, targets, chain, walletMap, walletInfo) {
  for (const addr of targets) {
    const key = String(addr).toLowerCase();
    // Never fall back to the *from*-wallet's stats for an unknown *to*
    // address — that used to label first-seen recipients with the sender's
    // history. Unknown address = skip.
    const info = walletMap?.get(key) ?? null;
    if (!info) continue;

    const txCount = (info.tx_count ?? 0) + 1; // +1 for the one we just inserted
    const updates = [];

    // crossing threshold 3 → become a whale
    if (txCount >= 3 && info.type !== "exchange" && info.type !== "whale") {
      updates.push("type = 'whale'");
    }

    // dormant reactivation
    if (info.last_seen && info.first_seen) {
      const silenceMs = Date.now() - info.last_seen;
      if (silenceMs > 365 * 86_400_000) {
        updates.push("reputation = 'reactivated'");
      }
    }

    // high frequency
    if (txCount >= 10) {
      updates.push("reputation = COALESCE(reputation, 'high_frequency')");
    }

    if (updates.length > 0) {
      await env.DB.prepare(
        "UPDATE wallets SET " + updates.join(", ") + " WHERE address = ? AND chain = ?"
      ).bind(addr, chain).run();
    }
  }
}

/**
 * Decide which of (from, to) should have their wallets stats bumped for this
 * whale tx. Phase 1: skip exchange addresses (we don't want Binance's hot
 * wallet to look like the world's biggest whale). Same-address (self-send)
 * is deduped. Pure — exported for tests.
 * @returns {string[]} targets to include in the UPDATE ... IN (...) clause
 */
export function statTargets(fromAddr, toAddr, fromType, toType) {
  const t = [];
  if (fromAddr && fromType !== "exchange") t.push(fromAddr);
  if (toAddr && toAddr !== fromAddr && toType !== "exchange") t.push(toAddr);
  return t;
}

/**
 * Load the wallets table into a label-map. Should be small enough to keep
 * in-memory per scan. Includes tx_count/first_seen/last_seen for
 * interestingness scoring and auto-labeling.
 */
async function loadWalletMap(env) {
  const { results } = await env.DB.prepare(
    "SELECT address, chain, label, type, tx_count, first_seen, last_seen FROM wallets"
  ).all();
  const m = new Map();
  if (!results) return m;
  for (const r of results) {
    if (!r || !r.address) continue;
    const entry = {
      label: r.label, type: r.type, chain: r.chain,
      tx_count: r.tx_count, first_seen: r.first_seen, last_seen: r.last_seen,
    };
    m.set(String(r.address).toLowerCase(), entry);
    m.set(String(r.address), entry);
  }
  return m;
}

/**
 * Fetch recently-detected whales from a specific wallet (for the spam
 * penalty in interestingness scoring). Returns last 10 by detected_at.
 * 1 D1 read per inserted whale. At 200 whales/day = 200 reads.
 * Well within the 100K/day free tier.
 */
async function recentWhalesFromWallet(env, address, chain) {
  const { results } = await env.DB.prepare(
    "SELECT detected_at FROM whales WHERE from_address = ? AND chain = ? ORDER BY detected_at DESC LIMIT 10"
  ).bind(address, chain).all();
  return results || [];
}

/**
 * Fetch the latest block height for a chain. Returns a positive int.
 * Throws when no provider yields a sane height — callers treat that as a
 * failed scan (bumpErrors) instead of silently reporting success with NaN.
 */
export async function fetchLatestBlockHeight(env, chain) {
  if (chain === "btc") {
    // 1. Try blockstream.info tip (plain-text body, timeout-guarded)
    try {
      const text = await fetchText("https://blockstream.info/api/blocks/tip/height", { timeoutMs: 5000 });
      const h = parseInt(text.trim(), 10);
      if (Number.isFinite(h) && h > 0) return h;
      throw new Error(`bad tip body: ${text.slice(0, 40)}`);
    } catch (e) {
      console.warn("[scanner:btc] blockstream tip failed:", e.message);
    }
    // 2. Try blockcypher
    try {
      const b = await fetchJSON("https://api.blockcypher.com/v1/btc/main", { timeoutMs: 5000 });
      if (b && Number.isFinite(b.height) && b.height > 0) return b.height;
      throw new Error("bad height in blockcypher response");
    } catch (e) {
      console.warn("[scanner:btc] blockcypher tip failed, trying blockchain.info:", e.message);
    }
    // 3. Fallback blockchain.info
    const j = await fetchJSON("https://blockchain.info/latestblock", { timeoutMs: 8000 });
    const h = j?.height;
    if (!Number.isFinite(h) || h <= 0) throw new Error(`btc tip height unavailable: ${JSON.stringify(j)?.slice(0, 120)}`);
    return h;
  }
  if (chain === "eth") {
    const key = env.ETHSCAN_KEY ? `&apikey=${env.ETHSCAN_KEY}` : "";
    const j = await fetchJSON(
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber${key}`
    );
    const h = parseInt(j?.result, 16);
    if (!Number.isFinite(h) || h <= 0) {
      throw new Error(`eth_blockNumber returned garbage: ${String(j?.result).slice(0, 120)}`);
    }
    return h;
  }
  if (chain === "base") {
    // Etherscan V2 free doesn't cover Base — use public Base RPC
    const r = await fetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const j = await r.json();
    const h = parseInt(j?.result, 16);
    if (!Number.isFinite(h) || h <= 0) {
      throw new Error(`base blockNumber returned garbage: ${String(j?.result).slice(0, 120)}`);
    }
    return h;
  }
  if (chain === "bsc") {
    // Etherscan V2 free doesn't cover BSC — use public BSC RPC
    const r = await fetch("https://bsc-dataseed.binance.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const j = await r.json();
    const h = parseInt(j?.result, 16);
    if (!Number.isFinite(h) || h <= 0) {
      throw new Error(`bsc blockNumber returned garbage: ${String(j?.result).slice(0, 120)}`);
    }
    return h;
  }
  throw new Error(`unsupported chain: ${chain}`);
}

/**
 * Fetch a block's full transaction set for a chain.
 *
 * Returns the block object PLUS pagination bookkeeping:
 *   { ..., txComplete: bool, nextTxIndex: number }
 * `txComplete=false` means the tx set was cut short (subrequest budget or
 * the sanity cap) — the caller must persist nextTxIndex and resume this
 * block next tick instead of marking it done.
 *
 * opts: { startTxIndex?: number, budget?: { remaining: number } }
 */
export async function fetchBlock(chain, blockNum, env, opts = {}) {
  const budget = opts.budget || null;
  const startTxIndex = opts.startTxIndex || 0;
  if (chain === "btc") {
    // 1. Try blockstream.info (reliable, open, doesn't block Cloudflare Workers)
    try {
      if (!takeSubrequest(budget)) throw new Error("subrequest budget exhausted");
      const hash = (await fetchText(`https://blockstream.info/api/block-height/${blockNum}`, { timeoutMs: 6000 })).trim();
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`bad block hash for height ${blockNum}`);

      if (!takeSubrequest(budget)) throw new Error("subrequest budget exhausted");
      const blockHeader = await fetchJSON(`https://blockstream.info/api/block/${hash}`, { timeoutMs: 6000 });

      // Blockstream paginates /txs at 25 per page — the old code fetched
      // only page 0, silently dropping the other ~99% of a full block.
      const txs = [];
      let index = startTxIndex;
      let complete = true;
      let pages = 0;
      for (;;) {
        if (!takeSubrequest(budget)) { complete = false; break; }
        const page = await fetchJSON(`https://blockstream.info/api/block/${hash}/txs/${index}`, { timeoutMs: 15000 });
        if (!Array.isArray(page) || page.length === 0) break;
        txs.push(...page);
        pages++;
        if (page.length < 25) break; // last page
        index += 25;
        if (pages >= MAX_TX_PAGES_PER_BLOCK) { complete = false; break; }
      }
      return {
        height: blockNum,
        time: blockHeader?.timestamp || Math.floor(Date.now() / 1000),
        tx: txs.map(t => ({
          hash: t.txid,
          inputs: (t.vin || []).map(v => ({
            prev_out: {
              addr: v.prevout?.scriptpubkey_address || "",
              value: typeof v.prevout?.value === "number" ? v.prevout.value : 0,
            }
          })),
          out: (t.vout || []).map(o => ({
            addr: o.scriptpubkey_address || "",
            value: o.value || 0
          }))
        })),
        txComplete: complete,
        nextTxIndex: complete ? 0 : index,
      };
    } catch (e) {
      // Budget exhaustion is a tick-level condition, not a provider failure:
      // falling back to blockchain.info would just burn more subrequests.
      if (e.message === "subrequest budget exhausted") throw e;
      console.warn(`[scanner:btc] blockstream block fetch failed for ${blockNum}:`, e.message);
    }

    // 2. Fallback blockchain.info rawblock by height (full block, one call)
    const j = await fetchJSON(`https://blockchain.info/rawblock/${blockNum}`, { timeoutMs: 15000 });
    j.txComplete = true;
    j.nextTxIndex = 0;
    return j;
  }
  if (chain === "eth") {
    const key = env.ETHSCAN_KEY ? `&apikey=${env.ETHSCAN_KEY}` : "";
    const hex = "0x" + Number(blockNum).toString(16);
    if (!takeSubrequest(budget)) throw new Error("subrequest budget exhausted");
    const j = await fetchJSON(
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=${hex}&boolean=true${key}`
    );
    const block = j.result;
    block.txComplete = true;
    block.nextTxIndex = 0;
    return block;
  }
  if (chain === "base") {
    const hex = "0x" + Number(blockNum).toString(16);
    if (!takeSubrequest(budget)) throw new Error("subrequest budget exhausted");
    const r = await fetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [hex, true] }),
    });
    const j = await r.json();
    const block = j.result;
    if (!block) throw new Error(`base block ${blockNum} not found`);
    block.txComplete = true;
    block.nextTxIndex = 0;
    return block;
  }
  if (chain === "bsc") {
    const hex = "0x" + Number(blockNum).toString(16);
    if (!takeSubrequest(budget)) throw new Error("subrequest budget exhausted");
    const r = await fetch("https://bsc-dataseed.binance.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [hex, true] }),
    });
    const j = await r.json();
    const block = j.result;
    if (!block) throw new Error(`bsc block ${blockNum} not found`);
    block.txComplete = true;
    block.nextTxIndex = 0;
    return block;
  }
  throw new Error(`unsupported chain: ${chain}`);
}

/**
 * Fetch ERC20 Transfer logs for a single block, scoped to tracked tokens
 * only. One fetch per tracked contract.
 *
 * etherscan's free-tier getLogs ignores fromBlock/toBlock when the
 * topic-only query is too wide — it just returns the 1000 latest Transfer
 * logs on the whole chain (confirmed live: querying block 0x185e703 with
 * only topic0 came back with logs from block 447767, year 2017). Scoping
 * per-contract (address=) keeps each response < 1000 and makes fromBlock/
 * toBlock actually be honoured. Cost: |TOKENS_BY_CONTRACT| calls per block
 * (currently 2: USDT + USDC) — well within 5 req/s free-tier cap.
 */
export async function fetchERC20Logs(blockNum, env, budget = null, chain = "eth") {
  const key = env.ETHSCAN_KEY ? `&apikey=${env.ETHSCAN_KEY}` : "";
  const fromBlock = "0x" + Number(blockNum).toString(16);
  const toBlock = fromBlock;
  const out = [];
  const tokenMap = chain === "bsc" ? BSC_TOKENS_BY_CONTRACT : chain === "base" ? BASE_TOKENS_BY_CONTRACT : TOKENS_BY_CONTRACT;
  for (const contract of Object.keys(tokenMap)) {
    if (!takeSubrequest(budget)) break; // out of budget — return what we have
    let logsJson;
    if (chain === "bsc" || chain === "base") {
      // Public RPC — eth_getLogs
      try {
        const rpcUrl = chain === "bsc" ? "https://bsc-dataseed.binance.org" : "https://mainnet.base.org";
        const r = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_getLogs",
            params: [{ fromBlock, toBlock, address: contract, topics: [TRANSFER_TOPIC] }],
          }),
        });
        logsJson = await r.json();
      } catch (e) {
        console.warn(`erc20 logs fetch failed for ${contract} on ${chain}:`, e.message);
        continue;
      }
    } else {
      const chainid = EVM_CHAIN_IDS[chain] || 1;
      const url = `https://api.etherscan.io/v2/api?chainid=${chainid}&module=logs&action=getLogs` +
        `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
        `&address=${contract}&topic0=${TRANSFER_TOPIC}${key}`;
      try {
        logsJson = await fetchJSON(url, { timeoutMs: 12000 });
      } catch (e) {
        console.warn(`erc20 logs fetch failed for ${contract}:`, e.message);
        continue;
      }
    }
    try {
      const j = logsJson;
      if (Array.isArray(j.result)) out.push(...j.result);
    } catch (e) {
      // degrade gracefully — skip this token for this block
      console.warn(`erc20 logs parse failed for ${contract}:`, e.message);
    }
  }
  return out;
}

/** Refresh the market_cache key in KV from multi-provider feed (Coinbase, CoinGecko, MEXC) + alternative.me. */
export async function refreshMarketCache(env) {
  let prevCache = null;
  try {
    const raw = await env.KV.get("market_cache");
    if (raw) prevCache = JSON.parse(raw);
  } catch {}

  let btcPrice = prevCache?.btc?.price ?? null;
  let btcChange = prevCache?.btc?.change_24h ?? null;
  let ethPrice = prevCache?.eth?.price ?? null;
  let ethChange = prevCache?.eth?.change_24h ?? null;
  let bnbPrice = prevCache?.bnb?.price ?? null;
  let bnbChange = prevCache?.bnb?.change_24h ?? null;

  // 1. Primary: Coinbase spot (reliable from Cloudflare datacenter IPs, no rate limits)
  try {
    const [btcRes, ethRes, bnbRes] = await Promise.all([
      fetchJSON("https://api.coinbase.com/v2/prices/BTC-USD/spot", { timeoutMs: 4000 }),
      fetchJSON("https://api.coinbase.com/v2/prices/ETH-USD/spot", { timeoutMs: 4000 }),
      fetchJSON("https://api.coinbase.com/v2/prices/BNB-USD/spot", { timeoutMs: 4000 }),
    ]);
    const bp = parseFloat(btcRes?.data?.amount);
    const ep = parseFloat(ethRes?.data?.amount);
    const np = parseFloat(bnbRes?.data?.amount);
    if (Number.isFinite(bp) && bp > 0) btcPrice = bp;
    if (Number.isFinite(ep) && ep > 0) ethPrice = ep;
    if (Number.isFinite(np) && np > 0) bnbPrice = np;
  } catch (e) {
    console.warn("[scanner] coinbase spot fetch failed:", e.message);
  }

  // 2. Secondary: CoinGecko (also provides 24h change)
  try {
    const cgUrl =
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin&vs_currencies=usd&include_24hr_change=true";
    const cg = await fetchJSON(cgUrl, {
      timeoutMs: 5000,
      headers: { "User-Agent": "WhaleSignal/1.0 (price monitor; contact: github.com/saman-ghorayshi/whalesignal)" },
    });
    const bp = (cg?.bitcoin || cg?.prices?.bitcoin)?.usd;
    const ep = (cg?.ethereum || cg?.prices?.ethereum)?.usd;
    const np = (cg?.binancecoin || cg?.prices?.binancecoin)?.usd;
    const bc = (cg?.bitcoin || cg?.prices?.bitcoin)?.usd_24h_change;
    const ec = (cg?.ethereum || cg?.prices?.ethereum)?.usd_24h_change;
    const nc = (cg?.binancecoin || cg?.prices?.binancecoin)?.usd_24h_change;
    if ((btcPrice == null || !Number.isFinite(btcPrice)) && Number.isFinite(bp)) btcPrice = bp;
    if ((ethPrice == null || !Number.isFinite(ethPrice)) && Number.isFinite(ep)) ethPrice = ep;
    if ((bnbPrice == null || !Number.isFinite(bnbPrice)) && Number.isFinite(np)) bnbPrice = np;
    if (Number.isFinite(bc)) btcChange = bc;
    if (Number.isFinite(ec)) ethChange = ec;
    if (Number.isFinite(nc)) bnbChange = nc;
  } catch (e) {
    console.warn("[scanner] coingecko fetch failed:", e.message);
  }

  // 3. Tertiary: MEXC fallback spot ticker
  if (btcPrice == null || ethPrice == null || bnbPrice == null) {
    try {
      const [mexcBtc, mexcEth, mexcBnb] = await Promise.all([
        fetchJSON("https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT", { timeoutMs: 4000 }),
        fetchJSON("https://api.mexc.com/api/v3/ticker/price?symbol=ETHUSDT", { timeoutMs: 4000 }),
        fetchJSON("https://api.mexc.com/api/v3/ticker/price?symbol=BNBUSDT", { timeoutMs: 4000 }),
      ]);
      const bp = parseFloat(mexcBtc?.price);
      const ep = parseFloat(mexcEth?.price);
      const np = parseFloat(mexcBnb?.price);
      if (btcPrice == null && Number.isFinite(bp)) btcPrice = bp;
      if (ethPrice == null && Number.isFinite(ep)) ethPrice = ep;
      if (bnbPrice == null && Number.isFinite(np)) bnbPrice = np;
    } catch (e) {
      console.warn("[scanner] mexc fallback fetch failed:", e.message);
    }
  }

  // 4. Safe baseline fallback if every network provider timed out
  if (btcPrice == null || !Number.isFinite(btcPrice)) btcPrice = 80_000;
  if (ethPrice == null || !Number.isFinite(ethPrice)) ethPrice = 2_400;
  if (bnbPrice == null || !Number.isFinite(bnbPrice)) bnbPrice = 570;
  if (btcChange == null || !Number.isFinite(btcChange)) btcChange = 0;
  if (ethChange == null || !Number.isFinite(ethChange)) ethChange = 0;
  if (bnbChange == null || !Number.isFinite(bnbChange)) bnbChange = 0;

  // Fear & Greed index
  let fg = null;
  try {
    fg = await fetchJSON("https://api.alternative.me/fng/?limit=1", { timeoutMs: 3000 });
  } catch (e) {
    console.warn("[scanner] alternative.me fear_greed fetch failed:", e.message);
  }

  // NB: a genuine "0" (extreme fear) is falsy — check for null, not truthiness.
  const fgRaw = fg?.data?.[0]?.value;
  const fgVal = fgRaw != null && fgRaw !== "" ? parseInt(fgRaw, 10) : (prevCache?.fear_greed ?? 50);
  const fgLabel = fg?.data?.[0]?.value_classification ?? (prevCache?.fear_greed_label ?? "Neutral");

  const cache = {
    btc: { price: btcPrice, change_24h: btcChange },
    eth: { price: ethPrice, change_24h: ethChange },
    bnb: { price: bnbPrice, change_24h: bnbChange },
    usdt: { price: 1, change_24h: 0 },
    usdc: { price: 1, change_24h: 0 },
    wbtc: { price: btcPrice, change_24h: btcChange },
    dai: { price: 1, change_24h: 0 },
    fear_greed: fgVal,
    fear_greed_label: fgLabel,
    updated_at: Date.now(), // ms
  };
  try {
    await env.KV.put("market_cache", JSON.stringify(cache));
  } catch (e) {
    console.warn("[scanner] failed to put market_cache in KV:", e.message);
  }
  return cache;
}

// ─── news_cache (Phase 3a / whale-reasoning Plan Ladder A) ───────────
// CryptoPanic free-tier reader, keyword-filtered to the asset classes we
// alert on. Mirror of refreshMarketCache: one fetch, KV write, caller wraps
// in try/catch. Stores {headlines:Array<{title}>, updated_at} so the analyst
// can read both shape and staleness without a second key.
//
// ONE feed, ONE keyword regex, ONE KV put. No GDELT/Twitter/Reddit
// (Phase 4+ — LLM gets diminishing returns past 5 headlines anyway). The
// analyst prompt slot already exists; we're filling it, not building a new one.
const NEWS_CACHE_TTL_S = 300;            // same cadence as market_cache
const NEWS_KEYWORDS = /\b(binance|coinbase|kraken|bybit|okx|bitfinex|upbit|hack|exploit|drain|stolen|breach|vulnerability|exit scam|sec|lawsuit|sued|ban|sanctioned|settlement|charging|depeg|stablecoin|usdt|usdc|insurance|halt|withdrawal|etf|futures|expiry|options|listing|delisting|upgrade|fork|halving)\b/i;

/**
 * Pure: keyword-filter CryptoPanic items to the top 5 matching titles.
 * Exported for unit tests. Case-insensitive whole-word match on the title.
 * title only → cheaper than walking body, matches what the
 * analyst prompt slot prints (`n.title`).
 */
export function filterNewsKeywords(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof it.title === "string" && NEWS_KEYWORDS.test(it.title))
    .slice(0, 5)
    .map((it) => ({ title: it.title }));
}

/**
 * Refresh the news_cache key in KV from CryptoPanic. Stores
 * {headlines:Array<{title}>, updated_at:ms}. On any fetch/parse error, writes
 * an empty-headlines object so the analyst prompt slot prints its existing
 * "(no recent headlines cached)" fallback — no special-case code path.
 * Mirror of refreshMarketCache (caller try/catch, not internal).
 */
export async function refreshNewsCache(env) {
  // CryptoPanic's no-key endpoint returns 410 Gone since ~Oct 2026; without
  // NEWS_TOKEN this no-ops and the news worker's D1 feed carries the slot.
  if (!env.NEWS_TOKEN) {
    const cache = { headlines: [], updated_at: Date.now(), source: "d1" };
    await env.KV.put("news_cache", JSON.stringify(cache));
    return cache;
  }
  // filter=hot returns the most-tweeted headlines — broader signal than
  // kind=news alone.
  const url = `https://cryptopanic.com/api/v1/posts/?kind=news&filter=hot&auth_token=${env.NEWS_TOKEN}`;
  const j = await fetchJSON(url, { timeoutMs: 6000 });
  const headlines = filterNewsKeywords(j?.results ?? []);
  const cache = { headlines, updated_at: Date.now() };
  await env.KV.put("news_cache", JSON.stringify(cache));
  return cache;
}

// ─── scan one chain (with batched catch-up) ──────────────────────────
//
// Invariants:
// - last_block = last FULLY processed block. A block is only marked done
//   after its inserts AND its persistState both succeeded, so a retry never
//   re-processes a completed block (wallet stats can't double-count).
// - Blocks younger than CONFIRMATIONS[chain] are never scanned (reorg
//   protection): an alert from an orphaned block is worse than a late alert.
// - BTC pagination across ticks: scanner_state.tx_offset remembers how far
//   into a huge block's tx pages we got; the next tick resumes there.

export async function scanChain(env, chain, market, budget = null) {
  const state = await getState(env, chain);
  const maxBlocks = parseEnvInt(env.MAX_BLOCKS, DEFAULT_MAX_BLOCKS);
  const minUsd = parseEnvInt(env.MIN_USD, DEFAULT_MIN_USD);
  // fetchLatestBlockHeight throws on garbage (S5) — a dead API key fails
  // the scan loudly (bumpErrors) instead of silently reporting success.
  const latest = await fetchLatestBlockHeight(env, chain);
  // first run: prime from latest (no processing this tick, just record where we are)
  if (state.last_block == null) {
    console.log(`[scanner:${chain}] first run — priming last_block=${latest}`);
    await persistState(env, chain, latest);
    return { chain, processed: 0, newWhales: 0, primed: true };
  }
  const conf = CONFIRMATIONS[chain] ?? 1;
  const scanTo = latest - conf;
  if (scanTo <= state.last_block) {
    return { chain, processed: 0, newWhales: 0, primed: false };
  }

  const walletMap = await loadWalletMap(env);

  let cursor = state.last_block + 1;
  let lastPersisted = state.last_block;
  let processed = 0;
  let newlyCounted = 0;
  let persistedThisTick = false;
  while (cursor <= scanTo && processed < maxBlocks) {
    // Resume a partially-paginated BTC block where the last tick left off.
    const startTxIndex = processed === 0 ? (state.tx_offset || 0) : 0;

    let fetched;
    try {
      fetched = await fetchBlock(chain, cursor, env, { startTxIndex, budget });
    } catch (e) {
      // Fetch failed (provider down OR subrequest budget exhausted):
      // stop the batch here. last_block is untouched so the next tick
      // retries this exact block — no gaps, no double counts.
      console.warn(`[scanner:${chain}] fetchBlock(${cursor}) failed:`, e.message);
      break;
    }

    if (!fetched.txComplete) {
      // Ran out of subrequest budget (or hit the page sanity cap) mid-
      // pagination: remember the offset, do NOT advance last_block, and
      // continue next tick. The block's whales are processed only once the
      // full tx set is in hand (partial data + non-idempotent wallet bumps
      // would corrupt stats).
      await persistState(env, chain, lastPersisted, fetched.nextTxIndex, 0);
      persistedThisTick = true;
      console.log(`[scanner:${chain}] block ${cursor} partially paginated — resuming at tx index ${fetched.nextTxIndex} next tick`);
      break;
    }

    const block = fetched;
    let blockNew = 0;
    try {
      const candidates =
        chain === "btc"
          ? extractCandidatesBTC(block, market)
          : extractCandidatesETH(block, market, chain);

      // for ETH, also pull ERC20 Transfer logs (extra RPCs, budget-bounded)
      let erc20 = [];
      if (chain === "eth" || chain === "bsc" || chain === "base") {
        const logs = await fetchERC20Logs(cursor, env, budget, chain);
        erc20 = extractERC20Candidates(logs, market, chain).map((c) => ({
          ...c,
          block_time: parseInt(block?.timestamp, 16) * 1000 || null,
        }));
      }

      const all = [...candidates, ...erc20];
      const whales = classifyWhales(filterWhales(all, minUsd), walletMap);

      for (const w of whales) {
        try {
          const fromKey = String(w.from_address).toLowerCase();
          const walletInfo = walletMap.get(fromKey) ?? null;
          const recentSameWallet = await recentWhalesFromWallet(env, w.from_address, w.chain);
          const inserted = await insertWhaleAndQueue(env, w, walletMap, walletInfo, recentSameWallet, market);
          if (inserted) blockNew++;
        } catch (e) {
          console.warn(`[scanner:${chain}] insert failed for ${w.tx_hash}:`, e.message);
        }
      }

      // Per-block persist: crash after this point re-scans from cursor+1,
      // never re-processing this block's wallet-stat bumps.
      await persistState(env, chain, cursor, 0, blockNew);
      persistedThisTick = true;
    } catch (e) {
      console.warn(`[scanner:${chain}] block ${cursor} processing failed:`, e.message);
      break;
    }
    lastPersisted = cursor;
    newlyCounted += blockNew;
    processed++;
    cursor++;
  }

  if (!persistedThisTick) {
    // Nothing new (or the batch broke before any persist) — still refresh
    // last_scan so monitoring sees a live scanner, and reset the error
    // counter, as a successful tick should. Offset is untouched.
    await persistState(env, chain, lastPersisted, state.tx_offset || 0, 0);
  }
  return { chain, processed, newWhales: newlyCounted, primed: false };
}

// ─── TRON (USDT) — timestamp-based event polling ─────────────────────
// TRON produces a block every ~3s (28k/day) — block-by-block scanning is
// infeasible. Instead we poll TronGrid's TRC-20 Transfer events for USDT,
// which is where virtually all TRON whale value moves. State tracks the
// max block_timestamp seen (stored in scanner_state.last_block as ms).

const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_USDT_DECIMALS = 6;

/** Fetch USDT Transfer events since sinceMs (TronGrid, free, no key). */
export async function fetchTronEvents(sinceMs, limit = 200) {
  const url =
    `https://api.trongrid.io/v1/contracts/${TRON_USDT_CONTRACT}/events` +
    `?event_name=Transfer&limit=${limit}&order_by=block_timestamp,desc` +
    `&min_block_timestamp=${sinceMs}`;
  const j = await fetchJSON(url, { timeoutMs: 10000 });
  if (!j || j.success !== true || !Array.isArray(j.data)) {
    throw new Error(`TronGrid: bad response (success=${j?.success})`);
  }
  return j.data;
}

/** Parse TronGrid Transfer events into whale candidates. Pure. */
export function extractCandidatesTRON(events) {
  const out = [];
  for (const e of events || []) {
    const r = e.result || {};
    const raw = r.value;
    if (raw == null) continue;
    const amount = Number(raw) / 10 ** TRON_USDT_DECIMALS;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    // TRON addresses are base58check case-SENSITIVE — never lowercase
    const from = String(r.from || "");
    const to = String(r.to || "");
    if (!from || !to) continue;
    out.push({
      chain: "tron",
      symbol: "USDT",
      tx_hash: String(e.transaction_id || ""),
      from_address: from,
      to_address: to,
      amount,
      usd_value: amount, // USDT ≈ $1
      block_number: e.block_number ?? null,
      block_time: e.block_timestamp ?? null,
      detected_at: Date.now(),
      is_self_transfer: from === to,
      contract_address: TRON_USDT_CONTRACT,
    });
  }
  return out;
}

/**
 * Scan TRON USDT transfers since the last-seen timestamp.
 * Idempotent: UNIQUE(chain, tx_hash, symbol) + INSERT OR IGNORE.
 */
export async function scanTron(env, market, budget = null) {
  const chain = "tron";
  const minUsd = parseEnvInt(env.MIN_USD, DEFAULT_MIN_USD);
  let state = await getState(env, chain);
  const now = Date.now();

  // First run: prime from now (don't backfill history on deploy).
  if (state.last_block == null) {
    // ensure the scanner_state row exists
    try {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO scanner_state (chain, last_block, last_scan) VALUES (?, ?, ?)"
      ).bind(chain, now, now).run();
    } catch {}
    console.log(`[scanner:tron] first run — priming last_block=${now}`);
    await persistState(env, chain, now, 0, 0);
    return { chain, processed: 0, newWhales: 0, primed: true };
  }

  const sinceMs = Number(state.last_block) || now - 120000;
  let events;
  try {
    if (!takeSubrequest(budget)) {
      console.warn("[scanner:tron] subrequest budget exhausted — skipping tick");
      return { chain, processed: 0, newWhales: 0, primed: false };
    }
    events = await fetchTronEvents(sinceMs + 1);
  } catch (e) {
    console.warn("[scanner:tron] fetch failed:", e.message);
    throw e;
  }

  const walletMap = await loadWalletMap(env);
  const candidates = extractCandidatesTRON(events);
  const whales = classifyWhales(filterWhales(candidates, minUsd), walletMap);

  let newWhales = 0;
  let maxTs = sinceMs;
  for (const w of whales) {
    try {
      const fromKey = String(w.from_address).toLowerCase();
      const walletInfo = walletMap.get(fromKey) ?? null;
      const recentSameWallet = await recentWhalesFromWallet(env, w.from_address, w.chain);
      const inserted = await insertWhaleAndQueue(env, w, walletMap, walletInfo, recentSameWallet, market);
      if (inserted) newWhales++;
    } catch (e) {
      console.warn(`[scanner:tron] whale insert failed:`, e.message);
    }
  }
  // Advance the watermark past everything we saw (even sub-threshold —
  // re-fetching them every tick would be pure waste).
  for (const c of candidates) {
    if (c.block_time && c.block_time > maxTs) maxTs = c.block_time;
  }
  await persistState(env, chain, maxTs, 0, newWhales);
  return { chain, processed: events.length, newWhales, primed: false };
}

// ─── entry ─────────────────────────────────────────────────────────────

export default {
  // scheduled (cron) handler. Cloudflare free Workers cron runs AT MOST
  // every 1 minute — the plan's "cron every 30s" symbol isn't achievable on
  // a real cron trigger. We set the cron to * * * * * (every minute) and
  // internally decide whether to refresh market cache based on TTL, not on
  // a per-tick KV counter (a counter would burn the 1K KV writes/day cap).
  async scheduled(event, env, ctx) {
    let market = null;
    let needMarketRefresh = true;
    try {
      const raw = await env.KV.get("market_cache");
      market = raw ? JSON.parse(raw) : null;
      if (market && market.updated_at) {
        const ageS = (Date.now() - market.updated_at) / 1000;
        needMarketRefresh = ageS > MARKET_CACHE_TTL_S;
      }
    } catch { /* ignore — will be null/refresh */ }

    if (needMarketRefresh || !market || !market.btc?.price) {
      try {
        market = await refreshMarketCache(env);
      } catch (e) {
        console.warn("market cache refresh failed:", e.message);
      }
    }

    // D1 retention: delete whales older than 30 days (prevents unbounded growth).
    // Runs once per hour (gated by KV timestamp) to avoid D1 write spam.
    try {
      const lastCleanup = parseInt(await env.KV.get("whales_cleanup_at") || "0", 10) || 0;
      if (Date.now() - lastCleanup > 3600000) {
        const r = await env.DB.prepare("DELETE FROM whales WHERE detected_at < ?")
          .bind(Date.now() - 30 * 86400000).run();
        await env.KV.put("whales_cleanup_at", String(Date.now()), { expirationTtl: 7200 });
        if ((r.meta?.changes ?? 0) > 0) console.log(`[scanner] cleaned ${(r.meta.changes)} old whales`);
      }
    } catch (e) {
      console.warn("[scanner] whales cleanup failed:", e.message);
    }

    if (!market || !market.btc?.price) {
      market = {
        btc: { price: 80_000, change_24h: 0 },
        eth: { price: 2_400, change_24h: 0 },
        usdt: { price: 1, change_24h: 0 },
        usdc: { price: 1, change_24h: 0 },
        wbtc: { price: 80_000, change_24h: 0 },
        dai: { price: 1, change_24h: 0 },
        fear_greed: 50,
        fear_greed_label: "Neutral",
        updated_at: Date.now(),
      };
    }

    // news_cache: same pattern as market_cache (TTL gate + try/catch wrapper
    // so a CryptoPanic outage or rate-limit never breaks the scan).
    // one extra KV read + one conditional fetch per tick. No new
    // cron worker, no new infra. The analyst already reads `news_cache`.
    try {
      let needNewsRefresh = true;  // default: refresh when nothing cached
      try {
        const rawNews = await env.KV.get("news_cache");
        if (rawNews) {
          const n = JSON.parse(rawNews);
          if (n && n.updated_at) {
            needNewsRefresh = ((Date.now() - n.updated_at) / 1000) > NEWS_CACHE_TTL_S;
          }
        }
      } catch { /* keep needNewsRefresh=true */ }
      if (needNewsRefresh) {
        try { await refreshNewsCache(env); }
        catch (e) { console.warn("news cache refresh failed:", e.message); }
      }
    } catch { /* never break the scan over news cache */ }

    // One subrequest budget shared by both chains for this tick: Workers
    // allow 50 subrequests per invocation and market+news+tip overhead is
    // ~9-12. scanChain stops fetching (persisting progress) when it's out.
    // Enterprise: per-chain subrequest budgets. A shared pool lets one hungry
    // chain (Solana: 15 wallets × N txs) starve the others. Each chain gets
    // a guaranteed reservation; total stays under the 50 CF limit.
    // Budget: BTC 8, ETH 8, BSC 6, Base 6, TRON 6, Solana 10 = 44 total.
    const CHAIN_BUDGETS = { btc: 8, eth: 8, bsc: 6, base: 6, tron: 6, solana: 10 };

    const results = [];
    for (const chain of ["btc", "eth", "bsc", "base", "tron", "solana"]) {
      const budget = { remaining: CHAIN_BUDGETS[chain] || 6 };
      // Circuit breaker: if a chain has 5+ consecutive errors, back off
      // exponentially (don't waste budget on a dead RPC every tick).
      try {
        const st = await getState(env, chain);
        if ((st.errors || 0) >= 5) {
          const backoffMin = Math.min(60, Math.pow(2, (st.errors || 5) - 5) * 5);
          const lastScan = st.last_scan || 0;
          if (Date.now() - lastScan < backoffMin * 60000) {
            results.push({ chain, skipped: "circuit_breaker", errors: st.errors });
            continue;
          }
        }
      } catch {}
      try {
        results.push(
          chain === "tron"
            ? await scanTron(env, market, budget)
            : chain === "solana"
              ? await scanSolana(env, market, budget)
              : await scanChain(env, chain, market, budget)
        );
      } catch (e) {
        console.error(`[scanner:${chain}] scan failed:`, e.message);
        await bumpErrors(env, chain);
        results.push({ chain, error: e.message });
      }
    }
    console.log("[scanner] tick done:", JSON.stringify(results));
    return results;
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/scan" || url.pathname === "/tick") {
      // Fail closed: when ADMIN_TOKEN was never set these endpoints used to
      // be open to the internet (anyone could trigger scans and burn the
      // API budget). Deny first, compare second.
      if (!env.ADMIN_TOKEN) {
        return new Response(JSON.stringify({ error: "admin not configured" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      const auth = request.headers.get("authorization") || url.searchParams.get("token");
      if (auth !== `Bearer ${env.ADMIN_TOKEN}` && auth !== env.ADMIN_TOKEN) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      const results = await this.scheduled({}, env, ctx);
      return new Response(JSON.stringify({ ok: true, results }), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, service: "whalesignal-scanner" }), {
      headers: { "content-type": "application/json" }
    });
  },
};
