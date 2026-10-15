// tests/pro.test.js — pro TA indicators + causal chain helpers.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { atr, vwap, stochRsi, obv, obvTrend, fibonacci, adx, volatilityRegime } from "../src/ta.js";
import { chainPromptBlock, formatChain } from "../src/causal.js";

function klines(n, start = 100, drift = 0.5, vol = 2) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += drift + (Math.sin(i * 1.7) * vol);
    out.push({ t: i * 3600000, o: p - 1, h: p + vol, l: p - vol, c: p, v: 1000 + i * 10 });
  }
  return out;
}

test("atr: positive and sane", () => {
  const a = atr(klines(60));
  assert.ok(a > 0 && a < 20, `atr=${a}`);
  assert.equal(atr(klines(5)), null, "too few → null");
});

test("vwap: near price on balanced data", () => {
  const k = klines(24);
  const v = vwap(k);
  const last = k[k.length - 1].c;
  assert.ok(Math.abs(v - last) / last < 0.15, `vwap=${v} last=${last}`);
});

test("stochRsi: 0-100 range", () => {
  const closes = klines(60).map((k) => k.c);
  const s = stochRsi(closes);
  assert.ok(s >= 0 && s <= 100, `stoch=${s}`);
});

test("obv: rises with rising prices", () => {
  const k = klines(40, 100, 1.5, 1);
  assert.ok(obv(k) > 0, "positive OBV on uptrend");
  assert.equal(obvTrend(k), "rising");
  const kd = klines(40, 100, -1.5, 1);
  assert.equal(obvTrend(kd), "falling");
});

test("fibonacci: levels ordered, position sane", () => {
  const f = fibonacci(klines(80));
  assert.ok(f && f.levels.length === 7, "7 fib levels");
  assert.ok(f.levels[0].price > f.levels[6].price, "descending from swing high");
  assert.ok(typeof f.position === "string");
});

test("adx: value 0-100 with direction", () => {
  const a = adx(klines(60, 100, 2, 1));
  assert.ok(a && a.value >= 0 && a.value <= 100, `adx=${JSON.stringify(a)}`);
  assert.ok(["up", "down"].includes(a.direction));
  // strong drift → high ADX
  assert.ok(a.value > 20, `trending market should show ADX>20, got ${a.value}`);
});

test("volatilityRegime: buckets", () => {
  const v = volatilityRegime(klines(90));
  assert.ok(v && ["high_vol", "low_vol", "normal_vol"].includes(v.regime));
  assert.ok(v.percentile >= 0 && v.percentile <= 1);
});

test("causal: prompt block + telegram format", () => {
  const chain = [
    { t: 1000, kind: "news", icon: "📰", text: "SEC sues exchange" },
    { t: 2000, kind: "whale", icon: "🐋", text: "Whale moved 100 BTC" },
  ];
  const pb = chainPromptBlock(chain);
  assert.ok(pb.includes("CAUSAL EVIDENCE CHAIN"), "prompt header");
  assert.ok(pb.includes("A → B → C"), "causal instruction");
  const fb = formatChain(chain);
  assert.ok(fb.includes("⛓ What led here:"), "telegram header");
  assert.ok(fb.includes("SEC sues exchange"), "news link shown");
  assert.equal(chainPromptBlock([]), "", "empty → empty");
  assert.equal(formatChain(null), "", "null → empty");
});
