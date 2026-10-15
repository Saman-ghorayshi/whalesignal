// tests/adaptive.test.js — adaptive news polling: intervals, due logic, backoff.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { sourceInterval, dueSources } from "../src/news.js";

test("sourceInterval: fast outlets 2min, macro 15, Fed/SEC 60", () => {
  assert.equal(sourceInterval({ name: "coindesk", weight: 1.0 }), 2);
  assert.equal(sourceInterval({ name: "theblock", weight: 0.9 }), 2);
  assert.equal(sourceInterval({ name: "decrypt", weight: 0.8 }), 2);
  assert.equal(sourceInterval({ name: "ambcrypto", weight: 0.5 }), 10);
  assert.equal(sourceInterval({ name: "bbc_world", weight: 0.5, macro: true }), 15);
  assert.equal(sourceInterval({ name: "fed_press", weight: 0.8, macro: true }), 60);
  assert.equal(sourceInterval({ name: "sec_press", weight: 0.8, macro: true }), 60);
  assert.equal(sourceInterval({ name: "reddit_bitcoin", weight: 0.3 }), 15);
});

test("dueSources: fresh meta → nothing due; stale → due", () => {
  const now = Date.now();
  const meta = new Map([
    ["coindesk", { last_fetch: now - 60000, failures: 0 }],          // 1 min ago, interval 2 → not due
    ["theblock", { last_fetch: now - 180000, failures: 0 }],        // 3 min ago → due
    ["fed_press", { last_fetch: now - 30 * 60000, failures: 0 }],    // 30 min ago, interval 60 → not due
  ]);
  const due = dueSources(now, meta).map((s) => s.name);
  assert.ok(!due.includes("coindesk"), "coindesk not due");
  assert.ok(due.includes("theblock"), "theblock due");
  assert.ok(!due.includes("fed_press"), "fed_press not due");
});

test("dueSources: failures back off exponentially", () => {
  const now = Date.now();
  // 1 failure on a 2-min source → cooldown 4 min; fetched 3 min ago → not due
  const meta = new Map([
    ["coindesk", { last_fetch: now - 3 * 60000, failures: 1 }],
    // 3 failures → cooldown 16 min; fetched 10 min ago → not due
    ["decrypt", { last_fetch: now - 10 * 60000, failures: 3 }],
  ]);
  const due = dueSources(now, meta).map((s) => s.name);
  assert.ok(!due.includes("coindesk"), "1 failure backs off");
  assert.ok(!due.includes("decrypt"), "3 failures back off harder");
  // but after the cooldown passes, it's due again
  const later = new Map([
    ["coindesk", { last_fetch: now - 5 * 60000, failures: 1 }],
  ]);
  assert.ok(dueSources(now, later).map((s) => s.name).includes("coindesk"), "due after cooldown");
});

test("dueSources: unknown sources (no meta) are due immediately", () => {
  const due = dueSources(Date.now(), new Map()).map((s) => s.name);
  assert.ok(due.includes("coindesk"), "cold start fetches everything");
  assert.ok(due.length > 40, "all 47 sources due on cold start");
});
