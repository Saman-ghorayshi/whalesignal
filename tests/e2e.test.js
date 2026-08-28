// tests/e2e.test.js
// End-to-end pipeline test: runs the REAL scanner.scheduled → analyst.queue →
// bot.queue handlers against a mocked env + mocked fetch. Proves the actual
// control flow works end to end on this machine, with no Cloudflare in the loop.
//
// Run:  node --test tests/e2e.test.js
//       (or `npm test` picks it up along with the unit tests)

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { fullPipeline, getTelegramSent, makeWorld } from "./e2e.fixture.js";
import * as scanner from "../src/scanner.js";
import * as analyst from "../src/analyst.js";
import * as bot from "../src/bot.js";

test("renderLatestReply hides chain tag when it repeats the symbol", () => {
  const out = bot.renderLatestReply([
    {
      usd_value: 23_490_000, symbol: "BTC", chain: "btc", signal: "neutral",
      headline: "Whale moves 297.5 BTC between unknown private wallets",
      from_address: "1JPh4Kaaaaaaaaaaaaaaaa", to_address: "1G47mSbbbbbbbbbbbbbbb",
    },
    {
      usd_value: 4_200_000, symbol: "USDT", chain: "eth", signal: "neutral",
      headline: "USDT transfer to exchange",
      from_address: "0xaaa11111111111111111", to_address: "0xbbb22222222222222222",
    },
  ]);
  assert.ok(out.includes("$23.49M BTC —"), `BTC row should not show redundant chain tag:\n${out}`);
  assert.ok(out.includes("USDT eth —"), "non-matching chain tag is kept");
});

test("fullPipeline: scanner→analyst→bot posts one alert", async () => {
  const r = await fullPipeline();

  // 1. Two whales detected (one BTC at 60 BTC=$6M, one ETH at 2000 ETH=$7M)
  assert.equal(r.whales.length, 2, "expected exactly 2 whales");
  const symbols = r.whales.map((w) => w.symbol).sort();
  assert.deepEqual(symbols, ["BTC", "ETH"], "expected one BTC + one ETH whale");

  // 2. Both got classified (they're unknown wallets since no wallet_labels seeded)
  for (const w of r.whales) {
    assert.ok(w.tx_type, "every whale has a tx_type");
  }

  // 3. Analyst processed both (we passed GEMINI_KEY, so both should succeed)
  assert.equal(r.analyses.length, 2, "two analyses saved");
  for (const a of r.analyses) {
    assert.ok(["bullish", "bearish", "neutral"].includes(a.signal), `bad signal: ${a.signal}`);
    assert.ok(a.confidence >= 0 && a.confidence <= 1, `confidence ${a.confidence} out of [0,1]`);
    assert.ok(a.headline?.length > 0, "analysis has a headline");
  }

  // 4. Bot delivered both to the public channel (1 each)
  assert.equal(r.delivered.length, 2, "both whales delivered to channel");

  // 5. Telegram got exactly 2 sendMessage calls
  assert.equal(r.telegramSent.length, 2, "exactly 2 Telegram messages sent");
  for (const t of r.telegramSent) {
    assert.equal(t.chat_id, "@whalesignal_test", "routed to the right channel");
    assert.ok(t.text.includes("WHALE ALERT"), "alert body present");
    assert.ok(t.text.includes("Market:"), "market footer present");
  }

  // 6. Both whales now marked 'done' in the DB
  for (const w of r.whales) {
    assert.equal(w.analysis_status, "done", `whale ${w.id} not marked done`);
  }

  // 7. news_cache written by Ladder A (proves CryptoPanic fetch fired → KV).
  // MockKV.put stores as string, .get returns string. Verify it's parseable
  // AND that the keyword filter kept only matching titles.
  const newsRaw = await r.KV.get("news_cache");
  assert.ok(newsRaw, "news_cache was written by the scanner tick");
  const news = JSON.parse(newsRaw);
  assert.ok(Array.isArray(news.headlines), "news_cache.headlines is an array");
  assert.ok(news.headlines.length > 0 && news.headlines.length <= 5, "kept 1-5 headlines");
  // fixture payload had Binance + ETF matching, beach/avocado non-matching.
  assert.ok(news.headlines.every((h) => /binance|etf/i.test(h.title)),
    "only keyword-matching headlines survived filterNewsKeywords");
});

