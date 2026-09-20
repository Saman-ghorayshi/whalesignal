// tests/sql_integration.test.js — executes the EXACT SQL of code paths the
// functional tests don't reach (retention prune, admin endpoints, subscriber
// lifecycle, waitlist, webhook dedup, feedback, wallet auto-labels). Every
// statement here is copied verbatim from src/ — if a column is renamed or a
// table dropped without updating these, this test fails. Closes the gap the
// static checker can only flag as "dynamically built fragment".
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { MockD1 } from "../tools/cf-harness.js";
import { readFileSync } from "node:fs";

function freshDb() {
  const DB = new MockD1();
  DB.execFile("schema/whalesignal.sql");
  return DB;
}

test("retention prune reconciliation SQL executes verbatim", async () => {
  const DB = freshDb();
  const now = Date.now();
  const stmts = [
    ["DELETE FROM whales WHERE detected_at < ?", [now - 545 * 86_400_000]],
    ["DELETE FROM hourly_stats WHERE hour_bucket < ?", [now - 90 * 86_400_000]],
    ["DELETE FROM exchange_netflow_hourly WHERE hour_bucket < ?", [now - 90 * 86_400_000]],
    ["DELETE FROM flow_edges_hourly WHERE hour_bucket < ?", [now - 90 * 86_400_000]],
    ["DELETE FROM news WHERE first_seen < ? AND llm_sentiment IS NULL", [now - 30 * 86_400_000]],
    ["DELETE FROM news WHERE first_seen < ?", [now - 180 * 86_400_000]],
    ["DELETE FROM webhook_seen WHERE seen_at < ?", [now - 7 * 86_400_000]],
    ["UPDATE counters SET v = (SELECT COUNT(*) FROM whales) WHERE k = 'total_whales'", []],
    ["UPDATE counters SET v = (SELECT COALESCE(SUM(usd_value), 0) FROM whales) WHERE k = 'total_volume'", []],
    ["UPDATE counters SET v = (SELECT COALESCE(MAX(usd_value), 0) FROM whales) WHERE k = 'largest_transfer'", []],
    ["DELETE FROM delivered WHERE delivered_at < ?", [now - 90 * 86_400_000]],
    ["DELETE FROM price_history WHERE hour_bucket < ?", [now - 90 * 86_400_000]],
    ["DELETE FROM alert_feedback WHERE created_at < ?", [now - 90 * 86_400_000]],
    // funding_history prunes with the same shape when it ages in
    ["DELETE FROM funding_history WHERE hour_bucket < ?", [now - 90 * 86_400_000]],
  ];
  for (const [sql, binds] of stmts) {
    await DB.prepare(sql).bind(...binds).run();
  }
  assert.ok(true, "all retention statements executed");
});

test("subscriber lifecycle SQL executes verbatim (premium + expiry + waitlist)", async () => {
  const DB = freshDb();
  const now = Date.now();
  // invoice upsert (bot /premium flow)
  await DB.prepare(
    `INSERT INTO subscribers (chat_id, plan, status, invoice, created_at, updated_at)
     VALUES (?, 'premium', 'awaiting_payment', ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET status = 'awaiting_payment', invoice = excluded.invoice, updated_at = excluded.updated_at`
  ).bind(42, JSON.stringify({ ok: true }), now, now).run();
  // activation (handlePremiumPayment)
  await DB.prepare(
    "UPDATE subscribers SET status = 'active', expires_at = ?, updated_at = ? WHERE chat_id = ?"
  ).bind(now + 30 * 86_400_000, now, 42).run();
  // active check (isActiveSubscriber)
  const active = await DB.prepare(
    "SELECT 1 FROM subscribers WHERE chat_id = ? AND status = 'active' AND expires_at > ?"
  ).bind(42, now).first();
  assert.ok(active, "subscriber is active");
  // premium DM fan-out candidates
  const subs = await DB.prepare(
    "SELECT chat_id FROM subscribers WHERE status = 'active' AND expires_at > ?"
  ).bind(now).all();
  assert.equal(subs.results.length, 1);
  // expiry + invoice cleanup (analyst cron)
  await DB.prepare(
    "UPDATE subscribers SET status = 'expired' WHERE status = 'active' AND expires_at < ?"
  ).bind(now + 31 * 86_400_000).run();
  await DB.prepare(
    "DELETE FROM subscribers WHERE status = 'awaiting_payment' AND updated_at < ?"
  ).bind(now + 8 * 86_400_000).run();
  // waitlist
  await DB.prepare("INSERT OR IGNORE INTO waitlist (chat_id, joined_at) VALUES (?, ?)").bind(7, now).run();
  const wl = await DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first();
  assert.equal(wl.n, 1);
});

