#!/usr/bin/env node
// tools/find_eth_token_block.mjs — walk back N blocks to find one with
// tracked-token (USDT/USDC/DAI/WBTC/LINK) Transfer logs above $500K, then
// print it. For probing the ERC20 path live without waiting on luck.
//
// Run: ETHSCAN_KEY=... node tools/find_eth_token_block.mjs [max_blocks_back=20]

import { SocksProxyAgent } from "socks-proxy-agent";
const agent = new SocksProxyAgent("socks5://127.0.0.1:10808");
const KEY = process.env.ETHSCAN_KEY;
if (!KEY) { console.error("ETHSCAN_KEY required"); process.exit(1); }
const UA = "whalesignal-liveprobe/0.1";
const _f = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => _f(url, { ...opts, agent, headers: { "User-Agent": UA, ...(opts.headers || {}) } });

const scanner = await import("../src/scanner.js");
// fetch_erc20logs uses the global fetch → already patched
const MAX = parseInt(process.argv[2] ?? "20", 10);

const KV = { _s: new Map(), async get(k) { return this._s.get(k) ?? null; }, async put(k, v) { this._s.set(k, v); } };
const env = { KV, ETHSCAN_KEY: KEY };

const market = await scanner.refreshMarketCache(env);

const latest = await scanner.fetchLatestBlockHeight(env, "eth");
console.log(`latest=${latest}, walking back ${MAX} blocks looking for tracked-token whales...`);

for (let i = 0; i < MAX; i++) {
  const h = latest - i;
  const t = Date.now();
  const logs = await scanner.fetchERC20Logs(h, env);
  const erc20 = scanner.extractERC20Candidates(logs, market);
  const big = erc20.filter((c) => c.usd_value >= 500_000);
  console.log(`block ${h}: logs=${logs.length} erc20_candidates=${erc20.length} whales(>=500K)=${big.length}  (${Date.now()-t}ms)`);
  if (big.length > 0) {
    console.log("\nFOUND:");
    const btcUsd = (n) => n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K" : "$" + n.toFixed(0);
    for (const w of big) console.log(`  ${btcUsd(w.usd_value)}  ${w.amount} ${w.symbol}  ${w.tx_hash}  ${w.from_address} -> ${w.to_address}  (contract ${w._contract})`);
    console.log(`\nRe-run live_scan_eth against block ${h}:`);
    console.log(`  ETHSCAN_KEY=... node tools/live_scan_eth.mjs 500000 ${latest - h}`);
    break;
  }
}
