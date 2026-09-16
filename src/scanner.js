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

import { fetchJSON, fetchText, classifyTx, usdValue, buildWalletMap, labelFor, ZERO_ADDRESS, isBurnSink } from "./worker-utils.js";

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
 *
 * BTC semantics: a "whale tx" is ONE large transfer, so we take the LARGEST
 * single output (its address + value) as the whale move. Summing all outputs
 * mislabeled exchange consolidations/sweeps (dozens of outputs, $X00M total)
 * as single whale transfers and attributed the total to the first output's
 * address — the main reason the feed read ~6K events/day while the real
 * $500K+ single transfers are far fewer. Change outputs (address belongs to
 * an input) are skipped so self-transfers don't masquerade as destinations.
 */
export function extractCandidatesBTC(block, market) {
  const out = [];
  if (!block || !Array.isArray(block.tx)) return out;
  const bn = typeof block.height === "number" ? block.height : null;
  const bt = block.time ? block.time * 1000 : null; // blockchain.info gives unix s
  for (const tx of block.tx) {
    const outs = Array.isArray(tx.out) ? tx.out : [];
    const inputAddrs = new Set(
      (Array.isArray(tx.inputs) ? tx.inputs : [])
        .map((i) => i?.prev_out?.addr)
        .filter(Boolean)
    );
    const firstIn = Array.isArray(tx.inputs) && tx.inputs[0]?.prev_out?.addr ? tx.inputs[0].prev_out.addr : "";
    if (!tx.hash) continue;
    // largest output whose address is not one of the senders (change back to
    // self is routing, not a destination). Ties keep the earlier output.
    let best = null;
    for (const o of outs) {
      if (!o || !o.addr || !Number.isFinite(o.value) || o.value <= 0) continue;
      if (inputAddrs.has(o.addr)) continue;
      if (!best || o.value > best.value) best = o;
    }
    if (!best) continue;
    // blockchain.info amounts are in satoshis; BTC decimal 8
    const amountBtc = best.value / 1e8;
    out.push({
      chain: "btc",
      tx_hash: tx.hash,
      from_address: firstIn,
      to_address: best.addr,
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

// ─── cap-guard pause helpers (pure, tested) ──────────────────────────

/**
 * The D1 read-cap guard writes config:auto_paused — a SEPARATE key from the
 * admin's config:paused, so the two never clobber each other and expiry is
 * unambiguous (a guard pause is exactly {until, reason}; an admin pause has
 * no `until`).
 * Returns {active, expired} — expired=true means the caller should delete
 * the key and resume.
 */
export function autoPauseState(autoPaused, now) {
  if (!autoPaused || !autoPaused.until) return { active: false, expired: false };
  return { active: now < autoPaused.until, expired: now >= autoPaused.until };
}

// ─── rollup accumulator (free-forever: writes instead of scans) ──────
//
// While inserting whales, the scan loop folds each row into in-memory
// buckets; once per tick flushRollups() writes a handful of UPSERTs via
// DB.batch. Dashboards then read these small tables instead of scanning
// the (ever-growing) whales table — the D1 read budget becomes
// traffic-sized, not data-sized.

export function newRollupAcc(hourBucket) {
  return {
    hour: hourBucket,
    totals: { whales: 0, volume: 0 },
    hours: new Map(),   // chain → {events, volume_usd, inflow_usd, outflow_usd, inflow_count, outflow_count}
    edges: new Map(),   // chain|from|to → {volume_usd, cnt, inflow_cnt, outflow_cnt}
    exflow: new Map(),  // chain|exchange → {inflow_usd, outflow_usd, inflow_count, outflow_count}
    symbols: new Map(), // symbol → {count, volume}
  };
}

/** Fold one inserted whale into the accumulator. Pure. */
export function accWhale(acc, w, exchangeLabel = null) {
  const chain = w.chain || "?";
  const sym = (w.symbol || "?").toUpperCase();
  const usd = Number(w.usd_value) || 0;

  acc.totals.whales += 1;
  acc.totals.volume += usd;
  acc.totals.tick_max_usd = Math.max(acc.totals.tick_max_usd || 0, usd);

  const h = acc.hours.get(chain) || { events: 0, volume_usd: 0, inflow_usd: 0, outflow_usd: 0, inflow_count: 0, outflow_count: 0 };
  h.events += 1; h.volume_usd += usd;
  acc.hours.set(chain, h);

  const s = acc.symbols.get(sym) || { count: 0, volume: 0 };
  s.count += 1; s.volume += usd;
  acc.symbols.set(sym, s);

  if (w.from_address && w.to_address && w.from_address !== w.to_address) {
    const ek = `${chain}|${w.from_address}|${w.to_address}`;
    const e = acc.edges.get(ek) || { chain, from_address: w.from_address, to_address: w.to_address, volume_usd: 0, cnt: 0, inflow_cnt: 0, outflow_cnt: 0 };
    e.volume_usd += usd; e.cnt += 1;
    if (w.tx_type === "exchange_inflow") e.inflow_cnt += 1;
    if (w.tx_type === "exchange_outflow") e.outflow_cnt += 1;
    acc.edges.set(ek, e);
  }

  if (w.tx_type === "exchange_inflow" || w.tx_type === "exchange_outflow") {
    const isIn = w.tx_type === "exchange_inflow";
    const addr = isIn ? w.to_address : w.from_address;
    const label = exchangeLabel || shortLabel(addr);
    const xk = `${chain}|${label}`;
    const x = acc.exflow.get(xk) || { chain, exchange: label, inflow_usd: 0, outflow_usd: 0, inflow_count: 0, outflow_count: 0 };
    if (isIn) { x.inflow_usd += usd; x.inflow_count += 1; }
    else { x.outflow_usd += usd; x.outflow_count += 1; }
    acc.exflow.set(xk, x);
    if (isIn) { h.inflow_usd += usd; h.inflow_count += 1; }
    else { h.outflow_usd += usd; h.outflow_count += 1; }
  }
  return acc;
}

/** Fallback display name when a flow touches no labeled exchange wallet. */
function shortLabel(addr) {
  const a = String(addr || "");
  return a.length > 12 ? a.slice(0, 12) + "…" : a || "(unknown)";
}

/** Build the batch of UPSERT statements for one tick. Array of {sql, binds}. */
export function rollupStatements(acc) {
  const stmts = [];
  stmts.push({
    sql: `INSERT INTO counters (k, v) VALUES ('total_whales', ?), ('total_volume', ?)
          ON CONFLICT(k) DO UPDATE SET v = v + excluded.v`,
    binds: [acc.totals.whales, acc.totals.volume],
  });
  stmts.push({
    sql: `INSERT INTO counters (k, v) VALUES ('largest_transfer', ?)
          ON CONFLICT(k) DO UPDATE SET v = MAX(v, excluded.v)`,
    binds: [acc.totals.tick_max_usd ?? 0],
  });
  for (const [chain, h] of acc.hours) {
    stmts.push({
      sql: `INSERT INTO hourly_stats (hour_bucket, chain, events, volume_usd, inflow_usd, outflow_usd, inflow_count, outflow_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hour_bucket, chain) DO UPDATE SET
              events = events + excluded.events, volume_usd = volume_usd + excluded.volume_usd,
              inflow_usd = inflow_usd + excluded.inflow_usd, outflow_usd = outflow_usd + excluded.outflow_usd,
              inflow_count = inflow_count + excluded.inflow_count, outflow_count = outflow_count + excluded.outflow_count`,
      binds: [acc.hour, chain, h.events, h.volume_usd, h.inflow_usd, h.outflow_usd, h.inflow_count, h.outflow_count],
    });
  }
  for (const [, x] of acc.exflow) {
    stmts.push({
      sql: `INSERT INTO exchange_netflow_hourly (hour_bucket, exchange, chain, inflow_usd, outflow_usd, inflow_count, outflow_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hour_bucket, exchange, chain) DO UPDATE SET
              inflow_usd = inflow_usd + excluded.inflow_usd, outflow_usd = outflow_usd + excluded.outflow_usd,
              inflow_count = inflow_count + excluded.inflow_count, outflow_count = outflow_count + excluded.outflow_count`,
      binds: [acc.hour, x.exchange, x.chain, x.inflow_usd, x.outflow_usd, x.inflow_count, x.outflow_count],
    });
  }
  for (const [, e] of acc.edges) {
    stmts.push({
      sql: `INSERT INTO flow_edges_hourly (hour_bucket, chain, from_address, to_address, volume_usd, cnt, inflow_cnt, outflow_cnt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hour_bucket, chain, from_address, to_address) DO UPDATE SET
              volume_usd = volume_usd + excluded.volume_usd, cnt = cnt + excluded.cnt,
              inflow_cnt = inflow_cnt + excluded.inflow_cnt, outflow_cnt = outflow_cnt + excluded.outflow_cnt`,
      binds: [acc.hour, e.chain, e.from_address, e.to_address, e.volume_usd, e.cnt, e.inflow_cnt, e.outflow_cnt],
    });
  }
  for (const [sym, s] of acc.symbols) {
    stmts.push({
      sql: `INSERT INTO counters (k, v) VALUES (?, ?)
            ON CONFLICT(k) DO UPDATE SET v = v + excluded.v`,
      binds: [`symbol:${sym}:count`, s.count],
    });
    stmts.push({
      sql: `INSERT INTO counters (k, v) VALUES (?, ?)
            ON CONFLICT(k) DO UPDATE SET v = v + excluded.v`,
      binds: [`symbol:${sym}:volume`, s.volume],
    });
  }
  return stmts;
}

/**
 * Write the tick's rollups. D1 batch = one round trip; on failure the raw
 * whales rows are already safe (inserted first) and rollups only drift by
 * this tick — acceptable for aggregates, never retried to avoid doubles.
 */
async function flushRollups(env, acc) {
  const stmts = rollupStatements(acc);
  if (!stmts.length) return;
  try {
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.binds)));
  } catch (e) {
    console.warn(`[scanner] rollup flush failed (aggregates drift by one tick): ${e.message}`);
  }
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

// Exchange-internal transfers below this floor are never stored: hot↔cold
// routing between an exchange's own wallets is the bulk of $500K+ BTC
// traffic and is pure plumbing (always neutral, never a whale story).
// Storing it burned D1 write budget and drowned the real whales in /stats.
// Only LARGE internal moves (default $5M) are kept — those are deliberate
// treasury operations worth a row. Tunable via config:internal_floor (KV).
export const DEFAULT_INTERNAL_FLOOR = 5_000_000;

/**
 * Drop exchange-internal plumbing below the floor. Pure, exported for tests.
 * Everything else passes through untouched.
 */
export function dropPlumbing(whales, floor = DEFAULT_INTERNAL_FLOOR) {
  const f = Number(floor) || 0;
  return (whales || []).filter(
    (w) => w.tx_type !== "exchange_internal" || (Number(w.usd_value) || 0) >= f
  );
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
  ).run();
  if (ins.meta.changes === 0) return false; // dup

  const row = await env.DB.prepare(
    "SELECT id FROM whales WHERE tx_hash = ?"
  ).bind(wh.tx_hash).first();
  if (!row?.id) return false;

  // Queue only for interesting whales — saves 50-90% of Gemini calls.
  if (shouldAnalyze) {
    await env.ANALYSTQ.send(JSON.stringify({ whale_id: row.id, chain: wh.chain }));
  }

  // Bump wallet stats for non-exchange addresses.
  const fromType = walletMap?.get(String(wh.from_address).toLowerCase())?.type || null;
  const toType = walletMap?.get(String(wh.to_address).toLowerCase())?.type || null;
  const targets = statTargets(wh.from_address, wh.to_address, fromType, toType);
  if (targets.length > 0) {
    await env.DB.prepare(
      "UPDATE wallets SET last_seen = ?, last_tx_hash = ?, " +
      "tx_count = tx_count + 1, total_volume = total_volume + ? " +
      "WHERE address IN (" + targets.map(() => "?").join(",") + ") AND chain = ?"
    ).bind(Date.now(), wh.tx_hash, wh.usd_value, ...targets, wh.chain).run();

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
    const info = walletMap?.get(key) ?? walletInfo;
    if (!info) continue;

    const txCount = (info.tx_count ?? 0) + 1; // +1 for the one we just inserted
    const updates = [];
    const bindArgs = [];

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
      bindArgs.push(chain);
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
      const blk = await btcRpc("getblock", [hash, 2]);
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

/** One JSON-RPC call to PublicNode's public bitcoin node. Throws on rpc error. */
async function btcRpc(method, params) {
  const j = await fetchJSON("https://bitcoin-rpc.publicnode.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    timeoutMs: 9000,
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

/**
 * Pure: assemble the market_cache object from whatever sources answered.
 * Returns null when NO price source produced a BTC/ETH price — the caller
 * then skips the KV write so a good stale cache is never clobbered with
 * nulls (null prices → usdValue NaN → whale detection silently stops).
 */
export function buildMarketCache({ cg = null, btcSpot = null, ethSpot = null, fg = null } = {}) {
  const cgBtc = (cg && ((cg.bitcoin || cg.prices?.bitcoin)?.usd)) ?? null;
  const cgEth = (cg && ((cg.ethereum || cg.prices?.ethereum)?.usd)) ?? null;
  const btc = cgBtc ?? btcSpot;
  const eth = cgEth ?? ethSpot;
  if (btc == null && eth == null) return null;
  return {
    btc: { price: btc, change_24h: (cg?.bitcoin || cg?.prices?.bitcoin)?.usd_24h_change ?? null },
    eth: { price: eth, change_24h: (cg?.ethereum || cg?.prices?.ethereum)?.usd_24h_change ?? null },
    // stablecoins/WBTC aliases so usdValue() works for ERC20 candidates
    usdt: { price: 1, change_24h: 0 },
    usdc: { price: 1, change_24h: 0 },
    wbtc: { price: btc, change_24h: null },
    dai: { price: 1, change_24h: 0 },
    fear_greed: fg?.data?.[0]?.value ? parseInt(fg.data[0].value, 10) : null,
    fear_greed_label: fg?.data?.[0]?.value_classification ?? null,
    updated_at: Date.now(), // ms
  };
}

/** Coinbase spot price — keyless fallback when CoinGecko rate-limits us. */
async function coinbaseSpot(pair) {
  try {
    const j = await fetchJSON(`https://api.coinbase.com/v2/prices/${pair}/spot`, { timeoutMs: 6000 });
    const n = parseFloat(j?.data?.amount);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Refresh the market_cache key in KV. CoinGecko primary, Coinbase fallback. */
export async function refreshMarketCache(env) {
  const cgid = Math.floor(Date.now() / 1000);
  const cgUrl =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true";
  let cg = null;
  try {
    cg = await fetchJSON(cgUrl, { timeoutMs: 6000 });
  } catch (e) {
    console.warn("coingecko price fetch failed, trying coinbase:", e.message);
  }
  const btcSpot = cg?.bitcoin?.usd == null ? await coinbaseSpot("BTC-USD") : null;
  const ethSpot = cg?.ethereum?.usd == null ? await coinbaseSpot("ETH-USD") : null;

  let fg = null;
  try {
    fg = await fetchJSON("https://api.alternative.me/fng/?limit=1", { timeoutMs: 4000 });
  } catch (e) {
    console.warn("fear&greed fetch failed (kept from previous cache):", e.message);
  }

  const cache = buildMarketCache({ cg, btcSpot, ethSpot, fg });
  if (!cache) {
    // both sources failed — keep the previous cache rather than writing nulls
    throw new Error("no price source available; keeping previous market_cache");
  }
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
 * Pure: pull <item>/<entry> titles out of an RSS/Atom feed body. Handles
 * CDATA and the common HTML entities. Keyless and free — this is the
 * fallback (and default) news source since CryptoPanic now 403s without
 * a paid-ish token.
 */
export function extractRssTitles(xml) {
  const titles = [];
  const itemRe = /<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi;
  const titleRe = /<title[^>]*>([\s\S]*?)<\/title>/i;
  let m;
  while ((m = itemRe.exec(String(xml || "")))) {
    const t = titleRe.exec(m[0]);
    if (!t) continue;
    let s = t[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
    if (s) titles.push(s);
  }
  return titles;
}

// Keyless public RSS feeds — one fetch each per refresh, well within the
// 50-subrequest-per-invocation budget.
const NEWS_RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
];

/**
 * Refresh the news_cache key in KV. Order: CryptoPanic (only if a token is
 * configured — it 403s without one), then keyless RSS feeds. Stores
 * {headlines:Array<{title}>, updated_at:ms, source} so the analyst and the
 * alert formatter can show WHY a whale might have moved.
 */
export async function refreshNewsCache(env) {
  let token = env.NEWS_TOKEN;
  if (!token) {
    try { token = await env.KV.get("key:news"); } catch { /* treat as missing */ }
  }
  let headlines = [];
  let source = "none";

  if (token) {
    try {
      const url = `https://cryptopanic.com/api/v1/posts/?kind=news&filter=hot&auth_token=${token}`;
      const j = await fetchJSON(url, { timeoutMs: 6000 });
      headlines = filterNewsKeywords(j?.results ?? []);
      if (headlines.length) source = "cryptopanic";
    } catch (e) {
      console.warn("cryptopanic fetch failed:", e.message);
    }
  }

  if (!headlines.length) {
    for (const feed of NEWS_RSS_FEEDS) {
      try {
        const xml = await fetchText(feed, { timeoutMs: 8000, maxBytes: 400_000 });
        const titles = extractRssTitles(xml).map((t) => ({ title: t }));
        headlines = filterNewsKeywords(titles);
        if (headlines.length) { source = new URL(feed).hostname; break; }
      } catch (e) {
        console.warn(`rss news fetch failed for ${feed}:`, e.message);
      }
    }
  }

  const cache = { headlines, updated_at: Date.now(), source };
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
  const acc = newRollupAcc(Math.floor(Date.now() / 3600000) * 3600000);

  let cursor = state.last_block + 1;
  let lastProcessed = state.last_block;
  let processed = 0;
  let newlyCounted = 0;
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
      let whales = classifyWhales(
        filterWhales(all, parseInt((await env.KV.get("config:min_usd")) ?? env.MIN_USD ?? DEFAULT_MIN_USD, 10)),
        walletMap
      );
      // plumbing valve: exchange-internal routing under the floor never
      // becomes a row (floor tunable via config:internal_floor, 0 disables)
      const internalFloor = parseInt((await env.KV.get("config:internal_floor")) ?? DEFAULT_INTERNAL_FLOOR, 10);
      whales = dropPlumbing(whales, internalFloor);

      for (const w of whales) {
        try {
          const fromKey = String(w.from_address).toLowerCase();
          const walletInfo = walletMap.get(fromKey) ?? null;
          const recentSameWallet = await recentWhalesFromWallet(env, w.from_address, w.chain);
          const inserted = await insertWhaleAndQueue(env, w, walletMap, walletInfo, recentSameWallet, market);
          if (inserted) {
            newlyCounted++;
            // fold into the tick's rollups; the exchange side carries its label
            const flowAddr = w.tx_type === "exchange_inflow" ? w.to_address : w.from_address;
            const info = flowAddr
              ? (walletMap.get(flowAddr) ?? walletMap.get(String(flowAddr).toLowerCase()))
              : null;
            accWhale(acc, w, info?.label || null);
          }
        } catch (e) {
          console.warn(`[scanner:${chain}] insert failed for ${w.tx_hash}:`, e.message);
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

  // one batch of UPSERTs per tick — dashboards read these instead of raw scans
  await flushRollups(env, acc);
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
    // kill switches (admin panel writes config:paused) — checked per chain.
    // The D1 read-cap guard writes config:auto_paused (separate key — the two
    // never clobber each other); it expires itself once `until` has passed.
    let paused = {};
    try { paused = JSON.parse(await env.KV.get("config:paused") || "{}"); } catch {}
    // legacy self-heal: the first cap-guard prototype wrote its {until,
    // reason} into config:paused — if that `until` has passed, clear the
    // key (admin manual pauses carry no until, so they're untouched)
    if (paused.until && paused.reason === "d1_read_cap" && Date.now() >= paused.until) {
      try { await env.KV.delete("config:paused"); } catch { /* next tick */ }
      console.log("[scanner] legacy cap pause expired — resuming");
      paused = {};
    }
    let autoPaused = null;
    try { autoPaused = JSON.parse(await env.KV.get("config:auto_paused") || "null"); } catch {}
    const guard = autoPauseState(autoPaused, Date.now());
    if (guard.expired) {
      try { await env.KV.delete("config:auto_paused"); } catch { /* next tick retries */ }
      console.log("[scanner] cap auto-pause expired — resuming");
    }
    const globallyPaused = paused.global === true || guard.active;
    for (const chain of ["eth", "btc"]) {
      if (globallyPaused || paused[chain]) {
        console.log(`[scanner:${chain}] paused via admin — skipping tick`);
        results.push({ chain, skipped: "paused" });
        continue;
      }
      try {
        results.push(await scanChain(env, chain, market));
      } catch (e) {
        console.error(`[scanner:${chain}] scan failed:`, e.message);
        // D1 read-cap guard: once the account trips the daily row-read cap,
        // EVERY D1 read 500s until the midnight-UTC reset. Retrying every
        // minute just burns writes and log noise. Pause the whole scanner
        // for 30 min; the tick loop clears the pause automatically once
        // `until` has passed, so no manual un-pause is ever needed.
        if (/row read limit/i.test(String(e.message))) {
          const until = Date.now() + 30 * 60_000;
          try {
            await env.KV.put("config:auto_paused", JSON.stringify({ until, reason: "d1_read_cap" }));
            console.warn(`[scanner] D1 read cap hit — auto-paused until ${new Date(until).toISOString()}`);
          } catch { /* KV hiccup — next tick retries the guard */ }
          results.push({ chain, auto_paused_until: until });
          continue;
        }
        try { await bumpErrors(env, chain); } catch { /* write may also be capped */ }
        results.push({ chain, error: e.message });
      }
    }
    console.log("[scanner] tick done:", JSON.stringify(results));
    return results;
  },
};
