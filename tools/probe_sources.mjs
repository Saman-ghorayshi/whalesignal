#!/usr/bin/env node
// tools/probe_sources.mjs — live health check of every keyless data source
// the pipeline depends on. Run anytime; run after an outage before blaming
// the code. Note: local results may differ from Worker egress (geo-blocks
// apply to some exchanges) — a local FAIL on an exchange API is not proof
// the Worker can't reach it.
//
// Usage: node tools/probe_sources.mjs

const UA = { "User-Agent": "whalesignal-probe/1.0" };
const timeout = (ms) => new AbortController().signal;

async function probe(name, url, parse) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
    const value = parse ? parse(body) : body;
    const ms = Date.now() - t0;
    console.log(`✔ ${name.padEnd(28)} ${String(value).slice(0, 40).padEnd(42)} ${ms}ms`);
    return true;
  } catch (e) {
    console.log(`✖ ${name.padEnd(28)} ${String(e.message).slice(0, 60).padEnd(42)} ${Date.now() - t0}ms`);
    return false;
  }
}

const results = [];

// prices
results.push(await probe("coingecko (btc+eth)", "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd", (j) => `BTC $${j.bitcoin.usd}`));
results.push(await probe("coinbase spot", "https://api.coinbase.com/v2/prices/BTC-USD/spot", (j) => `BTC $${j.data.amount}`));
results.push(await probe("kraken ticker", "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", (j) => `BTC $${j.result.XXBTZUSD.c[0]}`));
results.push(await probe("bitstamp ticker", "https://www.bitstamp.net/api/v2/ticker/btcusd/", (j) => `BTC $${j.last}`));
results.push(await probe("okx ticker", "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT", (j) => `BTC $${j.data[0].last}`));
results.push(await probe("cryptocompare", "https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD", (j) => `BTC $${j.USD}`));

// fear & greed
results.push(await probe("alternative.me F&G", "https://api.alternative.me/fng/?limit=1", (j) => `${j.data[0].value} (${j.data[0].value_classification})`));

// news feeds
results.push(await probe("coindesk rss", "https://www.coindesk.com/arc/outboundfeeds/rss/", (t) => `${(t.match(/<item>/g) || []).length} items`));
results.push(await probe("cointelegraph rss", "https://cointelegraph.com/rss", (t) => `${(t.match(/<item>/g) || []).length} items`));
results.push(await probe("decrypt rss", "https://decrypt.co/feed", (t) => `${(t.match(/<item>/g) || []).length} items`));
results.push(await probe("newsbtc rss", "https://www.newsbtc.com/feed/", (t) => `${(t.match(/<item>/g) || []).length} items`));
results.push(await probe("cryptoslate rss", "https://cryptoslate.com/feed/", (t) => `${(t.match(/<item>/g) || []).length} items`));

// btc chain sources
results.push(await probe("blockchain.info latestblock", "https://blockchain.info/latestblock", (j) => `height ${j.height}`));
results.push(await probe("mempool.space tip", "https://mempool.space/api/blocks/tip/height", (t) => `height ${String(t).trim()}`));
results.push(await probe("publicnode btc rpc", "https://mempool.space/api/v1/fees/recommended", (j) => JSON.stringify(j).slice(0, 30)));

// eth chain
results.push(await probe("etherscan v2 (no key → may 403)", "https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber", (j) => `block ${parseInt(j.result, 16)}`));
results.push(await probe("publicnode eth rpc (GET)", "https://ethereum-rpc.publicnode.com", (t) => "reachable"));

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} sources reachable from this machine.`);
process.exit(0);