test("bot fetch handler: /ping replies via Telegram", async () => {
  const w = makeWorld();
  const req = new Request(`https://bot.test/tg/TEST_TOKEN_123`, {
    method: "POST",
    body: JSON.stringify({ message: { chat: { id: 42 }, from: { username: "samsha" }, text: "/ping" } }),
    headers: { "content-type": "application/json" },
  });
  const res = await w.harness.fetch(bot.default, req);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.handled, "ping");
  assert.ok(getTelegramSent().length >= 1, "ping triggered a TG sendMessage");
});

test("bot fetch handler: wrong path returns 404", async () => {
  const w = makeWorld();
  const req = new Request(`https://bot.test/wrong-path`, { method: "POST", body: "{}" });
  const res = await w.harness.fetch(bot.default, req);
  assert.equal(res.status, 404);
});

test("/history binds every SQL parameter (regression: real-D1 binding count bug)", async () => {
  const w = makeWorld();
  await w.DB.prepare(
    "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, " +
    "usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind("eth", "0xhist-regression-1", "0xAAA1111111111111", "0xBBB2222222222222",
    1500, "ETH", 5_000_000, "exchange_inflow", 20_000_001,
    Date.now(), "done", 75).run();

  // historyRows through the real MockD1 (node:sqlite): the old per-value
  // .bind() loop failed here with "Wrong number of parameter bindings".
  const rows = await bot.historyRows(w.env, { limit: 100 });
  assert.equal(rows.length, 1, "historyRows returns the seeded whale");
  assert.equal(rows[0].tx_hash, "0xhist-regression-1");

  // and the HTTP route serves it with filters + pagination applied
  const res = await w.harness.fetch(bot.default,
    new Request("https://bot.test/history?limit=100&chain=eth&min_usd=1000000"));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.limit, 100);
  assert.ok(j.alerts.length >= 1, "filtered history returns the whale");
});

test("webhook dedup: redelivered update_id is ACKed without replying again", async () => {
  const w = makeWorld();
  const mkReq = () => new Request(`https://bot.test/tg/TEST_TOKEN_123`, {
    method: "POST",
    body: JSON.stringify({
      update_id: 777001,
      message: { chat: { id: 42 }, from: { username: "samsha" }, text: "/ping" },
    }),
    headers: { "content-type": "application/json" },
  });
  const r1 = await w.harness.fetch(bot.default, mkReq());
  assert.equal((await r1.json()).handled, "ping", "first delivery answers normally");
  const sentAfterFirst = getTelegramSent().length;
  assert.ok(sentAfterFirst >= 1, "first delivery did send");

  // same update_id replayed (Telegram at-least-once redelivery)
  const r2 = await w.harness.fetch(bot.default, mkReq());
  assert.equal((await r2.json()).handled, "dup", "replay is flagged as dup");
  assert.equal(getTelegramSent().length, sentAfterFirst, "no second Telegram send for a dup");
});

// note: updates WITHOUT an update_id (legacy fixtures) skip dedup entirely —
// proven implicitly by every other fetch test which sends multiple commands.

test("scanner is idempotent across ticks (whales don't get re-inserted or re-queued)", async () => {
  const w = makeWorld();
  await w.harness.scheduled(scanner.default); // prime
  await w.harness.scheduled(scanner.default); // scan block (+1) — finds 2 whales
  assert.equal(w.ANALYSTQ.sent.length, 2, "2 sent on first real scan");

  // Manually mark those 2 as 'done' (simulating analyst finishing them) and clear queue.
  w.DB.prepare("UPDATE whales SET analysis_status = 'done'").run();
  w.ANALYSTQ.pending.length = 0;

  // Re-run another tick — same heights, fixture keeps incrementing, but our
  // whale tx hashes are UNIQUE so insertWhaleAndQueue should reject them as dups.
  await w.harness.scheduled(scanner.default);
  assert.equal(w.ANALYSTQ.sent.length, 2, "no NEW sends — dups ignored by UNIQUE constraint");
});
