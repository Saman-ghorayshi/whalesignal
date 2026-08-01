#!/usr/bin/env node
// tools/live_scan_eth.mjs — live ETH scanner path, end to end.
//
// Same shape as live_scan_btc.mjs. Drives the REAL scanner.js functions
// against live mainnet through SOCKS5 (dev only; Worker routes direct in prod).
//
// Run: ETHSCAN_KEY=... node tools/live_scan_eth.mjs [MIN_USD] [BLOCKS_BACK]
//   MIN_USD defaults to 500_000; BLOCKS_BACK defaults to 0 (latest).

import { SocksProxyAgent } from "socks-proxy-agent";
import { readFileSync } from "node:fs";

const PROXY = process.env.SOCKS_URL || "socks5://127.0.0.1:10808";
const agent = new SocksProxyAgent(PROXY);
const UA = "whalesignal-liveprobe/0.1";
const KEY = process.env.ETHSCAN_KEY;
if (!KEY) { console.error("ETHSCAN_KEY required"); process.exit(1); }

// global fetch override with SOCKS — same reason as live_scan_btc.mjs,
// only local-dev. Scanner's fetchJSON calls bare fetch, this is the only hook
// that reaches it without rewriting production code.
const _origFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => _origFetch(url, { ...opts, agent, headers: { "User-Agent": UA, ...(opts.headers || {}) } });

const scanner = await import("../src/scanner.js");
const { buildWalletMap } = await import("../src/worker-utils.js");

// ── env stub (not a Worker) ────────────────────────────────────────────────
const KV = { _s: new Map(), async get(k) { return this._s.get(k) ?? null; }, async put(k, v) { this._s.set(k, v); } };
const env = { KV, ETHSCAN_KEY: KEY, BSCSCAN_KEY: "", MIN_USD: String(process.argv[2] ?? 500_000), MAX_BLOCKS: "1" };

// wallet labels (classified as wallet_to_wallet if not found)
let walletRows = [];
try {
  const dir = "./wallet_labels";
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const rows = JSON.parse(readFileSync(dir + "/" + f, "utf8"));
    if (Array.isArray(rows)) walletRows = walletRows.concat(rows);
    else for (const v of Object.values(rows)) if (Array.isArray(v)) walletRows = walletRows.concat(v);
  }
  console.log(`loaded ${walletRows.length} wallet labels`);
} catch (e) { console.log(`no wallet_labels ({e.message})`); }
const walletMap = buildWalletMap(walletRows);

// ── 1: market ──────────────────────────────────────────────────────────────
console.log("\n[1] refreshMarketCache() — coingecko + alternative.me (live)");
const t1 = Date.now();
const market = await scanner.refreshMarketCache(env);
console.log(`  ${Date.now() - t1}ms  BTC $${market.btc.price}  ETH $${market.eth.price}  F/G ${market.fear_greed} (${market.fear_greed_label})`);
if (!market.eth.price) { console.error("FAIL: no ETH price"); process.exit(1); }

// ── 2: latest height ───────────────────────────────────────────────────────
console.log("\n[2] fetchLatestBlockHeight(eth) — etherscan V2 (live)");
const t2 = Date.now();
const latest = await scanner.fetchLatestBlockHeight(env, "eth");
console.log(`  ${Date.now() - t2}ms  height=${latest}`);
if (!latest) { console.error("FAIL: no height"); process.exit(1); }

const BLOCKS_BACK = parseInt(process.argv[3] ?? "0", 10);
const height = latest - BLOCKS_BACK;

// ── 3: fetchBlock + logs ───────────────────────────────────────────────────
console.log(`\n[3a] fetchBlock(eth, ${height}) — etherscan V2 (live)`);
const t3 = Date.now();
const block = await scanner.fetchBlock("eth", height, env);
console.log(`  ${Date.now() - t3}ms  n_tx=${block.transactions.length} time=${parseInt(block.timestamp, 16)}`);
if (!block || !Array.isArray(block.transactions)) { console.error("FAIL: txs missing"); process.exit(1); }

console.log(`[3b] fetchERC20Logs(${height}) — etherscan V2 (live)`);
const t3b = Date.now();
const logs = await scanner.fetchERC20Logs(height, env);
console.log(`  ${Date.now() - t3b}ms  logs=${logs.length}`);

// ── 4: candidates ──────────────────────────────────────────────────────────
console.log("\n[4] extractCandidatesETH + extractERC20Candidates — pure scanner logic");
const t4 = Date.now();
const native = scanner.extractCandidatesETH(block, market);
const erc20 = scanner.extractERC20Candidates(logs, market).map((c) => ({
  ...c,
  block_time: parseInt(block.timestamp, 16) * 1000 || null,
}));
const all = [...native, ...erc20];
const bySym = {};
for (const c of all) bySym[c.symbol] = (bySym[c.symbol] || 0) + 1;
console.log(`  ${Date.now() - t4}ms  native=${native.length} erc20=${erc20.length} total=${all.length} by_symbol=${JSON.stringify(bySym)}`);
if (all.length === 0) { console.error("WARN: 0 candidates — block empty?"); }

// ── 5: filter + classify ───────────────────────────────────────────────────
const minUsd = parseInt(env.MIN_USD, 10);
console.log(`\n[5] filterWhales(>= $${minUsd}) + classifyWhales()`);
const t5 = Date.now();
const whales = scanner.classifyWhales(scanner.filterWhales(all, minUsd), walletMap);
console.log(`  ${Date.now() - t5}ms  whales=${whales.length}`);

// ── report ─────────────────────────────────────────────────────────────────
const btcUsd = (n) => n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K" : "$" + n.toFixed(0);
console.log(`\n=== whales in ETH block ${height} (n_tx=${block.transactions.length}, n_logs=${logs.length}) ===`);
if (whales.length === 0) {
  console.log("(none above threshold — ETH blocks can easily have no tracked-token whales in a given block)");
  const sorted = [...all].filter(c => Number.isFinite(c.usd_value)).sort((a, b) => b.usd_value - a.usd_value).slice(0, 5);
  console.log(`\ntop 5 biggest txs in the block (below threshold, for sanity):`);
  for (const w of sorted) console.log(`  ${btcUsd(w.usd_value)}  ${w.amount.toFixed(4)} ${w.symbol}  ${w.tx_hash.slice(0, 16)}…  -> ${w.to_address || "?"}`);
} else {
  console.log(`(showing all ${whales.length})`);
  for (const w of whales) {
    console.log(`  ${btcUsd(w.usd_value)}  ${w.amount.toFixed(6)} ${w.symbol}  ${w.tx_type}`);
    console.log(`    from ${w.from_address || "(coinbase)"}`);
    console.log(`    to   ${w.to_address}`);
    console.log(`    txid ${w.tx_hash}`);
    if (w._contract) console.log(`    contract ${w._contract}`);
  }
}

console.log(`\n=== ETH scanner path ran live end-to-end ===`);
