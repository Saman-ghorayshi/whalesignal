#!/usr/bin/env node
// tools/d1_metrics.mjs — live D1 read/write metrics per database, last 24h.
// Run after any optimization to VERIFY the numbers actually moved.
// Needs CF_ID in .env.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const acctRes = await fetch("https://api.cloudflare.com/client/v4/accounts", {
  headers: { Authorization: "Bearer " + env.CF_ID },
});
const acct = (await acctRes.json()).result[0].id;
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

const query =
  '{ viewer { accounts(filter: {accountTag: "' + acct + '"}) { d1AnalyticsAdaptiveGroups(limit: 10, filter: {datetime_geq: "' + since + '"}) { dimensions { databaseId } sum { rowsRead rowsWritten } } } } }';

const gqlRes = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { Authorization: "Bearer " + env.CF_ID, "content-type": "application/json" },
  body: JSON.stringify({ query }),
});
const j = await gqlRes.json();
const rows = j?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups || [];
const total = rows.reduce((s, x) => s + (x.sum?.rowsRead || 0), 0);
console.log("D1 reads last 24h (account-wide):", total.toLocaleString(), "of 5,000,000 free cap");
console.log("headroom used:", Math.round((total / 5_000_000) * 100) + "%");
for (const x of rows) {
  console.log("  ", x.dimensions.databaseId.slice(0, 8), (x.sum.rowsRead || 0).toLocaleString(), "read /", (x.sum.rowsWritten || 0).toLocaleString(), "written");
}
if (!rows.length) console.log("(no data rows returned)");