test("admin + webhook + feedback + auto-label SQL executes verbatim", async () => {
  const DB = freshDb();
  const now = Date.now();
  // seed one whale + wallet
  await DB.prepare(
    "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score) " +
    "VALUES ('btc', 'si-1', '0xfrom', '0xto', 1, 'BTC', 1000000, 'wallet_to_wallet', 800000, ?, 'pending', 60)"
  ).bind(now).run();
  const wid = Number((await DB.prepare("SELECT id FROM whales WHERE tx_hash = 'si-1'").first()).id);

  // admin /api/reanalyze (requeue path)
  const rows = await DB.prepare(
    "SELECT id FROM whales WHERE analysis_status = ? ORDER BY detected_at DESC LIMIT ?"
  ).bind("pending", 25).all();
  assert.equal(rows.results.length, 1);
  const chain = await DB.prepare("SELECT chain FROM whales WHERE id = ?").bind(wid).first();
  await DB.prepare("UPDATE whales SET analysis_status = 'pending' WHERE id = ?").bind(wid).run();

  // analyst requeue consumer read
  await DB.prepare(
    "SELECT id, chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, block_time, detected_at, analysis_status FROM whales WHERE id = ?"
  ).bind(wid).first();

  // webhook dedup + feedback tables
  await DB.prepare("INSERT OR IGNORE INTO webhook_seen (update_id, seen_at) VALUES (?, ?)").bind(777, now).run();
  await DB.prepare("SELECT 1 FROM webhook_seen WHERE update_id = ?").bind(777).first();
  // verbatim from the bot's feedback handler (columns: whale_id, reactor, reaction)
  await DB.prepare(
    "INSERT INTO alert_feedback (whale_id, reactor, reaction, created_at) VALUES (?, ?, ?, ?)" +
    " ON CONFLICT(whale_id, reactor) DO UPDATE SET reaction = excluded.reaction, created_at = excluded.created_at"
  ).bind(wid, "42", "up", now).run();
  await DB.prepare(
    "SELECT reaction, COUNT(*) AS n FROM alert_feedback GROUP BY reaction"
  ).all();

  // wallet auto-label + stats bump (scanner per-whale writes)
  await DB.prepare(
    "INSERT OR IGNORE INTO wallets (address, chain, type, first_seen, last_seen) VALUES (?, ?, 'unknown', ?, ?)"
  ).bind("0xfrom", "btc", now, now).run();
  await DB.prepare(
    "UPDATE wallets SET last_seen = ?, last_tx_hash = ?, tx_count = tx_count + 1, total_volume = total_volume + ? WHERE address = ? AND chain = ?"
  ).bind(now, "si-1", 1000000, "0xfrom", "btc").run();
  // the label map query (including the promoted candidate type)
  const lm = await DB.prepare(
    "SELECT address, chain, label, type FROM wallets WHERE type IN ('exchange', 'treasury', 'bridge', 'miner', 'institution', 'exchange_candidate')"
  ).all();
  assert.ok(Array.isArray(lm.results));

  // analyst orphan + counters LIKE queries
  await DB.prepare(
    "SELECT id, chain FROM whales WHERE analysis_status = ? AND detected_at < ? ORDER BY detected_at ASC LIMIT 25"
  ).bind("pending", now - 1800_000).all();
  await DB.prepare(
    "SELECT k, v FROM counters WHERE k LIKE ? AND (k LIKE ? OR k LIKE ?)"
  ).bind("outcome:%", "%:correct", "%:wrong").all();
  // countCluster + recentFromSameWallet (scanner per-whale reads)
  await DB.prepare(
    "SELECT COUNT(*) AS n FROM whales WHERE to_address = ? AND chain = ? AND detected_at > ? AND id != ?"
  ).bind("0xto", "btc", now - 900_000, wid).first();
  await DB.prepare(
    "SELECT detected_at FROM whales WHERE from_address = ? AND chain = ? AND id != ? ORDER BY detected_at DESC LIMIT 5"
  ).bind("0xfrom", "btc", wid).all();
  assert.ok(true, "all admin/webhook/feedback/label statements executed");
});
