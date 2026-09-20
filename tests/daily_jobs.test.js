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

  await w.harness.scheduled(scanner.default, Date.now(), "* * * * *");

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

  await w.harness.scheduled(scanner.default, Date.now(), "* * * * *");
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
  for (let run = 0; run < 3; run++) {
    if (run > 0) await w.env.KV.delete("sinkscan:" + new Date().toISOString().slice(0, 10));
    await w.harness.scheduled(scanner.default, Date.now() + run * 60_000, "* * * * *");
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
  await w.harness.scheduled(scanner.default, Date.now(), "* * * * *");
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

  // scan 1: candidate, display-only
  await w.harness.scheduled(scanner.default, Date.now(), "* * * * *");
  let row = await w.DB.prepare("SELECT type, days_seen FROM wallets WHERE address = 'big-sink-0000000000'").first();
  assert.equal(row.type, "exchange_candidate", "scan 1 → candidate only");
  assert.equal(row.days_seen, 1);

  // scan 2: corroborated once (marker removed → job runs again)
  await w.env.KV.delete("sinkscan:" + new Date().toISOString().slice(0, 10));
  await w.harness.scheduled(scanner.default, Date.now() + 60_000, "* * * * *");
  row = await w.DB.prepare("SELECT type, days_seen FROM wallets WHERE address = 'big-sink-0000000000'").first();
  assert.equal(row.type, "exchange_candidate", "scan 2 → still display-only");
  assert.equal(row.days_seen, 2);

  // scan 3: the third corroboration crosses every bar → PROMOTED
  await w.env.KV.delete("sinkscan:" + new Date().toISOString().slice(0, 10));
  await w.harness.scheduled(scanner.default, Date.now() + 120_000, "* * * * *");
  row = await w.DB.prepare("SELECT type, days_seen FROM wallets WHERE address = 'big-sink-0000000000'").first();
  assert.equal(row.type, "exchange", "scan 3 → promoted: 3 scans, 9 senders, $54M");
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
  // pretend two earlier scans already corroborated it
  await w.harness.scheduled(scanner.default, Date.now(), "* * * * *");
  await w.env.KV.delete("sinkscan:" + new Date().toISOString().slice(0, 10));
  await w.harness.scheduled(scanner.default, Date.now() + 60_000, "* * * * *");
  // third scan: days_seen reaches 3, but 6 senders < 8 → stays candidate
  await w.env.KV.delete("sinkscan:" + new Date().toISOString().slice(0, 10));
  await w.harness.scheduled(scanner.default, Date.now() + 120_000, "* * * * *");
  const row = await w.DB.prepare("SELECT type, days_seen FROM wallets WHERE address = 'mid-sink-0000000000'").first();
  assert.equal(row.type, "exchange_candidate", "6 senders / $12M never promotes");
  assert.equal(row.days_seen, 3);
});
