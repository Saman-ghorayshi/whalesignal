// tests/daily_jobs.test.js — the scanner's self-gated daily maintenance jobs
// (sink discovery + stablecoin snapshot) through the REAL scheduled handler.
// Both were exported-but-never-called for the project's entire life: the bot
// read stablecoin_supply that nothing wrote, and sink auto-discovery never
// ran despite the docs calling it live. These tests pin the wiring.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { makeWorld } from "./e2e.fixture.js";
import * as scanner from "../src/scanner.js";

const DAY = 86_400_000;

// the scanner's daily jobs run only on ticks with no new whales and no
// errors — drive scheduled() until the jobs have actually executed
// (marker deleted each round so sink discovery re-runs)
async function runUntilJobsRan(w, rounds = 8, offsetStart = 0) {
  for (let i = 0; i < rounds; i++) {
    await w.env.KV.delete('sinkscan:' + new Date().toISOString().slice(0, 10));
    await w.harness.scheduled(scanner.default, Date.now() + (offsetStart + i) * 60_000, '* * * * *');
    const row = await w.DB.prepare('SELECT COUNT(*) AS n FROM stablecoin_supply').first();
    if (row && row.n >= 1) return i + 1;
  }
  return rounds;
}

async function seedSinkActivity(w) {
  // one destination receiving $3M from each of 5 distinct senders in 7d
  for (let i = 0; i < 5; i++) {
    await w.DB.prepare(
      "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score) " +
      "VALUES ('btc', ?, ?, 'sink-dest-0000000000', 30, 'BTC', 3000000, 'wallet_to_wallet', 800000, ?, 'skipped', 60)"
    ).bind(`sink-tx-${i}`, `sender-${i}`, Date.now() - i * 3600_000).run();
  }
}

test("daily jobs: scheduled run writes the stablecoin snapshot + discovers sink candidates", async () => {
  const w = await makeWorld();
  await seedSinkActivity(w);

  await runUntilJobsRan(w);

  // stablecoin snapshot: DefiLlama mock returns 83B + 34B = 117B
  const snap = await w.DB.prepare("SELECT day, total_usd FROM stablecoin_supply").all();
  assert.equal(snap.results.length, 1, "exactly one snapshot row");
  assert.equal(snap.results[0].total_usd, 117_000_000_000);
  assert.equal(snap.results[0].day, new Date().toISOString().slice(0, 10));

  // sink discovery: sink-dest got $15M from 5 distinct senders → candidate
  const cand = await w.DB.prepare(
    "SELECT address, type, label FROM wallets WHERE address = 'sink-dest-0000000000'"
  ).first();
  assert.ok(cand, "sink candidate row exists");
  assert.equal(cand.type, "exchange_candidate");
  assert.ok(cand.label.includes("5 senders"), cand.label);
});

test("daily jobs: KV markers gate them — the second run same day is a no-op", async () => {
  const w = await makeWorld();
  await seedSinkActivity(w);

  await runUntilJobsRan(w);
  // mutate the snapshot row so a second write would be visible
  await w.DB.prepare("UPDATE stablecoin_supply SET total_usd = 1").run();
  await w.harness.scheduled(scanner.default, Date.now() + 60_000, "* * * * *");

  const snap = await w.DB.prepare("SELECT total_usd FROM stablecoin_supply").all();
  assert.equal(snap.results.length, 1, "still one row — INSERT OR IGNORE did not double");
  assert.equal(snap.results[0].total_usd, 1, "value untouched — the daily job skipped via marker");
});

test("label map invalidation: promotions reach classification via labels:ver", async () => {
  const w = await makeWorld();
  for (let i = 0; i < 9; i++) {
    await w.DB.prepare(
      "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score) " +
      "VALUES ('btc', ?, ?, 'promoted-sink-000000', 60, 'BTC', 6000000, 'wallet_to_wallet', 800000, ?, 'skipped', 60)"
    ).bind(`promo-tx-${i}`, `promo-sender-${i}`, Date.now() - i * 3600_000).run();
  }
  // three corroborated scans promote the sink to type='exchange'
  for (let i = 0; i < 8; i++) {
    if (i > 0) await w.env.KV.delete("sinkscan:" + new Date().toISOString().slice(0, 10));
    await w.harness.scheduled(scanner.default, Date.now() + i * 60_000, "* * * * *");
    const cur = await w.DB.prepare("SELECT days_seen FROM wallets WHERE address = 'promoted-sink-000000'").first();
    if (cur && cur.days_seen >= 3) break;
  }

  // THE regression: the old loadLabelMap returned the frozen KV map forever —
  // a promotion never reached classification. The ver bump must force a reload.
  const map = await scanner.loadLabelMap(w.env);
  const entry = map.get("promoted-sink-000000");
  assert.ok(entry, "promoted sink appears in the label map");
  assert.equal(entry.type, "exchange", "map carries the promoted type");
});

