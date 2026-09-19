// tests/grading.test.js
// gradePending contract + the D1 read-cap "metronome" regression.
//
// The original implementation selected via `FROM whales w JOIN analysis a ...
// ORDER BY w.detected_at` and expire-passed via `whale_id IN (SELECT id FROM
// whales WHERE detected_at < ?)`. SQLite drove BOTH from whales in
// detected_at order — a full ~104K-row scan on every 15-min grade tick
// (~416K reads/hour), which tripped the account-wide 5M rows/day cap and
// auto-paused the whole platform. The replacement is analysis-index-first:
//   * both queries resolve through idx_analysis_outcome (never touch whales)
//   * whale rows come back by PK point-lookups for the ≤100 pending ids
//   * neutrals never enter the ungraded set (analyst writes 'no_signal')
// These tests pin all of that.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { makeWorld, fullPipeline, getTelegramSent } from "./e2e.fixture.js";
import * as bot from "../src/bot.js";
import { gradePending, gradeWindowCheck, GRADE_EXPIRE_SQL, GRADE_PENDING_SQL } from "../src/bot.js";

const H = 3_600_000;

async function seedWhale(DB, { detectedAt, priceAtDetect = 100_000, symbol = "BTC", chain = "btc", from = "0xwhaleFrom0000" }) {
  const r = await DB.prepare(
    "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, " +
    "block_number, detected_at, analysis_status, interesting_score, price_at_detect) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', 80, ?)"
  ).bind(chain, `tx-${Math.random().toString(36).slice(2)}`, from, "0xwhaleTo0000",
    60, symbol, 6_000_000, "exchange_inflow", 800_000, detectedAt, priceAtDetect).run();
  return Number(r.meta.last_row_id);
}

async function seedAnalysis(DB, whaleId, { signal, confidence = 0.8, createdAt, outcome = null }) {
  await DB.prepare(
    "INSERT INTO analysis (whale_id, headline, interpretation, signal, confidence, related_factor, " +
    "created_at, prediction_outcome) VALUES (?, 'h', 'i', ?, ?, 'rel', ?, ?)"
  ).bind(whaleId, signal, confidence, createdAt, outcome).run();
}

async function outcomeOf(DB, whaleId) {
  return DB.prepare(
    "SELECT prediction_outcome, price_at_eval, evaluated_at FROM analysis WHERE whale_id = ?"
  ).bind(whaleId).first();
}

test("gradeWindowCheck: young / due / expired boundaries", () => {
  const now = Date.now();
  assert.equal(gradeWindowCheck(now - 2 * H, now), "young");
  assert.equal(gradeWindowCheck(now - 25 * H, now), "due");
  assert.equal(gradeWindowCheck(now - 40 * H, now), "expired");
});

