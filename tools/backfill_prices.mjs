#!/usr/bin/env node
// tools/backfill_prices.mjs — one-time: fetch 90d of hourly BTC/ETH prices
// from CoinGecko and emit idempotent SQL (INSERT OR IGNORE) so the TA regime
// engine has full history immediately instead of building it over 2 days.
//
// Usage:  node tools/backfill_prices.mjs   → writes prices_backfill.sql
//         npx wrangler d1 execute whalesignal-db --remote --file prices_backfill.sql -y
import { writeFileSync } from "node:fs";

async function series(coin, days = 90) {
  const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: { "User-Agent": "whalesignal-backfill/1.0" } });
  if (!res.ok) throw new Error(`${coin}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.prices || []);
}

const rows = [];
for (const [coin, id] of [["btc", "bitcoin"], ["eth", "ethereum"]]) {
  const pts = await series(id);
  // one row per HOUR bucket (the live scanner writes hourly snapshots too)
  const seen = new Set();
  for (const [ts, price] of pts) {
    const hb = Math.floor(ts / 3_600_000) * 3_600_000;
    if (seen.has(hb) || !(price > 0)) continue;
    seen.add(hb);
    rows.push(`INSERT OR IGNORE INTO price_history (coin, hour_bucket, price) VALUES ('${coin}', ${hb}, ${price.toFixed(2)});`);
  }
  console.error(`${coin}: ${seen.size} hourly rows`);
}
// chunked into 400-row multi-row INSERTs keeps statements small
writeFileSync("prices_backfill.sql", rows.join("\n") + "\n");
console.error(`wrote prices_backfill.sql (${rows.length} statements — run via wrangler d1 execute)`);
