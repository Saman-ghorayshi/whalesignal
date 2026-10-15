// tests/utils.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortAddr, buildWalletMap, labelFor, classifyTx, usdValue, fmtUSD, mdEscape, truncateTelegram, sanitizeAIText, secretsEqual, checkRateLimit, TG_SAFE_MAX_LEN } from "../src/worker-utils.js";

// in-memory KV stub for checkRateLimit tests
function stubKV(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => { map.set(k, v); },
    _map: map,
  };
}

test("shortAddr truncates long evm addrs", () => {
  // head=6, tail=4 -> "0x28C6" + "..." + "23e4"
  assert.equal(shortAddr("0x28C6c06298d514De13C02684fa65b7c0c1F723e4"), "0x28C6...23e4");
  assert.equal(shortAddr("0x12"), "0x12"); // can't truncate
  assert.equal(shortAddr(""), "");
});

test("buildWalletMap dedupes by lowercase for evm", () => {
  const rows = [
    { address: "0xAAA", label: "A", type: "exchange", chain: "eth" },
    { address: "0xaaa", label: "A", type: "exchange", chain: "eth" }, // dup
    { address: "34xpQkNgof", label: "Btc1", type: "exchange", chain: "btc" },
  ];
  const m = buildWalletMap(rows);
  // exact + lowercased both present
  assert.equal(m.get("0xaaa")?.label, "A");
  assert.equal(m.get("0xAAA")?.label, "A");
  assert.equal(m.get("34xpQkNgof")?.label, "Btc1");
});

test("labelFor looks up via the map (case-insensitive for evm)", () => {
  const m = buildWalletMap([{ address: "0xDeadBeef", label: "X", type: "exchange", chain: "eth" }]);
  assert.equal(labelFor("0xdeadbeef", m), "X"); // lowercase lookup
  assert.equal(labelFor("0xDeadBeef", m), "X"); // exact lookup
  assert.equal(labelFor("0xOther", m), null);
  assert.equal(labelFor("", m), null);
});

test("classifyTx pairs from/to exchange types correctly", () => {
  assert.equal(classifyTx(null, "exchange").tx_type, "exchange_inflow");
  assert.equal(classifyTx("exchange", null).tx_type, "exchange_outflow");
  assert.equal(classifyTx("exchange", "exchange").tx_type, "exchange_internal");
  assert.equal(classifyTx(null, null).tx_type, "wallet_to_wallet");
});

test("usdValue uses cached price, returns NaN when price missing", () => {
  const market = { btc: { price: 100 }, usdt: { price: 1 } };
  assert.equal(usdValue(5, "BTC", market), 500);
  assert.equal(usdValue(10_000_000, "USDT", market), 10_000_000);
  assert.ok(Number.isNaN(usdValue(5, "ETH", market)), "eth price missing => NaN");
  assert.ok(Number.isNaN(usdValue(5, "BTC", null)));
});

test("fmtUSD handles K/M/B", () => {
  assert.equal(fmtUSD(1_500), "$1.5K");
  assert.equal(fmtUSD(33_500_000), "$33.50M");
  assert.equal(fmtUSD(1_200_000_000), "$1.20B");
  assert.equal(fmtUSD(NaN), "—");
  assert.equal(fmtUSD(null), "—");
});

test("mdEscape escapes asterisks/underscores for telegram markdown", () => {
  assert.equal(mdEscape("hello *world*"), "hello \\*world\\*");
  assert.equal(mdEscape("a_b_c"), "a\\_b\\_c");
  assert.equal(mdEscape(null), "");
});

// ─── truncateTelegram (BT4) ────────────────────────────────────────────

test("truncateTelegram leaves short text untouched", () => {
  assert.equal(truncateTelegram("hello"), "hello");
  assert.equal(truncateTelegram("a".repeat(TG_SAFE_MAX_LEN)).length, TG_SAFE_MAX_LEN);
});

