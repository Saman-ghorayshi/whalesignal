// tests/content.test.js — content brief generator (anti-slop checks).
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildContentBrief } from "../src/content.js";

const WHALE = {
  id: 999,
  symbol: "BTC",
  usd_value: 25000000,
  from_address: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  to_address: "3PjLeqpPTq93g6driXvBdMTmBgb7Fm4D9h",
  from_label: "Unknown Whale",
  to_label: "Binance",
  tx_type: "exchange_inflow",
  motive: "distribution",
};
const ANALYSIS = { motive: "distribution", signal: "bearish", confidence: 0.78 };

test("buildContentBrief: has all parts, no slop markers", () => {
  const b = buildContentBrief(WHALE, ANALYSIS);
  assert.ok(b.hook, "hook exists");
  assert.ok(b.script, "script exists");
  assert.ok(b.caption, "caption exists");
  assert.ok(b.hashtags, "hashtags exist");
  // hook is short and punchy
  assert.ok(b.hook.length < 80, "hook under 80 chars");
  assert.ok(b.hook.includes("$25.00M"), "hook has the money");
  // script is spoken language, not robot
  assert.ok(!b.script.includes("Hey guys welcome back"), "no youtuber slop");
  assert.ok(!b.script.toLowerCase().includes("as an ai"), "no AI self-reference");
  assert.ok(b.script.includes("Binance"), "uses real labels");
  // has a take, not just data
  assert.ok(b.script.length > 100, "script has substance");
});

test("buildContentBrief: works without analysis", () => {
  const b = buildContentBrief({ ...WHALE, from_label: null, to_label: null }, null);
  assert.ok(b.script.includes("bc1qxy"), "falls back to short address");
  assert.ok(b.meta.signal === "neutral", "defaults to neutral");
});

test("buildContentBrief: caption has CTA and disclaimer", () => {
  const b = buildContentBrief(WHALE, ANALYSIS);
  assert.ok(b.caption.includes("Not financial advice"), "has disclaimer");
  assert.ok(b.caption.includes("Follow"), "has CTA");
});
