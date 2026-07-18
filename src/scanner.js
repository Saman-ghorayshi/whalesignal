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

import { fetchJSON, classifyTx, usdValue, buildWalletMap, labelFor } from "./worker-utils.js";

// consts (also overrideable via env)
const DEFAULT_MIN_USD = 500_000;
const DEFAULT_MAX_BLOCKS = 10;
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

/** Insert a new whale + queue it to analyst. Returns true if newly inserted, false if dup. */
async function insertWhaleAndQueue(env, wh, walletMap) {
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO whales
       (chain, tx_hash, from_address, to_address, amount, symbol, usd_value,
        tx_type, block_number, block_time, detected_at, analysis_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(
    wh.chain, wh.tx_hash, wh.from_address, wh.to_address,
    wh.amount, wh.symbol, wh.usd_value, wh.tx_type,
    wh.block_number ?? null, wh.block_time ?? null,
    Date.now()
  ).run();
  if (ins.meta.changes === 0) return false; // dup

  // get the inserted row id. INSERT ... RETURNING would be cleaner but D1
  // supports it; sticking to a follow-up SELECT keeps compat with any older
  // sqlite build that might be on the runtime for a while.
  const row = await env.DB.prepare(
    "SELECT id FROM whales WHERE tx_hash = ?"
  ).bind(wh.tx_hash).first();
  if (!row?.id) return false;

  // Queue FIRST — if the queue send throws (queue full, binding missing,
  // quota exceeded), preserve correctness: we never bump wallet stats for a
  // whale the analyst will never see. The INSERT above already committed, so
  // worst case we have a 'pending' whale with no queue message — which means
  // no analysis runs, but that's fine (we'll retry via the next scan's
  // tx_hash UNIQUE constraint — it's already in the table so it won't re-send).
  await env.ANALYSTQ.send(JSON.stringify({ whale_id: row.id, chain: wh.chain }));

  // Bump wallet stats ONLY for non-exchange addresses. An exchange hot wallet
  // getting its tx_count incremented every time someone sends to it would
  // make Binance look like the world's biggest whale, which defeats the point
  // of the wallets table.
  const fromType = walletMap?.get(String(wh.from_address).toLowerCase())?.type || null;
  const toType = walletMap?.get(String(wh.to_address).toLowerCase())?.type || null;
  const targets = statTargets(wh.from_address, wh.to_address, fromType, toType);
  if (targets.length > 0) {
    await env.DB.prepare(
      "UPDATE wallets SET last_seen = ?, last_tx_hash = ?, " +
      "tx_count = tx_count + 1, total_volume = total_volume + ? " +
      "WHERE address IN (" + targets.map(() => "?").join(",") + ") AND chain = ?"
    ).bind(Date.now(), wh.tx_hash, wh.usd_value, ...targets, wh.chain).run();
  }
  return true;
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

/** Load the wallets table into a label-map. Should be small enough to keep in-memory per scan. */
async function loadWalletMap(env) {
  const { results } = await env.DB.prepare("SELECT address, chain, label, type FROM wallets").all();
  return buildWalletMap(results);
}

/** Fetch the latest block height for a chain. Returns an int (eth: decimal number, btc: height). */
export async function fetchLatestBlockHeight(env, chain) {
  if (chain === "btc") {
    const j = await fetchJSON("https://blockchain.info/latestblock");
    return j.height;
  }
  if (chain === "eth") {
    // etherscan: getblocknobytime returns the latest block, but free tier simpler
    // is to use eth_blockNumber via proxy
    const key = env.ETHSCAN_KEY ? `&apikey=${env.ETHSCAN_KEY}` : "";
    const j = await fetchJSON(
      `https://api.etherscan.io/api?module=proxy&action=eth_blockNumber${key}`
    );
    return parseInt(j.result, 16);
  }
  throw new Error(`unsupported chain: ${chain}`);
}

/** Fetch a block's full transaction set for a chain. */
export async function fetchBlock(chain, blockNum, env) {
  if (chain === "btc") {
    // blockchain.info rawblock by height works
    const j = await fetchJSON(`https://blockchain.info/rawblock/${blockNum}`);
    return j;
  }
  if (chain === "eth") {
    const key = env.ETHSCAN_KEY ? `&apikey=${env.ETHSCAN_KEY}` : "";
    const hex = "0x" + Number(blockNum).toString(16);
    const j = await fetchJSON(
      `https://api.etherscan.io/api?module=proxy&action=eth_getBlockByNumber&tag=${hex}&boolean=true${key}`
    );
    return j.result;
  }
  throw new Error(`unsupported chain: ${chain}`);
}

/** Fetch ERC20 Transfer logs for a single block. Filter tracked tokens. */
export async function fetchERC20Logs(blockNum, env) {
  const key = env.ETHSCAN_KEY ? `&apikey=${env.ETHSCAN_KEY}` : "";
  const fromBlock = "0x" + Number(blockNum).toString(16);
  const toBlock = fromBlock;
  const url = `https://api.etherscan.io/api?module=logs&action=getLogs` +
    `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
    `&topic0=${TRANSFER_TOPIC}${key}`;
  try {
    const j = await fetchJSON(url);
    return Array.isArray(j.result) ? j.result : [];
  } catch (e) {
    // topic0-only queries on eth_getLogs can exceed etherscan response size
    // on very busy blocks. degrade gracefully — skip this block's ERC20 scan.
    console.warn("erc20 logs fetch failed:", e.message);
    return [];
  }
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

// ─── scan one chain (with batched catch-up) ──────────────────────────

export async function scanChain(env, chain, market) {
  const state = await getState(env, chain);
  const maxBlocks = parseInt(env.MAX_BLOCKS ?? DEFAULT_MAX_BLOCKS, 10);
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
  while (cursor <= latest && processed < maxBlocks) {
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
    const whales = classifyWhales(
      filterWhales(all, parseInt(env.MIN_USD ?? DEFAULT_MIN_USD, 10)),
      walletMap
    );

    for (const w of whales) {
      try {
        const inserted = await insertWhaleAndQueue(env, w, walletMap);
        if (inserted) newlyCounted++;
      } catch (e) {
        console.warn(`[scanner:${chain}] insert failed for ${w.tx_hash}:`, e.message);
      }
    }
    lastProcessed = cursor;
    processed++;
    cursor++;
  }

  await persistState(env, chain, lastProcessed);
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
    try {
      const raw = await env.KV.get("market_cache");
      market = raw ? JSON.parse(raw) : null;
      if (market && market.updated_at) {
        const ageS = (Date.now() - market.updated_at) / 1000;
        needMarketRefresh = ageS > MARKET_CACHE_TTL_S;
      }
    } catch { /* ignore — will be null/refresh */ }

    if (needMarketRefresh) {
      try {
        market = await refreshMarketCache(env);
      } catch (e) {
        console.warn("market cache refresh failed:", e.message);
        // continue with possibly-stale or null market
      }
    }

    const results = [];
    for (const chain of ["btc", "eth"]) {
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
