// tests/landing.test.js — the public landing page (GET /): the conversion
// asset that turns the grading ledger into a linkable "no cherry-picking"
// proof. KV-cached 5 min so traffic costs ~0 D1 reads.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { makeWorld } from "./e2e.fixture.js";
import * as bot from "../src/bot.js";

const DAY = 86_400_000;

async function seedGradedCalls(w) {
  // two graded calls in the last 7d: one correct, one wrong
  const rows = [
    { tx: "lp-correct", signal: "bullish", outcome: "correct", detect: 100_000, eval_: 103_000, usd: 6_000_000 },
    { tx: "lp-wrong", signal: "bearish", outcome: "wrong", detect: 100_000, eval_: 102_000, usd: 4_000_000 },
  ];
  for (const r of rows) {
    const ins = await w.DB.prepare(
      "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score, price_at_detect) " +
      "VALUES ('btc', ?, '0xfrom', '0xto', 60, 'BTC', ?, 'exchange_inflow', 800000, ?, 'done', 80, ?)"
    ).bind(r.tx, r.usd, Date.now() - 2 * DAY, r.detect).run();
    await w.DB.prepare(
      "INSERT INTO analysis (whale_id, headline, interpretation, signal, confidence, related_factor, context_relevance, created_at, prediction_outcome, price_at_eval, evaluated_at) " +
      "VALUES (?, 'h', 'i', ?, 0.8, 'rel', 'medium', ?, ?, ?, ?)"
    ).bind(Number(ins.meta.last_row_id), r.signal, Date.now() - 2 * DAY, r.outcome, r.eval_, Date.now() - 1 * DAY).run();
  }
  // lifetime + per-bucket counters: 3 correct / 1 wrong lifetime, high bucket 2/1
  const bump = (k, v) => w.DB.prepare(
    "INSERT INTO counters (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ).bind(k, v).run();
  await bump("outcome:correct", 3);
  await bump("outcome:wrong", 1);
  await bump("outcome:no_move", 2);
  await bump("outcome:high:correct", 2);
  await bump("outcome:high:wrong", 1);
  await bump("total_whales", 4242);
}

async function fetchHome(w) {
  return w.harness.fetch(bot.default, new Request("https://bot.test/"));
}

test("landing: no data yet renders the building state honestly", async () => {
  const w = await makeWorld();
  const res = await fetchHome(w);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("building — first grades land 24h after each call"), html);
  assert.ok(html.includes("not financial advice"), "disclaimer present");
  assert.ok(html.includes("graded last 24h"), html);
});

test("landing: renders the live record, calibration table, and recent graded calls", async () => {
  const w = await makeWorld();
  await seedGradedCalls(w);
  const res = await fetchHome(w);
  assert.equal(res.status, 200);
  const html = await res.text();
  // accuracy = 3/(3+1) = 75%
  assert.ok(html.includes("75%"), html);
  assert.ok(html.includes("6,000,000") || html.includes("$6.00M"), "whales tracked counter renders");
  assert.ok(html.includes("Calibration by claimed confidence"), html);
  assert.ok(html.includes("Recent graded calls"), html);
  assert.ok(html.includes("+3.0% in 24h"), "correct call shows its move");
  assert.ok(html.includes("+2.0% in 24h") && html.includes("❌"), "wrong call shows its move and mark");
  assert.ok(html.includes("not financial advice"), "disclaimer present");
  // channel link from PUBLIC_CHANNEL
  assert.ok(html.includes("https://t.me/whalesignal_test"), "channel CTA from env");
  // the KV cache was populated — a second request serves the same HTML
  const cached = await w.env.KV.get("landing_html");
  assert.ok(cached && cached.includes("75%"), "landing_html KV cache written");
  const res2 = await fetchHome(w);
  assert.equal((await res2.text()), html, "second request serves the cached HTML");
});

test("landing: never leaks secrets or admin surface", async () => {
  const w = await makeWorld();
  await seedGradedCalls(w);
  const html = await (await fetchHome(w)).text();
  assert.ok(!html.includes("TEST_TOKEN_123"), "no bot token in HTML");
  assert.ok(!html.includes("ADMIN"), "no admin surface");
});
