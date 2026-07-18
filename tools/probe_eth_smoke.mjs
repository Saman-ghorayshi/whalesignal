import { SocksProxyAgent } from "socks-proxy-agent";
const agent = new SocksProxyAgent("socks5://127.0.0.1:10808");
const key = process.env.ETHSCAN_KEY;
if (!key) { console.error("set ETHSCAN_KEY"); process.exit(1); }
const t = Date.now();
const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=${key}`;
const r = await fetch(url, { agent, headers: { "User-Agent": "whalesignal-liveprobe/0.1" } });
const j = await r.json();
console.log("status", r.status, (Date.now()-t)+"ms");
console.log("raw result", j.result);
console.log("height", parseInt(j.result, 16));
