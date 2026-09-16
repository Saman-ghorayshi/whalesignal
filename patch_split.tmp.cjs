const fs = require("fs");

// ─── scanner: bucket stablecoin flows separately in the rollups ──────
let s = fs.readFileSync("src/scanner.js", "utf8");

// accWhale: track stable vs native USD flows per hour bucket
const hOld = "  const h = acc.hours.get(chain) || { events: 0, volume_usd: 0, inflow_usd: 0, outflow_usd: 0, inflow_count: 0, outflow_count: 0 };";
const hNew = "  const h = acc.hours.get(chain) || { events: 0, volume_usd: 0, inflow_usd: 0, outflow_usd: 0, inflow_count: 0, outflow_count: 0, stable_inflow_usd: 0, stable_outflow_usd: 0 };";
if (!s.includes(hOld)) { console.error("h anchor missing"); process.exit(1); }
s = s.replace(hOld, hNew);

const isStableSym = '  const isStableSym = ["USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDP"].includes(sym);';
const flowFoldAnchor = '  if (w.tx_type === "exchange_inflow" || w.tx_type === "exchange_outflow") {';
const flowFoldNew = isStableSym + "\n" + flowFoldAnchor;
if (!s.includes(flowFoldAnchor)) { console.error("flow anchor missing"); process.exit(1); }
s = s.replace(flowFoldAnchor, flowFoldNew);

const foldOld = [
  "    if (isIn) { h.inflow_usd += usd; h.inflow_count += 1; }",
  "    else { h.outflow_usd += usd; h.outflow_count += 1; }",
].join("\n");
const foldNew = [
  "    if (isIn) { h.inflow_usd += usd; h.inflow_count += 1; }",
  "    else { h.outflow_usd += usd; h.outflow_count += 1; }",
  "    if (isStableSym) {",
  "      if (isIn) h.stable_inflow_usd += usd;",
  "      else h.stable_outflow_usd += usd;",
  "    }",
].join("\n");
if (!s.includes(foldOld)) { console.error("fold anchor missing"); process.exit(1); }
s = s.replace(foldOld, foldNew);

// rollupStatements: persist the new columns
const stmtOld = [
  "      sql: `INSERT INTO hourly_stats (hour_bucket, chain, events, volume_usd, inflow_usd, outflow_usd, inflow_count, outflow_count)",
  "            VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  "            ON CONFLICT(hour_bucket, chain) DO UPDATE SET",
  "              events = events + excluded.events, volume_usd = volume_usd + excluded.volume_usd,",
  "              inflow_usd = inflow_usd + excluded.inflow_usd, outflow_usd = outflow_usd + excluded.outflow_usd,",
  "              inflow_count = inflow_count + excluded.inflow_count, outflow_count = outflow_count + excluded.outflow_count`,",
  "      binds: [acc.hour, chain, h.events, h.volume_usd, h.inflow_usd, h.outflow_usd, h.inflow_count, h.outflow_count],",
].join("\n");
const stmtNew = [
  "      sql: `INSERT INTO hourly_stats (hour_bucket, chain, events, volume_usd, inflow_usd, outflow_usd, inflow_count, outflow_count, stable_inflow_usd, stable_outflow_usd)",
  "            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  "            ON CONFLICT(hour_bucket, chain) DO UPDATE SET",
  "              events = events + excluded.events, volume_usd = volume_usd + excluded.volume_usd,",
  "              inflow_usd = inflow_usd + excluded.inflow_usd, outflow_usd = outflow_usd + excluded.outflow_usd,",
  "              inflow_count = inflow_count + excluded.inflow_count, outflow_count = outflow_count + excluded.outflow_count,",
  "              stable_inflow_usd = stable_inflow_usd + excluded.stable_inflow_usd, stable_outflow_usd = stable_outflow_usd + excluded.stable_outflow_usd`,",
  "      binds: [acc.hour, chain, h.events, h.volume_usd, h.inflow_usd, h.outflow_usd, h.inflow_count, h.outflow_count, h.stable_inflow_usd, h.stable_outflow_usd],",
].join("\n");
if (!s.includes(stmtOld)) { console.error("stmt anchor missing"); process.exit(1); }
s = s.replace(stmtOld, stmtNew);
fs.writeFileSync("src/scanner.js", s);
console.log("scanner stablecoin split done");

// ─── analyst: 60s isolate cache for market context ────────────────────
let a = fs.readFileSync("src/analyst.js", "utf8");
const ctxOld = "export async function getMarketContext(env, chain, symbol) {";
const ctxNew = [
  "// Isolate-level cache: 400-row price read per analyzed event was wasteful",
  "// when a queue batch analyzes several events from the same chain in seconds.",
  "const ctxCache = new Map(); // chain → { ctx, ts }",
  "const CTX_TTL_MS = 60_000;",
  "",
  "export async function getMarketContext(env, chain, symbol) {",
].join("\n");
if (!a.includes(ctxOld)) { console.error("ctx anchor missing"); process.exit(1); }
a = a.replace(ctxOld, ctxNew);
// wrap the return with cache read/write
const retOld = "  return { ta, newsSent };";
const retNew = [
  "  const out = { ta, newsSent };",
  "  if (ta || newsSent) ctxCache.set(coin, { ctx: out, ts: Date.now() });",
  "  return out;",
  "}",
  "",
  "// legacy single-arg export kept for tests that call the wrapped body",
  "async function getMarketContextCached(env, chain, symbol) {",
  "  const coinKey = String(chain || \"\").toLowerCase() === \"eth\" ? \"eth\" : \"btc\";",
  "  const hit = ctxCache.get(coinKey);",
  "  if (hit && Date.now() - hit.ts < CTX_TTL_MS) return hit.ctx;",
  "  return getMarketContext(env, chain, symbol);",
].join("\n");
if (!a.includes(retOld)) { console.error("ret anchor missing"); process.exit(1); }
a = a.replace(retOld, retNew);
fs.writeFileSync("src/analyst.js", a);
console.log("analyst ctx cache added");
