// src/scanner.js
// Cron-triggered worker (every 30s). Scans BTC + ETH blocks for whale txs,
// writes new whales to D1, queues each one to the analyst for AI analysis.
//
// ALSO refreshes the market_cache in KV every 5th scan (~every 2.5 min).
// RPCs cost API budget — keep them tight. NO API calls per-tx (use cached
// price from KV instead; the original plan said to cache it then the
// pseudocode ignored the cache — fixed here).
//
// Critical design choice: block catch-up is BATCHED. If the scanner was
// down for an hour and 300 ETH blocks piled up, we will NOT try to process
// them all in one 30s cron tick. We process up to MAX_BLOCKS_PER_SCAN and
// then update last_block and return. The next tick picks up the rest.
// This keeps us inside the Workers request envelope even after an outage.
//
// Bindings (env):
//   DB       — D1 database
//   KV       — KV namespace (for market_cache/others)
//   ANALYSTQ — Queue to analyst
//   ETHSCAN_KEY, BSCSCAN_KEY — optional etherscan keys
//   MIN_USD  — string, overrides default 500000
//   MAX_BLOCKS — string, overrides default 10

import { fetchJSON, classifyTx, usdValue, buildWalletMap, labelFor, ZERO_ADDRESS, isBurnSink } from "./worker-utils.js";

// consts (also overrideable via env)
const DEFAULT_MIN_USD = 500_000;
// 10 blocks/tick sounded nice until a fat BTC block (3k+ txs) blew the
// free-tier CPU budget mid-batch and the whole invocation died — taking
// unsaved progress with it. 2-3 keeps each tick comfortably under the cap;
// catch-up still converges because state persists after every block.
const DEFAULT_MAX_BLOCKS = 3;
// KV free tier = 1K writes/day. Scanner cron = 1/min (real cron floor), so
// we must NOT write per-tick. Instead we decay-cache: refresh market_cache
// only if the cached object is older than MARKET_CACHE_TTL_S. That gives us
// max ~1 cache write every 5 min = 288/day, well under the 1K cap with headroom.
const MARKET_CACHE_TTL_S = 300;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(addr,a,uint256)

// known stablecoin + tracked-token contract → symbol mapping (eth mainnet)
// used by ERC20 log filtering. add as we expand chains.
const TOKENS_BY_CONTRACT = {
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
  "0x514910771af9ca656af840dff83e8264ecf986ca": "LINK",
};

// ─── pure helpers (testable without env) ──────────────────────────────

/**
 * Filter a decoded chain block into a list of whale tx candidates (native + ERC20).
 * Pure. Caller passes the cached market object + the block body.
 * Returns an array of normalized candidate objects, NOT yet filtered by min USD.
 * Each: { chain, tx_hash, from_address, to_address, amount, symbol, block_number, block_time }
 */