test("truncateTelegram caps long text under the 4096 Telegram limit", () => {
  const out = truncateTelegram("a".repeat(5000));
  assert.ok(out.length < 4096, `got ${out.length}`);
  assert.match(out, /…\(truncated\)$/);
  assert.equal(out.slice(0, TG_SAFE_MAX_LEN), "a".repeat(TG_SAFE_MAX_LEN));
});

test("truncateTelegram is code-point-safe: never splits emoji", () => {
  const out = truncateTelegram("🐋".repeat(5000));
  // 4000 whole emoji + marker, no lone surrogates
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "no split surrogate pair");
  assert.equal(Array.from(out.replace(/\n…\(truncated\)$/, "")).length, TG_SAFE_MAX_LEN);
});

test("truncateTelegram handles null/undefined", () => {
  assert.equal(truncateTelegram(null), "");
  assert.equal(truncateTelegram(undefined), "");
});

// ─── sanitizeAIText (S2) ──────────────────────────────────────────────

test("sanitizeAIText strips control characters but keeps newlines/tabs", () => {
  assert.equal(sanitizeAIText("a\x00b\x01c\x1Fd"), "abcd");
  assert.equal(sanitizeAIText("line1\nline2\tindented"), "line1\nline2\tindented");
  assert.equal(sanitizeAIText(null), "");
});

test("sanitizeAIText truncates with an ellipsis", () => {
  const out = sanitizeAIText("x".repeat(5000), 200);
  assert.equal(out.length, 201); // 200 + "…"
  assert.match(out, /…$/);
});

// ─── secretsEqual ─────────────────────────────────────────────────────

test("secretsEqual compares in constant time", () => {
  assert.equal(secretsEqual("abc123", "abc123"), true);
  assert.equal(secretsEqual("abc123", "abc124"), false);
  assert.equal(secretsEqual("abc", "abcd"), false); // length differs
  assert.equal(secretsEqual(null, "abc"), false);
  assert.equal(secretsEqual("abc", null), false);
});

// ─── checkRateLimit (BT10) ────────────────────────────────────────────

test("checkRateLimit allows maxHits then denies within the window", async () => {
  const env = { KV: stubKV() };
  for (let i = 0; i < 10; i++) {
    const r = await checkRateLimit(env, "t", 10, 60);
    assert.equal(r.ok, true, `hit ${i + 1} should pass`);
  }
  const denied = await checkRateLimit(env, "t", 10, 60);
  assert.equal(denied.ok, false);
  assert.equal(denied.limited, true);
  assert.ok(denied.retryAfterSec >= 1);
});

test("checkRateLimit buckets are independent per key", async () => {
  const env = { KV: stubKV() };
  for (let i = 0; i < 10; i++) await checkRateLimit(env, "a", 10, 60);
  assert.equal((await checkRateLimit(env, "a", 10, 60)).ok, false);
  assert.equal((await checkRateLimit(env, "b", 10, 60)).ok, true);
});

test("checkRateLimit works without KV (in-memory)", async () => {
  // In-memory rate limiting doesn't need KV — always works
  const key = "nokv-" + Date.now();
  const r = await checkRateLimit({}, key, 1, 60);
  assert.equal(r.ok, true);
  assert.equal(r.limited, false);
  // Second hit should be limited
  const r2 = await checkRateLimit({}, key, 1, 60);
  assert.equal(r2.limited, true);
});

test("checkRateLimit resets after the window passes", async () => {
  const env = {};
  const key = "w-" + Date.now(); // unique to avoid cross-test pollution
  await checkRateLimit(env, key, 1, 60);
  assert.equal((await checkRateLimit(env, key, 1, 60)).ok, false);
  // In-memory store: use a 0-second window for immediate reset test
  const key2 = "w2-" + Date.now();
  await checkRateLimit(env, key2, 1, 0);
  // Window of 0 seconds means immediate expiry on next call
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await checkRateLimit(env, key2, 1, 0)).ok, true);
});
