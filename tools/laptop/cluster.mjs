#!/usr/bin/env node
// tools/laptop/cluster.mjs — BTC exchange-wallet discovery via the
// common-input-ownership heuristic: addresses that co-sign a transaction
// with a KNOWN exchange wallet are, with high probability, the same
// entity's other wallets (exchanges consolidate UTXOs with many inputs).
//
// This is the laptop's answer to the label-coverage bottleneck: 24 seeded
// exchange wallets grow into hundreds from chain data, keyless, via
// mempool.space. Run it monthly; review the SQL before applying.
//
// Usage:  node tools/laptop/cluster.mjs [--min-cospends 3] [--max-txs 25]
// Output: label_expansion.sql (INSERT OR IGNORE — review, then execute via
//         wrangler d1) + a JSON summary printed to stdout.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = { "User-Agent": "whalesignal-cluster/1.0" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const MIN_COSPENDS = arg("--min-cospends", 3);
const MAX_TXS = arg("--max-txs", 25);

/**
 * Pure: from mempool.space full-tx objects, count co-spend candidates for a
 * seed address — other INPUT addresses on transactions where the seed is
 * also an input. Exported for tests.
 */
export function coSpendsFromTxs(txs, seed) {
  const counts = new Map();
  for (const tx of txs || []) {
    const inputs = (tx.vin || []).map((v) => v.prevout?.scriptpubkey_address).filter(Boolean);
    if (!inputs.includes(seed)) continue;
    for (const a of inputs) {
      if (a === seed) continue;
      counts.set(a, (counts.get(a) || 0) + 1);
    }
  }
  return counts;
}

async function fetchTxs(addr) {
  const res = await fetch(`https://mempool.space/api/address/${addr}/txs`, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const seedPath = join(HERE, "..", "..", "wallet_labels", "exchanges.json");
const seeds = JSON.parse(readFileSync(seedPath, "utf8")).btc.filter((r) => r.type === "exchange");
console.error(`clustering ${seeds.length} BTC seed wallets (min co-spends ${MIN_COSPENDS}, last ${MAX_TXS} txs each)…`);

const sql = [];
const summary = [];
for (const seed of seeds) {
  try {
    const txs = (await fetchTxs(seed.address)).slice(0, MAX_TXS);
    const counts = coSpendsFromTxs(txs, seed.address);
    for (const [addr, n] of counts) {
      if (n < 2) continue; // a single co-spend is noise
      const type = n >= MIN_COSPENDS ? "exchange" : "exchange_candidate";
      const label = `${seed.label} cluster (co-spend ×${n})`;
      sql.push(`INSERT OR IGNORE INTO wallets (address, chain, label, type) VALUES ('${addr}', 'btc', '${label.replace(/'/g, "''")}', '${type}');`);
      summary.push({ seed: seed.label, addr, co_spends: n, type });
    }
    console.error(`  ${seed.label}: ${txs.length} txs, ${counts.size} co-spend candidates`);
  } catch (e) {
    console.error(`  ${seed.label}: FAILED — ${e.message}`);
  }
  await sleep(1100); // mempool.space rate limits; stay polite
}

const outPath = join(HERE, "..", "..", "label_expansion.sql");
writeFileSync(outPath, sql.join("\n") + "\n");
console.log(JSON.stringify({ wallets_discovered: summary.length, sql_file: outPath, summary }, null, 2));
console.error(`\nreview ${outPath}, then:\n  npx wrangler d1 execute whalesignal-db --remote --file label_expansion.sql -y`);
