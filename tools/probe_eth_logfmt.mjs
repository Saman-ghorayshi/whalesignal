import { SocksProxyAgent } from "socks-proxy-agent";
const agent = new SocksProxyAgent("socks5://127.0.0.1:10808");
const KEY = process.env.ETHSCAN_KEY;
const _f = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => _f(url, { ...opts, agent, headers: { "User-Agent": "x", ...(opts.headers || {}) }, timeoutMs: 20000 });

// query block 25552643 USDT (0xdac17f958d2ee523a2206206994597c13d831ec7) directly
const usdtAddr = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const blk = "0x" + (25552643).toString(16);
const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&fromBlock=${blk}&toBlock=${blk}&address=${usdtAddr}&topic0=${TRANSFER}&apikey=${KEY}`;
const r = await fetch(url);
const j = await r.json();
console.log("HTTP", r.status, "status msg", j.status, j.message);
console.log("n results", Array.isArray(j.result) ? j.result.length : "not array: " + typeof j.result);
if (Array.isArray(j.result) && j.result.length) {
  console.log("FIRST LOG:");
  console.log(JSON.stringify(j.result[0], null, 2));
}
