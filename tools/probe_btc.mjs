#!/usr/bin/env node
// tools/probe_btc.mjs — live probe of the BTC scanner path through SOCKS5.
// Not a test. Not part of the deployed worker. For dev-machine verification only.
// SOCKS proxy only matters locally; in prod the Worker routes direct.
//
// Run: node tools/probe_btc.mjs
import { SocksProxyAgent } from "socks-proxy-agent";

const PROXY = process.env.SOCKS_URL || "socks5://127.0.0.1:10808";
const agent = new SocksProxyAgent(PROXY);
const UA = "whalesignal-liveprobe/0.1";

const fmt = (ms) => Math.round(ms) + "ms";
const sumHex = (n) => (n ? "0x" + n.toString(16) : null);

async function probe(name, url, parse) {
  const t = Date.now();
  try {
    const r = await fetch(url, { agent, headers: { "User-Agent": UA } });
    if (!r.ok) { console.log(`${name.padEnd(14)} HTTP ${r.status} ${fmt(Date.now() - t)}`); return null; }
    const j = await r.json();
    console.log(`${name.padEnd(14)} OK   ${fmt(Date.now() - t)} ${JSON.stringify(parse(j))}`);
    return j;
  } catch (e) {
    console.error(`${name.padEnd(14)} FAIL ${fmt(Date.now() - t)} ${e.message}`);
    return null;
  }
}

console.log(`proxy: ${PROXY}\n`);
const latest = await probe("blockchain.info",
  "https://blockchain.info/latestblock",
  (j) => ({ height: j.height, hash: j.hash && j.hash.slice(0, 16) + "…" }));

await probe("coingecko",
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true",
  (j) => ({ btc: j.bitcoin, eth: j.ethereum }));

await probe("altme",
  "https://api.alternative.me/fng/?limit=1",
  (j) => ({ value: j.data && j.data[0] && j.data[0].value, label: j.data && j.data[0] && j.data[0].value_classification }));

if (latest && latest.height) {
  console.log(`\nfetching rawblock/${latest.height}…`);
  await probe("rawblock",
    `https://blockchain.info/rawblock/${latest.height}`,
    (j) => ({ height: j.height, n_tx: j.n_tx, size: j.size, txs_sample: j.tx && j.tx.length }));
}
