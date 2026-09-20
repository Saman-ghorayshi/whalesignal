#!/usr/bin/env node
// tools/check_schema_drift.mjs — compares prod D1 tables/columns against
// schema/whalesignal.sql. Catches the "ALTER never applied to prod" class of
// drift (news llm_* columns were missing from prod once). Exit 1 on drift.
// Needs CF_ID in .env.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const DB_ID = "c8e9d8a9-fc2f-4fce-98d4-86f5ab99100a";
const acct = (await (await fetch("https://api.cloudflare.com/client/v4/accounts", {
  headers: { Authorization: "Bearer " + env.CF_ID },
})).json()).result[0].id;

async function query(sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${DB_ID}/query`,
    {
      method: "POST",
      headers: { Authorization: "Bearer " + env.CF_ID, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    }
  );
  const j = await res.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.result[0].results;
}

// parse schema.sql: table → expected columns (top-level lines only)
const schema = readFileSync("schema/whalesignal.sql", "utf8")
  .split("\n")
  .map((l) => l.replace(/\s*--.*$/, ""))
  .join("\n");
const want = {};
const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\);/g;
let m;
while ((m = re.exec(schema))) {
  const cols = m[2]
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0].replace(/,$/, ""))
    .filter((c) => c && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|--)$/.test(c) && !c.startsWith("--"));
  want[m[1]] = new Set(cols);
}

const prodTables = (await query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
)).map((r) => r.name);

let drift = 0;
for (const [table, cols] of Object.entries(want)) {
  if (!prodTables.includes(table)) {
    console.log(`✖ ${table}: MISSING from prod entirely`);
    drift++;
    continue;
  }
  const info = await query(`SELECT name FROM pragma_table_info('${table}')`);
  const have = new Set(info.map((r) => r.name));
  const missing = [...cols].filter((c) => !have.has(c));
  if (missing.length) {
    console.log(`✖ ${table}: missing columns in prod → ${missing.join(", ")}`);
    drift++;
  }
}
console.log(
  `\n${Object.keys(want).length} schema tables vs ${prodTables.length} prod tables — ` +
  (drift ? `${drift} DRIFTED` : "no drift")
);
process.exit(drift ? 1 : 0);
