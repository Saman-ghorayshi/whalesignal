const fs = require("fs");
let fail = (m) => { console.error(m); process.exit(1); };

// ─── 1. bot.js: premium DMs before delivered INSERT (at-least-once for paid) ──
let b = fs.readFileSync("src/bot.js", "utf8");
// extract the premium DM block
const dmStart = b.indexOf("  // premium DM delivery: instant copy to active subscribers");
const dmEnd = b.indexOf("  } catch (e) {\n    console.warn(\"[bot] premium DM delivery failed:\", e.message);\n  }", dmStart);
const dmEndFull = b.indexOf("\n  }", dmEnd) + 3;
const dmBlock = b.slice(dmStart, dmEndFull);
// remove from current position
b = b.slice(0, dmStart) + b.slice(dmEndFull);
// re-insert BEFORE the delivered INSERT
const delAnchor = '  await env.DB.prepare(\n    "INSERT OR IGNORE INTO delivered (whale_id, chat_id, delivered_at) VALUES (?, ?, ?)"';
if (!b.includes(delAnchor)) fail("delivered anchor missing");
b = b.replace(delAnchor, dmBlock + "\n" + delAnchor);
console.log("1. premium DM moved before delivered INSERT (at-least-once for paid subscribers)");

// ─── 2. dry-run division by zero: entry_price = 0 → NaN PnL ──────────
const divOld = "        # dry-run: simulate price drift (entry +- 1%)\n        current_price = entry * 1.01 if side == \"long\" else entry * 0.99";
const divNew = [
  "        # dry-run: simulate price drift (entry +- 1%)",
  "        # entry_price can be 0 when market data was missing at trade time —",
  "        # guard against division by zero which would produce NaN PnL forever",
  "        if entry == 0:",
  "            close_trade(db, t[\"id\"], 0, 0, \"no_price\", now)",
  "            db.commit()",
  "            continue",
  "        current_price = entry * 1.01 if side == \"long\" else entry * 0.99",
].join("\n");
if (!m.includes(divOld)) fail("dry-run div anchor missing");
// fix in trading_loop/main.py
let m = fs.readFileSync("trading_loop/main.py", "utf8");
if (!m.includes(divOld)) fail("trading_loop div anchor missing");
m = m.replace(divOld, divNew);
fs.writeFileSync("trading_loop/main.py", m);
console.log("2. dry-run div-by-zero fixed");

// ─── 3. extend news retention for LLM-scored rows ────────────────────
b = fs.readFileSync("src/bot.js", "utf8");
const newsCleanOld = '          await env.DB.prepare("DELETE FROM news WHERE first_seen < ?").bind(Date.now() - 30 * 86_400_000).run();';
const newsCleanNew = [
  "          // keep LLM-scored headlines for 90d (research value); unscored at 30d",
  "          await env.DB.prepare(\"DELETE FROM news WHERE first_seen < ? AND llm_sentiment IS NULL\").bind(Date.now() - 30 * 86_400_000).run();",
  "          await env.DB.prepare(\"DELETE FROM news WHERE first_seen < ?\").bind(Date.now() - 90 * 86_400_000).run();",
].join("\n");
if (!b.includes(newsCleanOld)) fail("news clean anchor missing");
b = b.replace(newsCleanOld, newsCleanNew);
fs.writeFileSync("src/bot.js", b);
console.log("3. LLM-scored news gets 90d retention");

// ─── 4. score reconciliation in the monthly prune ────────────────────
const reconcileAnchor = '          await env.DB.prepare("DELETE FROM news WHERE first_seen < ?").bind(Date.now() - 90 * 86_400_000).run();';
if (!b.includes(reconcileAnchor)) fail("reconcile anchor missing");
const reconcileNew = reconcileAnchor + "\n          // reconcile counters with actual table counts (drift from failed rollup flushes)\n          await env.DB.prepare(\n            \"UPDATE counters SET v = (SELECT COUNT(*) FROM whales) WHERE k = 'total_whales'\"\n          ).run();";
b = b.replace(reconcileAnchor, reconcileNew);
fs.writeFileSync("src/bot.js", b);
console.log("4. counter reconciliation added to monthly prune");

// ─── 5. hourly_stats 24h boundary: use >= instead of > ────────────────
let botJs = b;
const boundaryOld = "SUM(CASE WHEN hour_bucket > ? THEN events ELSE 0 END) AS c24";
const boundaryNew = "SUM(CASE WHEN hour_bucket >= ? THEN events ELSE 0 END) AS c24";
if (botJs.includes(boundaryOld)) {
  botJs = botJs.replace(boundaryOld, boundaryNew);
  fs.writeFileSync("src/bot.js", botJs);
  console.log("5. hourly boundary >= (no gap at window edge)");
}
console.log("ALL OK");
