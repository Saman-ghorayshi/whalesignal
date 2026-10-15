// tests/tron.test.js — TRON (USDT) scanner: parsing + live API.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { extractCandidatesTRON, fetchTronEvents } from "../src/scanner.js";

test("extractCandidatesTRON: parses Transfer events, 6 decimals", () => {
  const events = [
    {
      transaction_id: "abc123",
      block_number: 87139401,
      block_timestamp: 1792086000000,
      result: {
        from: "0x65e20e3af3",
        to: "0xea6a7de095",
        value: "2500000000", // 2500 USDT
      },
    },
    {
      transaction_id: "def456",
      block_number: 87139402,
      block_timestamp: 1792086003000,
      result: { from: "0xAAA", to: "0xAAA", value: "100000000" }, // self, 100 USDT
    },
    {
      transaction_id: "bad1",
      result: { from: "0x1", to: "0x2" }, // no value → skipped
    },
  ];
  const out = extractCandidatesTRON(events);
  assert.equal(out.length, 2);
  assert.equal(out[0].chain, "tron");
  assert.equal(out[0].symbol, "USDT");
  assert.equal(out[0].amount, 2500);
  assert.equal(out[0].usd_value, 2500);
  assert.equal(out[0].is_self_transfer, false);
  assert.equal(out[1].is_self_transfer, true);
  assert.ok(out[0].from_address.startsWith("0x"), "hex address kept");
});

test("extractCandidatesTRON: empty/null safe", () => {
  assert.deepEqual(extractCandidatesTRON([]), []);
  assert.deepEqual(extractCandidatesTRON(null), []);
  assert.deepEqual(extractCandidatesTRON([{ result: {} }]), []);
});

// Live test: hits the real TronGrid API. Skipped gracefully if offline.
test("fetchTronEvents: live TronGrid returns Transfer events", async (t) => {
  let events;
  try {
    events = await fetchTronEvents(Date.now() - 600000, 5);
  } catch (e) {
    t.skip(`TronGrid unreachable: ${e.message}`);
    return;
  }
  assert.ok(Array.isArray(events), "array returned");
  assert.ok(events.length > 0, "at least one recent event");
  const e = events[0];
  assert.ok(e.transaction_id, "has transaction_id");
  assert.ok(e.result && e.result.from && e.result.to, "has from/to");
  assert.ok(e.block_timestamp > Date.now() - 3600000, "recent timestamp");
  // end-to-end parse of live data
  const parsed = extractCandidatesTRON(events);
  assert.ok(parsed.length > 0, "live events parse to candidates");
  assert.ok(parsed.every((c) => c.chain === "tron" && c.symbol === "USDT"));
});
