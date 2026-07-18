#!/usr/bin/env node
// tools/live_scan_btc.mjs — live BTC scanner path, end to end.
//
// Drives the REAL scanner.js functions against live mainnet:
//   refreshMarketCache()          -> real coingecko + alternative.me
//   fetchLatestBlockHeight(btc)   -> real blockchain.info/latestblock
//   fetchBlock(btc, N)             -> real blockchain.info/rawblock/N
//   extractCandidatesBTC()         -> pure scanner logic
//   filterWhales(MIN_USD)          -> pure scanner logic
//   classifyWhales(walletMap)      -> pure scanner logic
//
// Routes all fetch() through 127.0.0.1:10808 SOCKS5 by overriding global.fetch
// before importing the scanner. In prod, Cloudflare Workers route direct — the
// proxy is a dev-machine concern only.
//
// Run:  node tools/live_scan_btc.mjs [MIN_USD]
//   MIN_USD defaults to 500_000 (matches DEFAULT_MIN_USD)

import { SocksProxyAgent } from "socks-proxy-agent";

const PROXY = process.env.SOCKS_URL || "socks5://127.0.0.1:10808";
const agent = new SocksProxyAgent(PROXY);
const UA = "whalesignal-liveprobe/0.1";

// ponytail: global fetch override with a SOCKS-dispatching agent. The deployed
// Worker ignores this code entirely; this is local-dev only. Single global hook
// rather than a wrapper factory because scanner.js already calls bare `fetch`
// inside worker-utils.fetchJSON — patching the global is the only thing that
// hits it without rewriting the production code.
const _origFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => _origFetch(url, { ...opts, agent, headers: { "User-Agent": UA, ...(opts.headers || {}) } });

// import AFTER the fetch override so scanner.js / worker-utils.js inherit it
// ponytail: dynamic import after global mutation — order-dependent but simple
const scanner = await import("../src/scanner.js");
const { buildWalletMap, classifyTx } = await import("../src/worker-utils.js");
import { readFileSync } from "node:fs";

// ── stub env so scanner's runtime functions can run outside a Worker ────────
const KV = {
  _store: new Map(),
  async get(k) { return this._store.get(k) ?? null; },
  async put(k, v) { this._store.set(k, v); },
};
const env = {
  KV,
  ETHSCAN_KEY: "",  // irrelevant for btc path
  BSCSCAN_KEY: "",
  MIN_USD: String(process.argv[2] ?? 500_000),
  MAX_BLOCKS: "1",
};

// empty walletMap for classifyWhales — all txs classify as wallet_to_wallet,
// which is exactly what we want for a "what's out there" probe (no known
// exchange labels yet). Use the bundled wallet_labels json if present.
let walletRows = [];
try {
  const dir = "./wallet_labels";
  const files = [];
  // ponytail: readdirents + try — no glob dep
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json")) files.push(dir + "/" + f);
  }
  for (const f of files) {
    const rows = JSON.parse(readFileSync(f, "utf8"));
    // wallet_labels/exchanges.json shape: { btc: [...], eth: [...] } keyed by chain
    // ponytail: accept both this shape and a flat array — no schema dep in a probe
    if (Array.isArray(rows)) walletRows = walletRows.concat(rows);
    else for (const v of Object.values(rows)) if (Array.isArray(v)) walletRows = walletRows.concat(v);
  }
  console.log(`loaded ${walletRows.length} wallet labels from ${files.length} file(s)`);
} catch (e) {
  console.log(`no wallet_labels/*.json (${e.message}); classifyWhales will all be wallet_to_wallet`);
}
const walletMap = buildWalletMap(walletRows);

// ── step 1: market cache ───────────────────────────────────────────────────
console.log("\n[1] refreshMarketCache() — coingecko + alternative.me (live)");
const t1 = Date.now();
const market = await scanner.refreshMarketCache(env);
console.log(`  ${Date.now() - t1}ms`);
console.log(`  BTC: $${market.btc.price} (${market.btc.change_24h?.toFixed(2)}% 24h)`);
console.log(`  ETH: $${market.eth.price} (${market.eth.change_24h?.toFixed(2)}% 24h)`);
console.log(`  Fear/Greed: ${market.fear_greed} (${market.fear_greed_label})`);
if (!market.btc.price || !market.eth.price) { console.error("FAIL: market cache missing prices"); process.exit(1); }

// ── step 2: latest block ────────────────────────────────────────────────────
console.log("\n[2] fetchLatestBlockHeight(btc) — blockchain.info (live)");
const t2 = Date.now();
const height = await scanner.fetchLatestBlockHeight(env, "btc");
console.log(`  ${Date.now() - t2}ms  height=${height}`);
if (!height) { console.error("FAIL: no height"); process.exit(1); }

// ── step 3: fetchBlock ──────────────────────────────────────────────────────
console.log(`\n[3] fetchBlock(btc, ${height}) — blockchain.info/rawblock (live)`);
const t3 = Date.now();
const block = await scanner.fetchBlock("btc", height, env);
console.log(`  ${Date.now() - t3}ms  n_tx=${block.n_tx} size=${block.size} time=${block.time}`);
if (!block || !Array.isArray(block.tx)) { console.error("FAIL: block.tx missing"); process.exit(1); }

// ── step 4: candidates ──────────────────────────────────────────────────────
console.log("\n[4] extractCandidatesBTC(block, market) — pure scanner logic");
const t4 = Date.now();
const all = scanner.extractCandidatesBTC(block, market);
console.log(`  ${Date.now() - t4}ms  candidates=${all.length}`);
if (all.length === 0) { console.error("WARN: 0 candidates — block may be empty"); }

// ── step 5: filter + classify ───────────────────────────────────────────────
const minUsd = parseInt(env.MIN_USD, 10);
console.log(`\n[5] filterWhales(>= $${minUsd}) + classifyWhales()`);
const t5 = Date.now();
const whales = scanner.classifyWhales(scanner.filterWhales(all, minUsd), walletMap);
console.log(`  ${Date.now() - t5}ms  whales=${whales.length}`);

// ── report ─────────────────────────────────────────────────────────────────
console.log(`\n=== whales in block ${height} (n_tx=${block.n_tx}) ===`);
if (whales.length === 0) {
  console.log("(none above threshold — same block on mainnet can easily have no >$500K move)");
  // ponytail: also print top 5 by USD so the probe is informative even with 0
  // whales — confirms the pipeline sorted and priced real txs, not just nothing
  const sorted = [...all].sort((a, b) => b.usd_value - a.usd_value).slice(0, 5);
  console.log(`\ntop 5 biggest txs in the block (below threshold, for sanity):`);
  for (const w of sorted) {
    console.log(`  ${w.usd_value >= 1e6 ? "$" + (w.usd_value / 1e6).toFixed(2) + "M" : "$" + Math.round(w.usd_value / 1e3) + "K"}  ${w.amount.toFixed(4)} BTC  ${w.tx_hash.slice(0, 16)}…  -> ${w.to_address || "?"}`);
  }
} else {
  console.log(`(showing all ${whales.length})`);
  for (const w of whales) {
    const usd = w.usd_value >= 1e6 ? "$" + (w.usd_value / 1e6).toFixed(2) + "M" : "$" + Math.round(w.usd_value / 1e3) + "K";
    console.log(`  ${usd}  ${w.amount.toFixed(8)} BTC  ${w.tx_type}`);
    console.log(`    from ${w.from_address || "(coinbase)"}`);
    console.log(`    to   ${w.to_address}`);
    console.log(`    txid ${w.tx_hash}`);
  }
}

console.log(`\n=== all 5 scanner functions ran live, end to end ===`);
