#!/usr/bin/env node
// tools/check_wiring.mjs — cross-file contract checks that unit tests miss:
//   1. every named import resolves to a real export in the target module
//      (the class that silently killed dailyizedVolPct: a missing import
//      throws inside a try/catch and the feature just vanishes)
//   2. every env.X reference is a known binding or secret
//   3. KV keys written vs read — flags read-only keys that nothing writes
// Exit 1 on any hard failure.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
  let out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (f.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk("src");
const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));

// ─── 1. import/export resolution ──────────────────────────────────────
function exportsOf(srcText) {
  const names = new Set();
  for (const m of srcText.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of srcText.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  for (const m of srcText.matchAll(/export\s+class\s+(\w+)/g)) names.add(m[1]);
  for (const m of srcText.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  // default export marker
  if (/export\s+default/.test(srcText)) names.add("default");
  return names;
}

let importFailures = 0;
for (const [file, text] of Object.entries(src)) {
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    const target = join("src", m[2].replace("./", ""));
    let targetSrc;
    try { targetSrc = readFileSync(target, "utf8"); }
    catch {
      console.log(`✖ ${file}: import from "${m[2]}" — target file not found`);
      importFailures++;
      continue;
    }
    const exports = exportsOf(targetSrc);
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name || name === "default") continue;
      if (!exports.has(name)) {
        console.log(`✖ ${file}: imports "${name}" from ${m[2]} — NOT EXPORTED there`);
        importFailures++;
      }
    }
  }
}

// ─── 2. env bindings ──────────────────────────────────────────────────
const KNOWN_ENV = new Set([
  // bindings
  "DB", "KV", "BOTQ", "ANALYSTQ", "SCANQ", "QUEUE",
  // secrets / vars documented in wrangler.*.toml or set via wrangler secret
  "BOT_TOKEN", "PUBLIC_CHANNEL", "GEMINI_KEY", "GEMINI_MODEL", "GROQ_KEY",
  "MIN_USD", "MAX_BLOCKS", "ETHSCAN_KEY", "ETHERSCAN_KEY", "BSCSCAN_KEY", "ADMIN_TOKEN",
  "CRYPTOPAY_URL", "PAY_SECRET", "ADMIN_CHAT_ID",
  // optional, every use guarded by `if (!env.X) skip`
  "CRYPTOPAY", "ALERTS_R2", "GH_PAT", "GH_REPO", "NEWS_TOKEN",
  "CG_KEYS", "CG_KEY", "CRYPTOCOMPARE_KEY",
]);
const envRefs = new Map();
for (const [file, text] of Object.entries(src)) {
  for (const m of text.matchAll(/env\.([A-Z_][A-Z0-9_]*)/g)) {
    if (!envRefs.has(m[1])) envRefs.set(m[1], new Set());
    envRefs.get(m[1]).add(file);
  }
}
let envFailures = 0;
for (const [name, where] of envRefs) {
  if (!KNOWN_ENV.has(name)) {
    console.log(`? env.${name} used in ${[...where].join(", ")} — not in the known list (verify it's set via wrangler secret/vars)`);
  }
}

// ─── 3. KV key write/read consistency ─────────────────────────────────
const kvWrites = new Map(), kvReads = new Map();
for (const [file, text] of Object.entries(src)) {
  for (const m of text.matchAll(/KV\.get\((?:["'`]([^"'`]+)["'`]|([^)]+))\)/g)) {
    const key = (m[1] || m[2] || "").trim();
    if (m[1]) kvReads.set(m[1], file);
  }
  for (const m of text.matchAll(/KV\.put\(\s*["'`]([^"'`]+)["'`]/g)) kvWrites.set(m[1], file);
  for (const m of text.matchAll(/KV\.delete\(\s*["'`]([^"'`]+)["'`]/g)) kvReads.set(m[1], file);
}
// dynamic keys (prefixes) — collect literal prefixes
const kvPrefixReads = new Set();
for (const [file, text] of Object.entries(src)) {
  for (const m of text.matchAll(/KV\.get\(\s*["'`]([^"'`:\$]+)[:\$]/g)) kvPrefixReads.add(m[1] + ":");
  for (const m of text.matchAll(/KV\.get\(\s*["'`]([^"'`]+)"?\s*\+/.g)) kvPrefixReads.add(m[1]);
}
let kvFailures = 0;
for (const [key, file] of kvReads) {
  if (kvWrites.has(key)) continue;
  // dynamic or prefix keys skip exact matching
  if (key.includes("+") || key.includes("$") || key.includes("(")) continue;
  const prefixMatched = [...kvWrites.keys()].some((w) => w.startsWith(key) || key.startsWith(w)) ||
    [...kvPrefixReads].some((p) => key.startsWith(p));
  if (prefixMatched) continue;
  console.log(`? KV "${key}" read in ${file} — nothing writes it (verify: may be set via wrangler kv or another worker)`);
}

console.log(`\nimport resolution: ${importFailures} failures`);
process.exit(importFailures ? 1 : 0);
