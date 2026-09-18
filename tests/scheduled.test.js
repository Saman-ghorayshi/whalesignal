// tests/scheduled.test.js — end-to-end test of the analyst's scheduled
// handler: news scoring + daily brief generation against the mock harness.
// Proves the cron logic actually works — the class of bug where code exists,
// deploys, and silently never runs.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { makeWorld } from "./e2e.fixture.js";
import * as analyst from "../src/analyst.js";

test("analyst scheduled: scores pending news + generates the daily brief", async () => {
  const w = makeWorld();

  // seed 10+ unscored headlines (scorePendingNews needs >= 10)
  for (let i = 0; i < 12; i++) {
    await w.DB.prepare(
      "INSERT INTO news (id, title, source, symbols, sentiment, first_seen) VALUES (?, ?, ?, ?, NULL, ?)"
    ).bind("seed-" + i, "Bitcoin ETF update number " + i, "test-src", "BTC", Date.now() - i * 60_000).run();
  }
  // price history: >= 51 rows so the brief's TA line renders
  for (let i = 0; i < 60; i++) {
    await w.DB.prepare(
      "INSERT OR IGNORE INTO price_history (coin, hour_bucket, price) VALUES ('btc', ?, ?)"
    ).bind(Date.now() - i * 3_600_000, 100_000 + i * 10).run();
  }

  // Groq is first in the default LLM chain; the fixture has no groq handler,
  // so the chain falls through to Gemini (mocked) — exactly like production.
  const r = await w.harness.scheduled(analyst.default, Date.now(), "7 * * * *");

  // news scoring wrote llm scores
  const scored = w.DB.prepare("SELECT COUNT(*) AS n FROM news WHERE llm_sentiment IS NOT NULL").all();
  assert.ok(scored.results[0].n > 0, "news rows must get llm_sentiment");
  // daily brief generated
  const brief = await w.env.KV.get("daily_brief");
  assert.ok(brief, "daily_brief must be written to KV");
  const parsed = JSON.parse(brief);
  assert.ok(parsed.text.length > 20, "brief has content");
  assert.match(parsed.text, /What to watch/, "brief follows the required format");
  // marker set — won't regenerate today
  assert.ok(await w.env.KV.get("brief:" + new Date().toISOString().slice(0, 10)), "brief marker set");
});

test("analyst scheduled: second run same day skips brief regeneration", async () => {
  const w = makeWorld();
  await w.harness.scheduled(analyst.default, Date.now(), "7 * * * *");
  const marker = "brief:" + new Date().toISOString().slice(0, 10);
  assert.ok(await w.env.KV.get(marker), "marker exists after first run");
  // count daily_brief writes by checking it doesn't change timestamp
  const before = await w.env.KV.get("daily_brief");
  await w.harness.scheduled(analyst.default, Date.now() + 1000, "7 * * * *");
  const after = await w.env.KV.get("daily_brief");
  assert.equal(before, after, "brief not regenerated on the same day");
});
