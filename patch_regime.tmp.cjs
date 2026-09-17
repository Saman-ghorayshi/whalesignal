const fs = require("fs");
let a = fs.readFileSync("src/analyst.js", "utf8");
let fail = (m) => { console.error(m); process.exit(1); };

// ─── 1. per-regime weight selection: bull/bear/choppy → generic fallback ──
const wOld = "async function loadFlowWeights(env) {\n  if (weightsCache.w && Date.now() - weightsCache.ts < 300_000) return weightsCache.w;\n  let w = null;\n  try { w = JSON.parse(await env.KV.get(\"config:flow_weights\") || \"null\"); } catch {}\n  weightsCache = { w: sanitizeWeights(w), ts: Date.now() };\n  return weightsCache.w;\n}";
const wNew = [
  "async function loadFlowWeights(env, regime = null) {",
  "  // per-regime sets take priority (train.mjs writes config:flow_weights_bull/",
  "  // _bear/_choppy); the generic set is the fallback; defaults last.",
  "  const regimeKey = regime === \"bull_trend\" || regime === \"overbought\" ? \"bull\"",
  "    : regime === \"bear_trend\" || regime === \"oversold\" ? \"bear\" : \"choppy\";",
  "  if (weightsCache.sets && Date.now() - weightsCache.ts < 300_000) {",
  "    return weightsCache.sets[regimeKey] ?? weightsCache.generic ?? null;",
  "  }",
  "  const read = async (k) => { try { return JSON.parse(await env.KV.get(k) || \"null\"); } catch { return null; } };",
  "  const sets = {",
  "    generic: sanitizeWeights(await read(\"config:flow_weights\")) || null,",
  "    bull: sanitizeWeights(await read(\"config:flow_weights_bull\")) || null,",
  "    bear: sanitizeWeights(await read(\"config:flow_weights_bear\")) || null,",
  "    choppy: sanitizeWeights(await read(\"config:flow_weights_choppy\")) || null,",
  "  };",
  "  weightsCache = { sets, ts: Date.now() };",
  "  return sets[regimeKey] ?? sets.generic ?? null;",
  "}",
].join("\n");
if (!a.includes(wOld)) fail("loadFlowWeights anchor missing");
a = a.replace(wOld, wNew);
// weightsCache shape changed
a = a.replace("let weightsCache = { w: null, ts: 0 };", "let weightsCache = { sets: null, ts: 0 };");

// analyzeOne: pass the TA regime into the loader
a = a.replace(
  "  ctx.weights = await loadFlowWeights(env);",
  "  ctx.weights = await loadFlowWeights(env, ctx?.ta?.regime);"
);
ok = console.log;
ok("1. per-regime weights");

