#!/usr/bin/env node
// tools/check_sql.mjs — static SQL validation: extracts every SQL string
// from src/*.js and prepares it against the REAL schema (node:sqlite).
// Catches the "no such column" / "no such table" class of bugs (the
// a.price_at_detect and price_history.ts incidents) without needing a test
// per query. Dynamic ${...} interpolations are substituted with inert
// literals; conditional fragments (built with JS string concat) may produce
// false "incomplete expression" reports — those are listed for eyeballing,
// not hard failures.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// load the real schema into an in-memory DB
const db = new DatabaseSync(":memory:");
const schema = readFileSync("schema/whalesignal.sql", "utf8")
  .split("\n")
  .map((l) => l.replace(/\s*--.*$/, ""))
  .join("\n");
for (const stmt of schema.split(/;\s*\n/)) {
  const t = stmt.trim();
  if (t) db.exec(t + ";");
}
// seed minimal rows so UPDATE ... WHERE references don't fail on missing data
// (not needed for prepare() — only execution needs rows)

function walk(dir) {
  let out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (f.endsWith(".js")) out.push(p);
  }
  return out;
}

// extract template-literal and quoted strings that look like SQL
function extractSql(src) {
  // strip line comments FIRST — comments quoting SQL (// old `SELECT ts, price`)
  // otherwise produce false matches
  src = src.replace(/^\s*\/\/.*$/gm, "");
  const out = [];
  const tpl = /`([^`]*?(?:SELECT|INSERT|UPDATE|DELETE|WITH)[^`]*?)`/gis;
  let m;
  while ((m = tpl.exec(src))) out.push({ sql: m[1], kind: "tpl" });
  const concat = /(?:["'][^"'\n]*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|ORDER BY)[^"'\n]*["'](?:\s*\n?\s*\+\s*\n?\s*["'][^"']*["']\s*)+)/gis;
  while ((m = concat.exec(src))) out.push({ sql: m[0], kind: "concat" });
  // plain single-line quoted SQL (no concatenation, no capture of quotes)
  const plain = /["']([^"'\n]*\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)[^"'\n]*)["']/g;
  while ((m = plain.exec(src))) out.push({ sql: m[1], kind: "plain" });
  return out;
}

function normalize(sql, kind) {
  // concatenate adjacent string fragments: "a" + "b" → ab
  sql = sql.replace(/["']\s*\+\s*["']/g, "");
  // strip JS template interpolations → inert literal
  sql = sql.replace(/\$\{[^}]*\}/g, "'zq'")
    // strip JS comments inside the string
    .replace(/^\s*\/\/.*$/gm, "")
    // unescape backticks used for quoting identifiers inside templates
    .replace(/\\`/g, "`")
    .trim();
  // strip the surrounding quotes left by concatenation extraction
  sql = sql.replace(/^["']/, "").replace(/["']$/, "");
  return sql.trim();
}

let files = walk("src");
let checked = 0, failed = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const found = extractSql(src);
  const prepared = (src.match(/\.prepare\(/g) || []).length;
  console.log(`${file}: ${found.length} SQL extracts / ${prepared} prepare() calls`);
  for (const { sql: raw, kind } of found) {
    let sql = normalize(raw, kind);
    if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(sql)) continue;
    // strip trailing JS junk (e.g. string ends mid-clause in concat builds)
    checked++;
    try {
      const isRead = /^SELECT|WITH/i.test(sql);
      const stmt = db.prepare(sql);
      if (isRead) {
        // bind inert values for every placeholder (type mismatches from the
        // zq substitution can still trip STRICT-ish checks — acceptable)
        const binds = (sql.match(/\?/g) || []).length;
        stmt.all(...Array(binds).fill(1));
      }
      // writes: prepare-only — resolution of columns/tables happens at
      // prepare; running without real binds just fires NOT NULL noise
    } catch (e) {
      const msg = String(e.message);
      if (/no such column|no such table|ambiguous column/i.test(msg)) {
        failed++;
        console.log(`✖ ${file}`);
        console.log(`   ${msg}`);
        console.log(`   SQL: ${sql.slice(0, 140).replace(/\n/g, " ")}`);
      } else if (/incomplete input|near/i.test(msg)) {
        // dynamically-built fragments can't be parsed standalone — eyeball
        // list; the real check for these is the SQL-integration test
        console.log(`? ${file} (fragment, eyeball): ${sql.slice(0, 100).replace(/\n/g, " ")}`);
      } else {
        failed++;
        console.log(`✖ ${file}`);
        console.log(`   ${msg}`);
        console.log(`   SQL: ${sql.slice(0, 140).replace(/\n/g, " ")}`);
      }
    }
  }
}
console.log(`\nchecked ${checked} SQL statements — ${failed} hard failures`);
process.exit(failed ? 1 : 0);
