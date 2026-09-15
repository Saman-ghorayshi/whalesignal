// tools/harvest_labels.mjs — one-off harvester that expands wallet_labels/exchanges.json
// from public sources. Re-run quarterly (labels drift; re-verify per the seed file note).
//
// Sources:
//   BTC: bitinfocharts top-100 richest pages (rows carry "wallet: <name>" links).
//        Only wallet names on the EXCHANGE_ALLOWLIST are kept, so hacks /
//        confiscated funds /个人 wallets never poison classification.
//   ETH: dawsbot/eth-labels public dataset — labels matched against the same
//        allowlist (Coinbase, Binance, Kraken, ...).
//
// Usage:  node tools/harvest_labels.mjs   → merges into wallet_labels/exchanges.json
//         (existing entries are never touched; output goes to stdout for review)
import { readFileSync, writeFileSync } from "node:fs";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// wallet-name → canonical exchange label. Only these become type='exchange'.
const EXCHANGE_ALLOWLIST = [
  [/^binance/i, "Binance"],
  [/^okx$|^okex/i, "OKX"],
  [/^bitfinex-coldwallet|^bitfinex-wallet/i, "Bitfinex"],
  [/^bitstamp/i, "Bitstamp"],
  [/^kraken/i, "Kraken"],
  [/^coinbase/i, "Coinbase"],
  [/^gemini/i, "Gemini"],
  [/^bitmex/i, "BitMEX"],
  [/^huobi|^htx/i, "HTX"],
  [/^bybit/i, "Bybit"],
  [/^gate\.io|^gateio/i, "Gate.io"],
  [/^crypto\.com/i, "Crypto.com"],
  [/^bitbank/i, "Bitbank"],
  [/^coincheck/i, "Coincheck"],
  [/^kucoin/i, "KuCoin"],
  [/^robinhood/i, "Robinhood"],
  [/^bittrex/i, "Bittrex"],
  [/^poloniex/i, "Poloniex"],
  [/^upbit/i, "Upbit"],
  [/^bitget/i, "Bitget"],
  [/^mexc/i, "MEXC"],
  [/^deribit/i, "Deribit"],
  [/^bitflyer/i, "bitFlyer"],
];
const canonical = (name) => {
  for (const [re, label] of EXCHANGE_ALLOWLIST) if (re.test(name)) return label;
  return null;
};

const SEED_PATH = new URL("../wallet_labels/exchanges.json", import.meta.url);
const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
const haveBtc = new Set((seed.btc || []).map((r) => r.address));
const haveEth = new Set((seed.eth || []).map((r) => r.address));
const addBtc = [], addEth = [];

// ── BTC: bitinfocharts rich list pages 1-3 ───────────────────────────
const BTC_ADDR = /[13][a-km-zA-HJ-NP-Z1-9]{25,39}/g;
const seenBtc = new Map(); // addr → label
for (const page of ["", "-2", "-3"]) {
  const url = `https://bitinfocharts.com/top-100-richest-bitcoin-addresses${page}.html`;
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) { console.error(`btc page${page}: HTTP ${res.status}`); continue; }
    const html = await res.text();
    // rows: <a href="/bitcoin/address/ADDR">ADDR</a> ... wallet: NAME</a>
    const rowRe = /\/bitcoin\/address\/([13][a-km-zA-HJ-NP-Z1-9]{25,39})[\s\S]{0,400}?wallet[\/:]([A-Za-z0-9._-]+)/g;
    let m, n = 0;
    while ((m = rowRe.exec(html))) {
      const [, addr, walletName] = m;
      const label = canonical(walletName);
      if (!label) continue;
      n++;
      if (!seenBtc.has(addr)) seenBtc.set(addr, label);
    }
    console.log(`btc page${page || "-1"}: ${n} exchange-tagged rows`);
  } catch (e) { console.error(`btc page${page}: ${e.message}`); }
  await sleep(4000); // stay polite; a challenge here just skips the page
}
for (const [addr, label] of seenBtc) {
  if (haveBtc.has(addr)) continue;
  addBtc.push({ address: addr, label: `${label} (rich list, ${new Date().toISOString().slice(0, 10)})`, type: "exchange" });
}

// ── ETH: dawsbot/eth-labels (dist bundles a flat JSON of {address,name}) ──
for (const path of ["dist/labels.json", "labels.json"]) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/dawsbot/eth-labels/main/${path}`);
    if (!res.ok) continue;
    const arr = JSON.parse(await res.text());
    const seenEth = new Map();
    for (const e of arr) {
      const label = canonical(String(e.name || e.label || ""));
      if (!label || !/^0x[0-9a-fA-F]{40}$/.test(String(e.address || ""))) continue;
      if (!seenEth.has(e.address.toLowerCase())) seenEth.set(e.address.toLowerCase(), label);
    }
    for (const [addr, label] of seenEth) {
      if (haveEth.has(addr)) continue;
      addEth.push({ address: addr, label: `${label} (eth-labels, ${new Date().toISOString().slice(0, 10)})`, type: "exchange" });
    }
    console.log(`eth labels: ${addEth.length} exchange entries from ${path}`);
    break;
  } catch { /* try next path */ }
}

// ── merge + write ────────────────────────────────────────────────────
seed.btc = [...(seed.btc || []), ...addBtc];
seed.eth = [...(seed.eth || []), ...addEth];
writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2) + "\n");
console.log(`\nadded btc: ${addBtc.length}, eth: ${addEth.length}. totals: btc=${seed.btc.length} eth=${seed.eth.length}`);
for (const a of addBtc.slice(0, 10)) console.log(`  + ${a.address}  ${a.label}`);