export function extractCandidatesBTC(block, market) {
  const out = [];
  if (!block || !Array.isArray(block.tx)) return out;
  const bn = typeof block.height === "number" ? block.height : null;
  const bt = block.time ? block.time * 1000 : null; // blockchain.info gives unix s
  for (const tx of block.tx) {
    // sum outputs (multiple vouts possible), pick largest output's address as `to`
    const totalOut = (Array.isArray(tx.out) ? tx.out : []).reduce((s, o) => s + (o.value || 0), 0);
    const firstIn = Array.isArray(tx.inputs) && tx.inputs[0]?.prev_out?.addr ? tx.inputs[0].prev_out.addr : "";
    const toAddrs = (Array.isArray(tx.out) ? tx.out : []).map((o) => o.addr).filter(Boolean);
    const toAddr = toAddrs[0] ?? "";
    if (!tx.hash || totalOut <= 0) continue;
    // blockchain.info amounts are in satoshis; BTC decimal 8
    const amountBtc = totalOut / 1e8;
    out.push({
      chain: "btc",
      tx_hash: tx.hash,
      from_address: firstIn,
      to_address: toAddr,
      amount: amountBtc,
      symbol: "BTC",
      block_number: bn,
      block_time: bt,
      // precompute USD here so the scan loop stays pure
      usd_value: usdValue(amountBtc, "BTC", market),
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
export function extractCandidatesETH(block, market) {
  const out = [];
  if (!block || !Array.isArray(block.transactions)) return out;
  for (const tx of block.transactions) {
    if (typeof tx === "string") continue; // we asked for full txs
    const valHex = tx.value || "0x0";
    const amount = parseInt(valHex, 16) / 1e18; // wei -> ETH
    if (!tx.hash || amount <= 0) continue;
    out.push({
      chain: "eth",
      tx_hash: tx.hash,
      from_address: tx.from || "",
      to_address: tx.to || "",
      amount,
      symbol: "ETH",
      block_number: parseInt(block.number, 16),
      block_time: parseInt(block.timestamp, 16) * 1000,
      usd_value: usdValue(amount, "ETH", market),
    });
  }
  return out;
}

/**
 * Filter ERC20 Transfer logs (from eth_getLogs filtered by topic0) into candidates.
 * Pure. `logs` = array of log entries with topics=[topic0, from, to] and data=hex amount.
 */
export function extractERC20Candidates(logs, market) {
  const out = [];
  if (!Array.isArray(logs)) return out;
  for (const lg of logs) {
    if (!Array.isArray(lg.topics) || lg.topics.length < 3) continue;
    const contract = (lg.address || "").toLowerCase();
    const sym = TOKENS_BY_CONTRACT[contract];
    if (!sym) continue; // not a tracked token
    // topics are 32-byte hex words; from = bytes12..32, to likewise
    const from = "0x" + (lg.topics[1] || "").slice(26);
    const to = "0x" + (lg.topics[2] || "").slice(26);
    let amount;
    try {
      amount = parseInt(lg.data || "0x0", 16);
    } catch { continue; }
    // decimals differ per token — keep a small table
    const decimals = TOKEN_DECIMALS[sym] ?? 18;
    amount = amount / Math.pow(10, decimals);
    out.push({
      chain: "eth",
      tx_hash: lg.transactionHash,
      from_address: from,
      to_address: to,
      amount,
      symbol: sym,
      block_number: typeof lg.blockNumber === "string" ? parseInt(lg.blockNumber, 16) : lg.blockNumber,
      block_time: null, // filled later from the block
      usd_value: usdValue(amount, sym, market),
      _contract: contract,
    });
  }
  return out;
}

// token decimals (for converting log amounts)
const TOKEN_DECIMALS = {
  USDT: 6, USDC: 6, DAI: 18, WBTC: 8, LINK: 18,
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

  // ── supply operations — mint/burn are rare and market-moving (0-18) ──
  // A $50M USDT print is the single most-watched whale signal on crypto
  // twitter; burns shrink supply. Bridges/miners get milder treatment.
  if (w.tx_type === "mint" || w.tx_type === "burn") {
    score += usd >= 10_000_000 ? 18 : 10;
  } else if (w.tx_type === "miner_flow") {
    score += 8;
  } else if (w.tx_type === "bridge_flow") {
    // routine rotation unless it's big enough that size alone already scores
    if (usd < 5_000_000) score -= 4;
  }

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

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Attach a tx_type (exchange_inflow etc.) using the wallet label map. Pure. */
export function classifyWhales(whales, walletMap) {
  return whales.map((w) => {
    const from = String(w.from_address || "").toLowerCase();
    const to = String(w.to_address || "").toLowerCase();
    // supply operations beat everything: a Transfer from 0x0 is a mint,
    // one into 0x0/...dEaD is a burn — labels can't override these
    if (from === ZERO_ADDRESS) return { ...w, tx_type: "mint" };
    if (isBurnSink(to)) return { ...w, tx_type: "burn" };
    const fromType = walletMap.get(from)?.type || null;
    const toType = walletMap.get(to)?.type || null;
    const { tx_type } = classifyTx(fromType, toType);
    return { ...w, tx_type };
  });
}

// ─── runtime: scan logic ──────────────────────────────────────────────

/** Get last_block for a chain (or null for first run). */
async function getState(env, chain) {
  const row = await env.DB.prepare("SELECT last_block, total_whales, errors FROM scanner_state WHERE chain = ?")
    .bind(chain).first();
  return row || { last_block: null, total_whales: 0, errors: 0 };
}

/** Mark last_block + last_scan for a chain. Called AFTER the batch succeeds. */
async function persistState(env, chain, lastBlock) {
  await env.DB.prepare(
    "UPDATE scanner_state SET last_block = ?, last_scan = ?, errors = 0 WHERE chain = ?"
  ).bind(lastBlock, Date.now(), chain).run();
}

/** Increment the consecutive-errors counter on a failure. */
async function bumpErrors(env, chain) {
  await env.DB.prepare("UPDATE scanner_state SET errors = errors + 1 WHERE chain = ?")
    .bind(chain).run();
}

/**
 * Insert a new whale + conditionally queue it to analyst.
 * Returns true if newly inserted (regardless of whether queued).
 *
 * Sprint 1: the interestingness score gates whether we spend a Gemini call.
 * Score >= SCORE_THRESHOLD → queue to analyst (AI analysis).
 * Below → INSERT with analysis_status='skipped' (no AI cost, no queue msg).
 */
/**
 * Build (not execute) the full statement set for one whale: the INSERT plus
 * any wallet-stats/auto-label UPDATEs. Executed by the caller via DB.batch()
 * so a whole block's whales cost ~1 subrequest instead of ~6 each.
 */
function prepareWhaleWrite(env, wh, walletMap, walletInfo, recentSameWallet, market) {
  const score = computeInterestingness(wh, walletInfo, recentSameWallet);
  const shouldAnalyze = score >= SCORE_THRESHOLD;

  // Price snapshot at detect time for AI accuracy evaluation.
  const sym = (wh.symbol || "").toLowerCase();
  const priceAtDetect = market?.[sym]?.price ?? market?.[wh.chain]?.price ?? null;

  const insertStmt = env.DB.prepare(
    `INSERT OR IGNORE INTO whales
       (chain, tx_hash, from_address, to_address, amount, symbol, usd_value,
        tx_type, block_number, block_time, detected_at, analysis_status,
        interesting_score, price_at_detect)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    wh.chain, wh.tx_hash, wh.from_address, wh.to_address,
    wh.amount, wh.symbol, wh.usd_value, wh.tx_type,
    wh.block_number ?? null, wh.block_time ?? null,
    Date.now(),
    shouldAnalyze ? "pending" : "skipped",
    score,
    priceAtDetect
  );

  // Bump wallet stats for non-exchange addresses, folded into the same batch.
  const extraStmts = [];
  const fromType = walletMap?.get(String(wh.from_address).toLowerCase())?.type || null;
  const toType = walletMap?.get(String(wh.to_address).toLowerCase())?.type || null;
  const targets = statTargets(wh.from_address, wh.to_address, fromType, toType);
  if (targets.length > 0) {
    extraStmts.push(env.DB.prepare(
      "UPDATE wallets SET last_seen = ?, last_tx_hash = ?, " +
      "tx_count = tx_count + 1, total_volume = total_volume + ? " +
      "WHERE address IN (" + targets.map(() => "?").join(",") + ") AND chain = ?"
    ).bind(Date.now(), wh.tx_hash, wh.usd_value, ...targets, wh.chain));
    extraStmts.push(...autoLabelStmts(targets, wh.chain, walletMap, walletInfo));
  }

  return { insertStmt, extraStmts, shouldAnalyze };
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
/**
 * Auto-assign wallet reputation labels after the stats bump — statement
 * BUILDER (pure, no execution): the caller folds these into the same
 * DB.batch() as the inserts. Rules:
 * - tx_count >= 3 → type='whale'
 * - dormant for >1yr and now active → pattern='reactivated'
 * - high frequency (>10 txs in 24h visible in our data) → pattern='high_frequency'
 *
 * No extra reads — we use the walletMap we already loaded + walletInfo.
 * Upgrade path: move to a scheduled cron job that recomputes all labels
 * from scratch if the rules get complex.
 */
function autoLabelStmts(targets, chain, walletMap, walletInfo) {
  const stmts = [];
  for (const addr of targets) {
    const key = String(addr).toLowerCase();
    const info = walletMap?.get(key) ?? walletInfo;
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
      stmts.push(env.DB.prepare(
        "UPDATE wallets SET " + updates.join(", ") + " WHERE address = ? AND chain = ?"
      ).bind(addr, chain));
    }
  }
  return stmts;
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
 * Spam-penalty context for EVERY wallet in a block, in ONE query. Replaces
 * the old per-whale recentWhalesFromWallet() call (1 subrequest each — the
 * main reason busy blocks blew the 50-subrequest cap). Returns
 * Map<lowercased_from_address, [{detected_at}, …]> capped at last 10 per
 * wallet, matching the old shape consumed by computeInterestingness.
 */
async function recentWhalesForAddresses(env, addresses, chain) {
  const map = new Map();
  if (!addresses.length) return map;
  const placeholders = addresses.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT from_address, detected_at FROM whales
     WHERE chain = ? AND from_address IN (${placeholders})
     ORDER BY detected_at DESC LIMIT 300`
  ).bind(chain, ...addresses).all();
  for (const r of results || []) {
    const k = String(r.from_address || "").toLowerCase();
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    if (map.get(k).length < 10) map.get(k).push({ detected_at: r.detected_at });
  }
  return map;
}

/**
 * Etherscan API key under either spelling — ETHSCAN_KEY is the historical
 * name in wrangler.scanner.toml comments, ETHERSCAN_KEY is the intuitive
 * one people actually paste. Accepting both costs one line and saves a
 * "why is eth not scanning" debugging session.
 */
/** Rotate across comma-separated keys (KV or env) to spread rate limits. */
async function etherscanKeyParam(env) {
  let keys = [];
  try {
    const kv = await env.KV.get("key:etherscan");
    if (kv) keys = kv.split(",").map(s => s.trim()).filter(Boolean);
  } catch { /* kv hiccup */ }
  if (!keys.length) {
    const raw = env.ETHSCAN_KEY || env.ETHERSCAN_KEY || "";
    if (raw) keys = raw.split(",").map(s => s.trim()).filter(Boolean);
  }
  if (!keys.length) return "";
  const k = keys[Math.floor(Math.random() * keys.length)];
  return `&apikey=${k}`;
}

/** Fetch the latest block height for a chain. Returns an int (eth: decimal number, btc: height). */
export async function fetchLatestBlockHeight(env, chain) {
  if (chain === "btc") {
    try {
      const j = await fetchJSON("https://blockchain.info/latestblock");
      return j.height;
    } catch (e) {
      // blockchain.info throttles/blocks shared Workers egress IPs — fall
      // through to PublicNode's plain bitcoind RPC rather than stalling.
      console.warn("btc tip via blockchain.info failed, falling back to publicnode:", e.message);
      return await btcRpc("getblockcount", []);
    }
  }
  if (chain === "eth") {
    // etherscan V2 (V1 was deprecated — returns "switch to V2 migration").
    // V2 requires a key even for free tier; ETHSCAN_KEY env var is mandatory.
    const key = await etherscanKeyParam(env);
    const j = await fetchJSON(
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber${key}`
    );
    return parseInt(j.result, 16);
  }
  throw new Error(`unsupported chain: ${chain}`);
}

/** Fetch a block's full transaction set for a chain.
 *  maxBytes guards against monster blocks: parsing a multi-MB body exceeds
 *  the free-tier CPU budget and kills the invocation before anything
 *  persists — the poison-pill loop. Better to skip the block entirely. */
export async function fetchBlock(chain, blockNum, env) {
  if (chain === "btc") {
    // blockchain.info rawblock by height works — until their WAF decides
    // Workers' shared IPs are bots. PublicNode bitcoind RPC is the failover;
    // its verbose block is normalized into the blockchain.info shape so
    // extractCandidatesBTC stays untouched.
    try {
      const j = await fetchJSON(`https://blockchain.info/rawblock/${blockNum}`, { maxBytes: 1_500_000 });
      return j;
    } catch (e) {
      console.warn(`btc block ${blockNum} via blockchain.info failed, falling back to publicnode:`, e.message);
      const hash = await btcRpc("getblockhash", [blockNum]);
      const blk = await btcRpc("getblock", [hash, 2], { maxBytes: 4_000_000 });
      return normalizeRpcBtcBlock(blockNum, blk);
    }
  }
  if (chain === "eth") {
    const key = await etherscanKeyParam(env);
    const hex = "0x" + Number(blockNum).toString(16);
    const j = await fetchJSON(
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=${hex}&boolean=true${key}`,
      { maxBytes: 3_000_000 }
    );
    return j.result;
  }
  throw new Error(`unsupported chain: ${chain}`);
}

// ─── BTC failover source (PublicNode bitcoind RPC) ────────────────────────

/** One JSON-RPC call to PublicNode's public bitcoin node. Throws on rpc error.
 *  opts.maxBytes guards the CPU budget: a verbose multi-MB block that would
 *  die in res.json() gets rejected on content-length BEFORE parsing, so the
 *  caller's per-block catch can skip it and persistState keeps moving. */
async function btcRpc(method, params, opts = {}) {
  const j = await fetchJSON("https://bitcoin-rpc.publicnode.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    timeoutMs: 9000,
    maxBytes: opts.maxBytes ?? 0,
  });
  if (j.error) throw new Error(`btc rpc ${method}: ${JSON.stringify(j.error).slice(0, 140)}`);
  return j.result;
}

/**
 * Pure: map a bitcoind verbosity-2 block into the blockchain.info rawblock
 * shape that extractCandidatesBTC already understands
 * ({height, time(s), tx:[{hash, inputs:[{prev_out:{addr}}], out:[{addr, value_sats}]}]}).
 * Bitcoind vout values are decimal BTC → sats via round(value * 1e8), exact
 * for the 8-decimal Bitcoin precision within double range.
 */
export function normalizeRpcBtcBlock(height, blk) {
  return {
    height,
    time: blk?.time ?? null,
    tx: (blk?.tx || []).map((t) => ({
      hash: t.txid,
      inputs: [{ prev_out: { addr: t.vin?.[0]?.prevout?.scriptpubkey_address || "" } }],
      out: (t.vout || []).map((v) => ({
        addr: v.scriptPubKey?.address || "",
        value: Math.round((v.value || 0) * 1e8),
      })),
    })),
  };
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
 * (currently 5) — well within 5 req/s free-tier cap.
 */
export async function fetchERC20Logs(blockNum, env) {
  const key = await etherscanKeyParam(env);
  const fromBlock = "0x" + Number(blockNum).toString(16);
  const toBlock = fromBlock;
  const out = [];
  for (const contract of Object.keys(TOKENS_BY_CONTRACT)) {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs` +
      `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
      `&address=${contract}&topic0=${TRANSFER_TOPIC}${key}`;
    try {
      const j = await fetchJSON(url, { timeoutMs: 12000 });
      if (Array.isArray(j.result)) out.push(...j.result);
    } catch (e) {
      // degrade gracefully — skip this token for this block
      console.warn(`erc20 logs fetch failed for ${contract}:`, e.message);
    }
  }
  return out;
}

/** Refresh the market_cache key in KV from CoinGecko + alternative.me. */
export async function refreshMarketCache(env) {
  const cgid = Math.floor(Date.now() / 1000);
  const cgUrl =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true";
  const cg = await fetchJSON(cgUrl, { timeoutMs: 6000 });

  const fg = await fetchJSON("https://api.alternative.me/fng/?limit=1", { timeoutMs: 4000 });

  const cache = {
    // coingecko simple/price responds as { bitcoin: {usd, usd_24h_change}, ethereum: {...} }
    btc: {
      price: (cg && (cg.bitcoin || cg.prices?.bitcoin)?.usd) ?? null,
      change_24h: (cg && (cg.bitcoin || cg.prices?.bitcoin)?.usd_24h_change) ?? null,
    },
    eth: {
      price: (cg && (cg.ethereum || cg.prices?.ethereum)?.usd) ?? null,
      change_24h: (cg && (cg.ethereum || cg.prices?.ethereum)?.usd_24h_change) ?? null,
    },
    // stablecoins/WBTC aliases so usdValue() works for ERC20 candidates
    usdt: { price: 1, change_24h: 0 },
    usdc: { price: 1, change_24h: 0 },
    wbtc: { price: (cg && (cg.bitcoin || cg.prices?.bitcoin)?.usd) ?? null, change_24h: null },
    dai: { price: 1, change_24h: 0 },
    fear_greed: fg?.data?.[0]?.value ? parseInt(fg.data[0].value, 10) : null,
    fear_greed_label: fg?.data?.[0]?.value_classification ?? null,
    updated_at: Date.now(), // ms
  };
  await env.KV.put("market_cache", JSON.stringify(cache));
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
  // token from env secret first, then KV `key:news` (admin /setkey writable)
  let token = env.NEWS_TOKEN;
  if (!token) {
    try { token = await env.KV.get("key:news"); } catch { /* treat as missing */ }
  }
  const auth = token ? `&auth_token=${token}` : "";
  // filter=hot returns the most-tweeted headlines — broader signal than
  // kind=news alone, and free-tier-permitted.
  const url = `https://cryptopanic.com/api/v1/posts/?kind=news&filter=hot${auth}`;
  const j = await fetchJSON(url, { timeoutMs: 6000 });
  const headlines = filterNewsKeywords(j?.results ?? []);
  const cache = { headlines, updated_at: Date.now() };
  await env.KV.put("news_cache", JSON.stringify(cache));
  return cache;
}

// ─── scan one chain (with batched catch-up) ──────────────────────────

export async function scanChain(env, chain, market) {
  const state = await getState(env, chain);
  const maxBlocks = parseInt((await env.KV.get("config:max_blocks")) ?? env.MAX_BLOCKS ?? DEFAULT_MAX_BLOCKS, 10);
  // first run: prime from latest (no processing this tick, just record where we are)
  const latest = await fetchLatestBlockHeight(env, chain);
  if (state.last_block == null) {
    console.log(`[scanner:${chain}] first run — priming last_block=${latest}`);
    await persistState(env, chain, latest);
    return { chain, processed: 0, newWhales: 0, primed: true };
  }
  if (latest <= state.last_block) {
    return { chain, processed: 0, newWhales: 0, primed: false };
  }

  const walletMap = await loadWalletMap(env);

  let cursor = state.last_block + 1;
  let lastProcessed = state.last_block;
  let processed = 0;
  let newlyCounted = 0;
  // config read hoisted out of the block loop — every KV op is a subrequest
  // against the free-plan 50-per-invocation cap.
  const minUsd = parseInt((await env.KV.get("config:min_usd")) ?? env.MIN_USD ?? DEFAULT_MIN_USD, 10);
  while (cursor <= latest && processed < maxBlocks) {
    try {
      const block = await fetchBlock(chain, cursor, env);
      const candidates =
        chain === "btc"
          ? extractCandidatesBTC(block, market)
          : extractCandidatesETH(block, market);

      // for ETH, also pull ERC20 Transfer logs (extra RPC, bounded by 1 block)
      let erc20 = [];
      if (chain === "eth") {
        const logs = await fetchERC20Logs(cursor, env);
        erc20 = extractERC20Candidates(logs, market).map((c) => ({
          ...c,
          block_time: parseInt(block?.timestamp, 16) * 1000 || null,
        }));
      }

      const all = [...candidates, ...erc20];
      const whales = classifyWhales(filterWhales(all, minUsd), walletMap);

      if (whales.length > 0) {
        // ── batched write path ──────────────────────────────────────────
        // A single busy block can hold 40+ qualifying transfers. The old
        // per-whale chain (dup-context read + INSERT + id SELECT + wallet
        // stats UPDATE + auto-labels, each a separate subrequest) blew the
        // free-plan 50-subrequests-per-invocation cap and silently killed
        // the tick mid-block. Now: ONE read for every wallet's spam context,
        // ONE batched write for all inserts/stats/labels, then ONE id lookup
        // for the few analyze-worthy rows.
        const addrs = [...new Set(whales.map((w) => String(w.from_address).toLowerCase()))];
        const recentMap = await recentWhalesForAddresses(env, addrs, chain);

        const stmts = [];
        const insertIdxs = [];
        const queueHashes = [];
        for (const w of whales) {
          const lcFrom = String(w.from_address).toLowerCase();
          const walletInfo = walletMap.get(lcFrom) ?? null;
          const prepared = prepareWhaleWrite(env, w, walletMap, walletInfo, recentMap.get(lcFrom) || [], market);
          insertIdxs.push(stmts.length);
          stmts.push(prepared.insertStmt);
          for (const s of prepared.extraStmts) stmts.push(s);
          if (prepared.shouldAnalyze) queueHashes.push(w.tx_hash);
        }

        const results = await env.DB.batch(stmts);
        for (const idx of insertIdxs) {
          if (results[idx]?.meta?.changes > 0) newlyCounted++;
        }

        // Queue only for interesting whales — saves 50-90% of Gemini calls.
        if (queueHashes.length > 0) {
          const ph = queueHashes.map(() => "?").join(",");
          const { results: idRows } = await env.DB.prepare(
            `SELECT id, tx_hash FROM whales WHERE tx_hash IN (${ph})`
          ).bind(...queueHashes).all();
          const idByHash = new Map((idRows || []).map((r) => [r.tx_hash, r.id]));
          for (const hash of queueHashes) {
            const id = idByHash.get(hash);
            if (id) await env.ANALYSTQ.send(JSON.stringify({ whale_id: id, chain }));
          }
        }
      }

      lastProcessed = cursor;
    } catch (e) {
      // one bad block (API hiccup, malformed body) must not sink the batch;
      // skip it — a whale in that block is lost, the state is not.
      console.error(`[scanner:${chain}] block ${cursor} failed:`, e.message);
    }
    // persist after every block: if the CPU cap kills the invocation
    // mid-catch-up, everything before this line is already safe.
    await persistState(env, chain, lastProcessed);
    processed++;
    cursor++;
  }

  return { chain, processed, newWhales: newlyCounted, primed: false };
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
    // Emergency valve: upstream outages (CoinGecko 429 / CryptoPanic 403) eat
    // the free-plan 50-subrequest-per-invocation budget before any block gets
    // scanned. config:skip_cache_refresh = "1" bypasses both cache refreshes
    // so ticks stay lean until the operator clears the flag.
    let skipCacheRefresh = false;
    try { skipCacheRefresh = (await env.KV.get("config:skip_cache_refresh")) === "1"; } catch {}
    try {
      const raw = await env.KV.get("market_cache");
      market = raw ? JSON.parse(raw) : null;
      if (market && market.updated_at) {
        const ageS = (Date.now() - market.updated_at) / 1000;
        needMarketRefresh = ageS > MARKET_CACHE_TTL_S;
      }
    } catch { /* ignore — will be null/refresh */ }

    if (needMarketRefresh && !skipCacheRefresh) {
      try {
        market = await refreshMarketCache(env);
      } catch (e) {
        console.warn("market cache refresh failed:", e.message);
        // continue with possibly-stale or null market
      }
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
      if (needNewsRefresh && !skipCacheRefresh) {
        try { await refreshNewsCache(env); }
        catch (e) { console.warn("news cache refresh failed:", e.message); }
      }
    } catch { /* never break the scan over news cache */ }

    const results = [];
    // kill switches (admin panel writes config:paused) — checked per chain
    let paused = {};
    try { paused = JSON.parse(await env.KV.get("config:paused") || "{}"); } catch {}
    for (const chain of ["eth", "btc"]) {
      if (paused.global || paused[chain]) {
        console.log(`[scanner:${chain}] paused via admin — skipping tick`);
        results.push({ chain, skipped: "paused" });
        continue;
      }
      try {
        results.push(await scanChain(env, chain, market));
      } catch (e) {
        console.error(`[scanner:${chain}] scan failed:`, e.message);
        await bumpErrors(env, chain);
        results.push({ chain, error: e.message });
      }
    }
    console.log("[scanner] tick done:", JSON.stringify(results));
    return results;
  },
};
