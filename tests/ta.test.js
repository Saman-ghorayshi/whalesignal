// tests/ta.test.js — technical analysis indicators + snapshot + chart URL.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { sma, ema, rsi, macd, bollinger, volumeZ, getMarketSnapshot, summarizeTA, buildChartUrl } from "../src/ta.js";

// deterministic pseudo-random walk for indicator tests
function walk(n, start = 100, drift = 0.1, seed = 42) {
  let s = seed, out = [start];
  for (let i = 1; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(out[i - 1] + drift + ((s / 2147483648) - 0.5) * 4);
  }
  return out;
}

test("sma/ema: basic averages", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2], 5), null, "not enough data → null");
  const e = ema([10, 10, 10, 10, 10], 3);
  assert.ok(Math.abs(e - 10) < 1e-9, "flat series → flat ema");
});

test("rsi: all gains → 100, all losses → 0", () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(rsi(up), 100);
  assert.equal(rsi(down), 0);
  assert.equal(rsi([1, 2], 14), null, "too short → null");
});

test("rsi: mixed series lands mid-range", () => {
  const mixed = walk(30, 100, 0, 7);
  const v = rsi(mixed);
  assert.ok(v > 20 && v < 80, `rsi ${v} should be mid-range for driftless walk`);
});

test("macd: returns hist with correct sign on accelerating trend", () => {
  // accelerating uptrend (drift increases) → momentum rising → hist > 0
  const accel = [];
  let p = 100;
  for (let i = 0; i < 70; i++) { p += 0.2 + i * 0.02; accel.push(p); }
  const m = macd(accel);
  assert.ok(m && typeof m.hist === "number", "macd object");
  assert.ok(m.hist > 0, `accelerating uptrend → positive histogram (got ${m.hist})`);
  assert.equal(macd([1, 2, 3], 12, 26, 9), null, "too short → null");
});

test("bollinger: bands ordered, pctB sane", () => {
  const c = walk(40, 100, 0, 11);
  const b = bollinger(c);
  assert.ok(b.lower < b.mid && b.mid < b.upper, "bands ordered");
  // %B can exceed [0,1] on band breaks — that's the signal, not a bug.
  assert.ok(b.pctB > -1 && b.pctB < 2, `pctB ${b.pctB} sane`);
  // price above upper band → %B > 1
  const brk = [...walk(40, 100, 0, 11)];
  brk.push(brk[brk.length - 1] + 50);
  assert.ok(bollinger(brk).pctB > 1, "breakout → %B > 1");
});

test("volumeZ: spike detected", () => {
  const vols = new Array(20).fill(100);
  vols.push(500); // 5x spike on the last bar
  const z = volumeZ(vols);
  assert.ok(z > 2, `volume spike z=${z} should exceed 2`);
});

test("getMarketSnapshot: builds from injected klines", async () => {
  const closes = walk(100, 80000, 5, 5);
  const klines = closes.map((c, i) => ({
    t: 1792000000000 + i * 3600000, o: c, h: c + 50, l: c - 50, c, v: 10,
  }));
  const snap = await getMarketSnapshot("BTC", { fetchFn: async () => klines });
  assert.equal(snap.symbol, "BTC");
  assert.ok(snap.price > 0, "price set");
  assert.ok(snap.rsi14 >= 0 && snap.rsi14 <= 100, "rsi in range");
  assert.ok(["uptrend", "downtrend", "sideways", "unknown"].includes(snap.trend), "trend label");
  assert.equal(snap.series.length, 48, "48-point chart series");
  assert.ok(snap.volume24hUsd > 0, "24h volume estimated");
  const summary = summarizeTA(snap);
  assert.ok(summary.includes("RSI"), "summary mentions RSI");
});

test("getMarketSnapshot: null when klines unavailable", async () => {
  const snap = await getMarketSnapshot("BTC", { fetchFn: async () => { throw new Error("nope"); } });
  assert.equal(snap, null);
});

test("buildChartUrl: valid quickchart URL with whale marker", async () => {
  const closes = walk(60, 80000, 0, 9);
  const series = closes.map((c, i) => ({ t: 1792000000000 + i * 3600000, c }));
  const url = buildChartUrl("BTC", series, { t: series[30].t, usd: 25_000_000 });
  assert.ok(url.startsWith("https://quickchart.io/chart?c="), "quickchart URL");
  assert.ok(url.includes("whale"), "whale marker dataset present");
  assert.ok(url.length < 8000, "URL stays emailable");
  assert.equal(buildChartUrl("BTC", [{ t: 1, c: 1 }], null), null, "too short → null");
});