// ─── 2. daily LLM news scoring (1 batched call when ≥10 unscored) ─────
const newsScore = [
  "",
  "// ─── daily LLM news scoring (better news, one batched call) ──────────",
  "//",
  "// The lexicon is the noise floor: it can't tell 'SEC approves ETF' from",
  "// 'SEC delays ETF decision'. One LLM call scores up to 20 unscored",
  "// headlines with sentiment + event type; rows are marked so nothing is",
  "// scored twice. Runs from the analyst cron (hourly, only when enough",
  "// unscored rows accumulate — usually one call per day).",
  "export function buildNewsScorePrompt(headlines) {",
  "  return `You are a crypto news classifier. For each headline output a JSON array item:",
  "  {\"i\": <index>, \"s\": <-1|0|1>, \"e\": \"<regulation|hack|adoption|macro|etf|exchange|market|other>\"}",
  "  s: -1 bearish, 0 neutral, 1 bullish FOR THE ASSET MENTIONED (crypto-wide news counts for both BTC and ETH). Judge the headline's own content, not vibes.",
  "  HEADLINES:",
  "  ${headlines.map((h, i) => `${i}. ${h.title}`).join(\"\\n\")}",
  "  Return ONLY the JSON array.`;",
  "}",
  "",
  "export function parseNewsScores(text) {",
  "  if (!text) return null;",
  "  const s = String(text).replace(/^```(?:json)?/i, \"\").replace(/```$/, \"\").trim();",
  "  const first = s.indexOf(\"[\"), last = s.lastIndexOf(\"]\");",
  "  if (first < 0 || last <= first) return null;",
  "  try {",
  "    const arr = JSON.parse(s.slice(first, last + 1));",
  "    if (!Array.isArray(arr)) return null;",
  "    return arr.filter((it) => it && Number.isFinite(it.i) && [-1, 0, 1].includes(it.s))",
  "      .map((it) => ({ i: it.i, s: it.s, e: String(it.e || \"other\").slice(0, 24) }));",
  "  } catch { return null; }",
  "}",
  "",
  "export async function scorePendingNews(env) {",
  "  const { results } = await env.DB.prepare(",
  "    \"SELECT id, title FROM news WHERE scored_at IS NULL ORDER BY first_seen ASC LIMIT 20\"",
  "  ).all();",
  "  if (!results || results.length < 10) return { scored: 0, skipped: \"fewer than 10 unscored\" };",
  "  const prompt = buildNewsScorePrompt(results);",
  "  let parsed = null;",
  "  try { parsed = parseNewsScores(await callLLM(env, prompt)); }",
  "  catch (e) { return { scored: 0, skipped: e.message }; }",
  "  if (!parsed) return { scored: 0, skipped: \"unparseable\" };",
  "  const stmts = parsed.map((it) => {",
  "    const row = results[it.i];",
  "    if (!row) return null;",
  "    return env.DB.prepare(",
  "      \"UPDATE news SET llm_sentiment = ?, llm_event = ?, scored_at = ? WHERE id = ? AND scored_at IS NULL\"",
  "    ).bind(it.s, it.e, Date.now(), row.id);",
  "  }).filter(Boolean);",
  "  if (stmts.length) await env.DB.batch(stmts);",
  "  return { scored: stmts.length };",
  "}",
  "",
].join("\n");
const schedAnchor = "export default {";
if (!a.includes(schedAnchor)) fail("default export anchor missing");
a = a.replace(schedAnchor, newsScore + "\n" + schedAnchor);

// analyst scheduled handler + cron-able default export
a = a.replace(
  "export default {\n  // Cloudflare Queues: batch messages arrive — ack each by awaiting.\n  async queue(batch, env) {",
  "export default {\n  // Hourly cron: score pending news headlines (one batched LLM call when\n  // enough accumulated). Cheap by design: 24 calls/day ceiling, usually ~1.\n  async scheduled(event, env, ctx) {\n    try {\n      const r = await scorePendingNews(env);\n      console.log(\"[analyst] news scoring:\", JSON.stringify(r));\n    } catch (e) {\n      console.error(\"[analyst] scheduled failed:\", e.message);\n    }\n  },\n  // Cloudflare Queues: batch messages arrive — ack each by awaiting.\n  async queue(batch, env) {"
);
fs.writeFileSync("src/analyst.js", a);
console.log("2. LLM news scoring + analyst cron");

// cron trigger on the analyst worker
let t = fs.readFileSync("wrangler.analyst.toml", "utf8");
if (!t.includes("[triggers]")) {
  t += '\n# Hourly news-scoring cron (scorePendingNews in src/analyst.js)\n[triggers]\ncrons = ["7 * * * *"]\n';
  fs.writeFileSync("wrangler.analyst.toml", t);
  console.log("analyst cron trigger added");
}

// schema: llm scoring columns
let sc = fs.readFileSync("schema/whalesignal.sql", "utf8");
sc += "\n-- Sprint 5g — LLM-scored news (daily batched call; lexicon stays as the\n-- 0-latency fallback). Columns added via ALTER on live databases.\nALTER TABLE news ADD COLUMN llm_sentiment INTEGER;\nALTER TABLE news ADD COLUMN llm_event TEXT;\nALTER TABLE news ADD COLUMN scored_at INTEGER;\n";
fs.writeFileSync("schema/whalesignal.sql", sc);
console.log("schema columns added");
console.log("ALL OK");