test("daily jobs: sub-threshold sinks are NOT labeled", async () => {
  const w = await makeWorld();
  // only 2 distinct senders → below the 5-sender bar
  for (let i = 0; i < 2; i++) {
    await w.DB.prepare(
      "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score) " +
      "VALUES ('btc', ?, ?, 'small-dest-00000000', 30, 'BTC', 3000000, 'wallet_to_wallet', 800000, ?, 'skipped', 60)"
    ).bind(`small-tx-${i}`, `small-sender-${i}`, Date.now() - i * 3600_000).run();
  }
  await runUntilJobsRan(w);
  const cand = await w.DB.prepare(
    "SELECT type FROM wallets WHERE address = 'small-dest-00000000'"
  ).first();
  assert.equal(cand, null, "2 senders never reach exchange_candidate");
});

test("sink promotion: 3 corroborated scans + 8 senders + $50M earns type=exchange", async () => {
  const w = await makeWorld();
  // a sink with 9 distinct senders and $54M total in the 7d window
  for (let i = 0; i < 9; i++) {
    await w.DB.prepare(
      "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score) " +
      "VALUES ('btc', ?, ?, 'big-sink-0000000000', 60, 'BTC', 6000000, 'wallet_to_wallet', 800000, ?, 'skipped', 60)"
    ).bind(`big-tx-${i}`, `big-sender-${i}`, Date.now() - i * 3600_000).run();
  }

  // drive scheduled() until the sink has been corroborated 3 times
  let row = null;
  for (let i = 0; i < 8; i++) {
    if (i > 0) await w.env.KV.delete("sinkscan:" + new Date().toISOString().slice(0, 10));
    await w.harness.scheduled(scanner.default, Date.now() + i * 60_000, "* * * * *");
    row = await w.DB.prepare("SELECT type, days_seen FROM wallets WHERE address = 'big-sink-0000000000'").first();
    if (row && row.days_seen >= 3) break;
  }
  assert.ok(row, "sink candidate row exists");
  assert.equal(row.type, "exchange", "3 scans, 9 senders, $54M → promoted");
  assert.equal(row.days_seen, 3);
});

test("sink promotion: a 2-scan candidate with 6 senders stays a candidate", async () => {
  const w = await makeWorld();
  for (let i = 0; i < 6; i++) {
    await w.DB.prepare(
      "INSERT INTO whales (chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, detected_at, analysis_status, interesting_score) " +
      "VALUES ('btc', ?, ?, 'mid-sink-0000000000', 30, 'BTC', 2000000, 'wallet_to_wallet', 800000, ?, 'skipped', 60)"
    ).bind(`mid-tx-${i}`, `mid-sender-${i}`, Date.now() - i * 3600_000).run();
  }
  // three corroborated scans: days_seen reaches 3, but 6 senders < 8 → stays candidate
  for (let i = 0; i < 8; i++) {
    if (i > 0) await w.env.KV.delete("sinkscan:" + new Date().toISOString().slice(0, 10));
    await w.harness.scheduled(scanner.default, Date.now() + i * 60_000, "* * * * *");
    const cur = await w.DB.prepare("SELECT days_seen FROM wallets WHERE address = 'mid-sink-0000000000'").first();
    if (cur && cur.days_seen >= 3) break;
  }
  const row = await w.DB.prepare("SELECT type, days_seen FROM wallets WHERE address = 'mid-sink-0000000000'").first();
  assert.equal(row.type, "exchange_candidate", "6 senders / $12M never promotes");
  assert.equal(row.days_seen, 3);
});
