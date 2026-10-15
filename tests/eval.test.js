// tests/eval.test.js — prediction grading + leaderboard math.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { grade } from "../src/eval.js";

test("grade: bullish up beyond noise = hit", () => {
  assert.equal(grade("bullish", 0.5, 0.3), "hit");
  assert.equal(grade("bullish", -0.5, 0.3), "miss");
  assert.equal(grade("bearish", -0.5, 0.3), "hit");
  assert.equal(grade("bearish", 0.5, 0.3), "miss");
});

test("grade: inside noise band = flat", () => {
  assert.equal(grade("bullish", 0.2, 0.3), "flat");
  assert.equal(grade("bullish", -0.2, 0.3), "flat");
  assert.equal(grade("bearish", 0.1, 0.3), "flat");
});

test("grade: neutral is never scored", () => {
  assert.equal(grade("neutral", 5.0, 0.3), "flat");
  assert.equal(grade("neutral", -5.0, 0.3), "flat");
});

test("grade: boundary behavior", () => {
  assert.equal(grade("bullish", 0.3, 0.3), "hit");   // exactly at threshold counts
  assert.equal(grade("bullish", 0.299, 0.3), "flat");
});
