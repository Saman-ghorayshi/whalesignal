// tests/utils.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortAddr, buildWalletMap, labelFor, classifyTx, usdValue, fmtUSD, mdEscape, isBurnSink, ZERO_ADDRESS, fetchJSON } from "../src/worker-utils.js";

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

// ─── behavioral tx types: treasury / bridge / miner ───────────────────

test("classifyTx: treasury prints and burns outrank exchange logic", () => {
  assert.equal(classifyTx("treasury", null).tx_type, "mint");
  assert.equal(classifyTx(null, "treasury").tx_type, "burn");
  // even an exchange on the other side loses to the supply story
  assert.equal(classifyTx("treasury", "exchange").tx_type, "mint");
});

test("classifyTx: bridge and miner flows", () => {
  assert.equal(classifyTx("bridge", null).tx_type, "bridge_flow");
  assert.equal(classifyTx(null, "bridge").tx_type, "bridge_flow");
  assert.equal(classifyTx("miner", "exchange").tx_type, "miner_flow");

// ─── fetchJSON maxRawBytes guard ─────────────────────────────────────────
// The gzip trap: content-length measures the COMPRESSED size, so a "small"
// header can hide a huge decompressed body whose JSON.parse blows the
// free-tier CPU budget (exceededCpu, uncatchable — poison-pill stall).

function streamResponse(jsonText) {
  const bytes = new TextEncoder().encode(jsonText);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-length": String(bytes.length) } });
}

test("fetchJSON maxRawBytes: parses payloads under the raw-byte cap", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => streamResponse(JSON.stringify({ ok: true, n: 5 }));
  try {
    const j = await fetchJSON("https://mock.test/small", { maxRawBytes: 10_000 });
    assert.equal(j.ok, true);
    assert.equal(j.n, 5);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchJSON maxRawBytes: aborts with tooLarge on oversized bodies", async () => {
  const orig = globalThis.fetch;
  // 1MB of JSON that would parse fine — the cap exists to protect the CPU
  const big = JSON.stringify({ pad: "x".repeat(1_000_000) });
  globalThis.fetch = async () => streamResponse(big);
  try {
    await assert.rejects(
      fetchJSON("https://mock.test/big", { maxRawBytes: 600_000 }),
      (e) => e.tooLarge === true && /payload too large/.test(e.message)
    );
  } finally {
    globalThis.fetch = orig;
  }
});
  // exchange plumbing still wins when no behavioral label is present
  assert.equal(classifyTx(null, "exchange").tx_type, "exchange_inflow");
});

test("isBurnSink: zero address and dEaD variants, case-tolerant", () => {
  assert.equal(isBurnSink(ZERO_ADDRESS), true);
  assert.equal(isBurnSink("0x000000000000000000000000000000000000dEaD"), true);
  assert.equal(isBurnSink("0xdeadbeef00000000000000000000000000000999"), false);
  assert.equal(isBurnSink(""), false);
  assert.equal(isBurnSink(null), false);
});
