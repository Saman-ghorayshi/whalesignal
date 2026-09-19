// tests/scheduled.test.js — end-to-end test of the analyst's scheduled
// handler: news scoring + daily brief generation against the mock harness.
// Proves the cron logic actually works — the class of bug where code exists,
// deploys, and silently never runs.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { makeWorld } from "./e2e.fixture.js";
import * as analyst from "../src/analyst.js";

test("analyst scheduled: scores pending news + generates the daily brief", async () => {
  const w = await makeWorld();

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
  const scored = await w.DB.prepare("SELECT COUNT(*) AS n FROM news WHERE llm_sentiment IS NOT NULL").all();
  assert.ok(scored.results[0].n > 0, "news rows must get llm_sentiment");
  // the narrative graph was built from the freshly scored rows
  const graphRaw = await w.env.KV.get("news_graph");
  assert.ok(graphRaw, "news_graph KV written by the cron");
  const graph = JSON.parse(graphRaw);
  assert.ok(Array.isArray(graph.themes) && graph.themes.length >= 1, "graph has themes");
  assert.ok(Array.isArray(graph.narratives), "graph has a narratives array");
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
  const w = await makeWorld();
  await w.harness.scheduled(analyst.default, Date.now(), "7 * * * *");
  const marker = "brief:" + new Date().toISOString().slice(0, 10);
  assert.ok(await w.env.KV.get(marker), "marker exists after first run");
  // count daily_brief writes by checking it doesn't change timestamp
  const before = await w.env.KV.get("daily_brief");
  await w.harness.scheduled(analyst.default, Date.now() + 1000, "7 * * * *");
  const after = await w.env.KV.get("daily_brief");
  assert.equal(before, after, "brief not regenerated on the same day");
});

test("analyst scheduled: orphaned pending whales are requeued (outage recovery)", async () => {
  const w = await makeWorld();
  const now = Date.now();
  // orphan: pending, older than the 30-min grace — its queue message died
  // mid-outage (D1 cap / deploy). fresh: pending but within the grace window
  // (still owned by a live queue message). done: never eligible.
  for (const [tx, ageMin, status] of [
    ["orphan-old", 120, "pending"],
    ["fresh-msg", 5, "pending"],
    ["already-done", 120, "done"],
  ]) {
    const r = await w.DB.prepare(
      "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score) " +
      "VALUES ('btc', ?, '0xfrom', '0xto', 1, 'BTC', 1000000, 'wallet_to_wallet', 800000, ?, ?, 10)"
    ).bind("tx-" + tx, now - ageMin * 60_000, status).run();
    if (status === "done") {
      await w.DB.prepare("INSERT INTO analysis (whale_id, headline, interpretation, signal, confidence, related_factor, context_relevance, created_at, prediction_outcome) VALUES (?, 'h', 'i', 'neutral', 0.5, 'rel', 'medium', ?, 'no_signal')")
        .bind(Number(r.meta.last_row_id), now).run();
    }
  }

  await w.harness.scheduled(analyst.default, Date.now(), "7 * * * *");

  const sent = w.ANALYSTQ.sent.map((m) => {
    const body = typeof m.body === "string" ? JSON.parse(m.body) : m.body;
    return body.whale_id;
  });
  assert.equal(sent.length, 1, `exactly the orphan gets requeued, got: ${JSON.stringify(sent)}`);
  const orphanId = await w.DB.prepare("SELECT id FROM whales WHERE tx_hash = 'tx-orphan-old'").first();
  assert.equal(sent[0], orphanId.id, "the requeued whale is the orphaned one");
  // and the orphan itself is untouched — still pending until the analyst
  // actually re-processes it (queue message just re-sent)
  const st = await w.DB.prepare("SELECT analysis_status FROM whales WHERE tx_hash = 'tx-orphan-old'").first();
  assert.equal(st.analysis_status, "pending");
});
