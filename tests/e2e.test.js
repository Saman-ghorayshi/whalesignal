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
