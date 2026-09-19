#!/usr/bin/env node
// tools/d1_metrics_hourly.mjs — D1 reads per UTC-hour bucket, last 24h.
// The hourly shape is how we prove optimizations actually landed: a fix shows
// up as a step-drop in the current bucket, a runaway query as a flat high
// "metronome" across buckets.
// Needs CF_ID in .env.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const acct = (await (await fetch("https://api.cloudflare.com/client/v4/accounts", {
  headers: { Authorization: "Bearer " + env.CF_ID },
})).json()).result[0].id;
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

const query =
  '{ viewer { accounts(filter: {accountTag: "' + acct + '"}) { d1AnalyticsAdaptiveGroups(limit: 100, filter: {datetime_geq: "' + since + '"}) { dimensions { databaseId datetimeHour } sum { rowsRead rowsWritten } } } } }';

const j = await (await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { Authorization: "Bearer " + env.CF_ID, "content-type": "application/json" },
  body: JSON.stringify({ query }),
})).json();

const rows = j?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups || [];
if (!rows.length) { console.log("(no data rows returned)"); process.exit(0); }

const byHour = new Map();
for (const x of rows) {
  const h = x.dimensions.datetimeHour.slice(0, 13); // YYYY-MM-DDTHH
  const cur = byHour.get(h) || { read: 0, written: 0 };
  cur.read += x.sum?.rowsRead || 0;
  cur.written += x.sum?.rowsWritten || 0;
  byHour.set(h, cur);
}
console.log("Account-wide D1 rows read per UTC hour (all databases):");
for (const [h, v] of [...byHour.entries()].sort()) {
  const bar = "█".repeat(Math.min(60, Math.round(v.read / 25000)));
  console.log(`  ${h}  ${String(v.read).padStart(9)} read  ${String(v.written).padStart(7)} written  ${bar}`);
}