test("grading queries never touch the whales table for planning (read-cap metronome regression)", async () => {
  const { env } = await makeWorld();
  // enough rows that the planner must reason about real costs, not an empty table
  const now = Date.now();
  for (let i = 0; i < 500; i++) {
    const wid = await seedWhale(env.DB, { detectedAt: now - i * H });
    await seedAnalysis(env.DB, wid, { signal: i % 2 ? "bullish" : "neutral", createdAt: now - i * H, outcome: i % 2 ? "correct" : "no_signal" });
  }

  for (const [name, sql] of [["expire", GRADE_EXPIRE_SQL], ["pending", GRADE_PENDING_SQL]]) {
    const plan = (await env.DB.prepare("EXPLAIN QUERY PLAN " + sql).all()).results;
    const touchingWhales = plan.filter((r) => /whales/i.test(r.detail));
    assert.equal(touchingWhales.length, 0,
      `${name} pass references whales in its plan (full-scan metronome is back):\n${plan.map((p) => p.detail).join("\n")}`);
    assert.ok(plan.some((r) => /idx_analysis_outcome/.test(r.detail)),
      `${name} pass should resolve via idx_analysis_outcome:\n${plan.map((p) => p.detail).join("\n")}`);
  }

  // and the by-PK whale fetch stays a rowid search
  const inPlan = (await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM whales WHERE id IN (?,?,?)").all()).results;
  assert.ok(inPlan.some((r) => /INTEGER PRIMARY KEY/.test(r.detail)),
    `whale fetch should be a PK search:\n${inPlan.map((p) => p.detail).join("\n")}`);
});

test("gradePending: due call grades against market price and writes rollups", async () => {
  const { env } = await makeWorld();
  const now = Date.now();
  // fixture market_cache prices BTC at exactly 100000 → 0% move vs detect → no_move
  const wid = await seedWhale(env.DB, { detectedAt: now - 25 * H });
  await seedAnalysis(env.DB, wid, { signal: "bullish", createdAt: now - 25 * H });

  const r = await gradePending(env);
  assert.equal(r.graded, 1);
  assert.equal(r.considered, 1);

  const row = await outcomeOf(env.DB, wid);
  assert.equal(row.prediction_outcome, "no_move");
  assert.equal(row.price_at_eval, 100000);
  assert.ok(row.evaluated_at > 0);

  const counters = await env.DB.prepare("SELECT k, v FROM counters WHERE k IN ('outcome:no_move','outcome:high:no_move')").all();
  const byK = new Map(counters.results.map((c) => [c.k, c.v]));
  assert.equal(byK.get("outcome:no_move"), 1);
  assert.equal(byK.get("outcome:high:no_move"), 1, "confidence 0.8 lands in the high bucket");

  const ws = await env.DB.prepare("SELECT graded, correct FROM wallet_stats WHERE address = '0xwhaleFrom0000' AND chain = 'btc'").first();
  assert.deepEqual({ graded: ws.graded, correct: ws.correct }, { graded: 1, correct: 0 });
});

test("gradePending: directional move grades correct and counts toward wallet accuracy", async () => {
  const { env } = await makeWorld();
  const now = Date.now();
  await env.KV.put("market_cache", JSON.stringify({
    btc: { price: 102_000, change_24h: 2 }, eth: { price: 3500, change_24h: 0 },
    updated_at: Date.now(),
  }));
  const wid = await seedWhale(env.DB, { detectedAt: now - 25 * H, priceAtDetect: 100_000 });
  await seedAnalysis(env.DB, wid, { signal: "bullish", createdAt: now - 25 * H });

  const r = await gradePending(env);
  assert.equal(r.graded, 1);
  assert.equal((await outcomeOf(env.DB, wid)).prediction_outcome, "correct");

  const ws = await env.DB.prepare("SELECT graded, correct FROM wallet_stats WHERE address = '0xwhaleFrom0000' AND chain = 'btc'").first();
  assert.equal(ws.correct, 1);
});

test("gradePending: young calls wait for their 24h mark", async () => {
  const { env } = await makeWorld();
  const now = Date.now();
  const wid = await seedWhale(env.DB, { detectedAt: now - 2 * H });
  await seedAnalysis(env.DB, wid, { signal: "bearish", createdAt: now - 2 * H });

  const r = await gradePending(env);
  assert.equal(r.graded, 0);
  assert.equal((await outcomeOf(env.DB, wid)).prediction_outcome, null);
});

test("gradePending: calls past the honest window expire via created_at, never graded late", async () => {
  const { env } = await makeWorld();
  const now = Date.now();
  const wid = await seedWhale(env.DB, { detectedAt: now - 40 * H });
  await seedAnalysis(env.DB, wid, { signal: "bullish", createdAt: now - 40 * H });

  const r = await gradePending(env);
  assert.equal(r.graded, 0);
  const row = await outcomeOf(env.DB, wid);
  assert.equal(row.prediction_outcome, "expired");
  assert.ok(row.evaluated_at > 0);
});

test("gradePending: late reanalysis of an old whale still expires (detected_at window held in JS)", async () => {
  const { env } = await makeWorld();
  const now = Date.now();
  // detected 40h ago but the analysis row is fresh (admin reanalysis) — the
  // created_at expire pass misses it, the JS window must catch it
  const wid = await seedWhale(env.DB, { detectedAt: now - 40 * H });
  await seedAnalysis(env.DB, wid, { signal: "bullish", createdAt: now - 1 * H });

  const r = await gradePending(env);
  assert.equal(r.graded, 0);
  assert.equal(r.expired, 1);
  assert.equal((await outcomeOf(env.DB, wid)).prediction_outcome, "expired");
});

test("gradePending: neutral rows never enter the ungraded set (legacy NULL neutrals stay untouched)", async () => {
  const { env } = await makeWorld();
  const now = Date.now();
  const wid = await seedWhale(env.DB, { detectedAt: now - 40 * H });
  // legacy row: neutral + outcome NULL (pre-'no_signal' data)
  await seedAnalysis(env.DB, wid, { signal: "neutral", createdAt: now - 40 * H, outcome: null });

  const r = await gradePending(env);
  assert.equal(r.graded, 0);
  assert.equal(r.pending, 0, "neutral NULL must not be selected for grading");
  assert.equal((await outcomeOf(env.DB, wid)).prediction_outcome, null, "expire pass must not touch neutrals either");
});

test("gradePending: unpriceable symbols close as no_data without polluting accuracy", async () => {
  const { env } = await makeWorld();
  const now = Date.now();
  // 'PEPE' is not in the market cache → priceForSymbol returns null
  const wid = await seedWhale(env.DB, { detectedAt: now - 25 * H, symbol: "PEPE", chain: "eth", priceAtDetect: 0.0001 });
  await seedAnalysis(env.DB, wid, { signal: "bullish", createdAt: now - 25 * H });

  const r = await gradePending(env);
  assert.equal(r.graded, 0, "no_data is not a graded call");
  assert.equal(r.no_data, 1);

  const row = await outcomeOf(env.DB, wid);
  assert.equal(row.prediction_outcome, "no_data", "ledger row is closed honestly");
  assert.equal(row.price_at_eval, null);

  const counters = await env.DB.prepare("SELECT k FROM counters WHERE k LIKE 'outcome:%'").all();
  assert.equal(counters.results.length, 0, "no_data must not write outcome counters");
  const ws = await env.DB.prepare("SELECT COUNT(*) AS n FROM wallet_stats").all();
  assert.equal(ws.results[0].n, 0, "no_data must not touch the wallet's track record");
});

test("postScoreboard: expired and no_data are closed, not graded — the breakdown adds up", async () => {
  const w = await makeWorld();
  const now = Date.now();
  // 4 rows closed in the last 24h: 1 correct, 1 no_move, 1 expired, 1 no_data
  for (const outcome of ["correct", "no_move", "expired", "no_data"]) {
    await w.DB.prepare(
      "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score, price_at_detect) " +
      "VALUES ('btc', ?, '0xfrom', '0xto', 60, 'BTC', 6000000, 'exchange_inflow', 800000, ?, 'done', 80, 100000)"
    ).bind("sb-" + outcome, now - 25 * H).run();
    await w.DB.prepare(
      "INSERT INTO analysis (whale_id, headline, interpretation, signal, confidence, related_factor, context_relevance, created_at, prediction_outcome, evaluated_at) " +
      "VALUES ((SELECT id FROM whales WHERE tx_hash = ?), 'h', 'i', 'bullish', 0.8, 'rel', 'medium', ?, ?, ?)"
    ).bind("sb-" + outcome, now - 25 * H, outcome, now - 1000).run();
  }

  // through the harness so the Telegram fetch is mocked — the real cron path
  // is scheduled(cron="0 18 * * *") → postScoreboard
  await w.harness.scheduled(bot.default, Date.now(), "0 18 * * *");
  const sent = getTelegramSent();
  assert.ok(sent.length >= 1, "scoreboard was posted");
  const msg = sent[sent.length - 1];
  assert.ok(msg.text.includes("Graded last 24h: 2"),
    `expired/no_data must not count as grades (only correct+no_move do):\n${msg.text}`);
  assert.ok(msg.text.includes("✅ 1 correct"), msg.text);
  assert.ok(msg.text.includes("➖ 1 no-move"), msg.text);
});

test("analyst stamps fresh neutral analyses with 'no_signal' at insert (full pipeline)", async () => {
  const r = await fullPipeline();
  assert.ok(r.analyses.length >= 1, "pipeline produced analyses");
  for (const a of r.analyses) {
    if (a.signal === "neutral") {
      assert.equal(a.prediction_outcome, "no_signal",
        "fresh neutral must carry the no_signal stamp so it never sits in the grader's ungraded range");
    } else {
      assert.equal(a.prediction_outcome, null, "directional calls stay pending for the grader");
    }
  }
});
