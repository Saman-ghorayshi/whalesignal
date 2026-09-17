// tests/sources.test.js — multi-source price parsers, consensus rule,
// RSS rotation, and the mempool.space block normalizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SPOT_SOURCES, pickConsensusPrice, rssStartIndex, normalizeMempoolBlock } from "../src/scanner.js";

const byName = (n) => SPOT_SOURCES.find((s) => s.name === n);

test("spot parsers: each source's real response shape", () => {
  const coinbase = byName("coinbase").parse({ data: { amount: "60123.45" } });
  assert.equal(coinbase, 60123.45);
  const kraken = byName("kraken").parse({ result: { XXBTZUSD: { c: ["60100.00000", "1.0"] } } });
  assert.equal(kraken, 60100);
  const bitstamp = byName("bitstamp").parse({ last: "60150.5" });
  assert.equal(bitstamp, 60150.5);
  const okx = byName("okx").parse({ data: [{ last: "60190.2" }] });
  assert.equal(okx, 60190.2);
  // garbage → null (never NaN into usd_value)
  assert.equal(byName("coinbase").parse({}), null);
  assert.equal(byName("kraken").parse({ error: [] }), null);
});

test("pickConsensusPrice: median is outlier-resistant, agreement is strict", () => {
  // one glitched feed among healthy ones → median ignores it
  const c1 = pickConsensusPrice([60_100, 60_200, 95_000]);
  assert.equal(c1.price, 60_200);
  assert.equal(c1.agreed, false, "the 58% outlier must flag disagreement");
  assert.equal(c1.sources, 3);
  // tight cluster → agreed
  const c2 = pickConsensusPrice([60_100, 60_150, 60_120]);
  assert.equal(c2.agreed, true);
  assert.equal(c2.price, 60_120);
  // single source → price without agreement claim
  const c3 = pickConsensusPrice([60_100]);
  assert.equal(c3.price, 60_100);
  assert.equal(c3.agreed, false);
  assert.deepEqual(pickConsensusPrice([]), { price: null, sources: 0, agreed: false });
});

test("rssStartIndex: rotates every 5-minute slot across all feeds", () => {
  const n = 5;
  const t0 = 1_700_000_000_000;
  const a = rssStartIndex(t0, n);
  const b = rssStartIndex(t0 + 300_000, n);
  assert.equal((b - a + n) % n, 1 % n, "advances one slot per refresh window");
  assert.equal(rssStartIndex(t0, 0), 0);
  assert.ok(rssStartIndex(t0, n) >= 0 && rssStartIndex(t0, n) < n);
});

test("normalizeMempoolBlock: satoshi values kept, shape matches extractCandidatesBTC", () => {
  const blk = normalizeMempoolBlock(850_000, [{
    txid: "abc",
    vin: [{ prevout: { scriptpubkey_address: "1Sender", value: 1_000 } }],
    vout: [
      { scriptpubkey_address: "1Sender", value: 400 },
      { scriptpubkey_address: "1Dest", value: 600 },
    ],
  }]);
  assert.equal(blk.height, 850_000);
  assert.equal(blk.tx[0].hash, "abc");
  assert.equal(blk.tx[0].inputs[0].prev_out.addr, "1Sender");
  assert.equal(blk.tx[0].out[1].addr, "1Dest");
  assert.equal(blk.tx[0].out[1].value, 600, "mempool values are sats — no ×1e8");
});

// ─── GDELT parser + co-spend clustering (sprint 5g) ──────────────────
import { parseGdeltTitles } from "../src/scanner.js";
import { coSpendsFromTxs } from "../tools/laptop/cluster.mjs";

test("parseGdeltTitles: artlist shape, tolerant of garbage", () => {
  const j = { articles: [{ title: "Bitcoin ETF inflows resume" }, { url: "no title" }, { title: "Ethereum staking surges" }] };
  assert.equal(parseGdeltTitles(j).length, 2);
  assert.deepEqual(parseGdeltTitles({}), []);
  assert.deepEqual(parseGdeltTitles(null), []);
});

test("coSpendsFromTxs: common-input-ownership heuristic", () => {
  const seed = "1Exchange";
  const txs = [
    { vin: [{ prevout: { scriptpubkey_address: seed } }, { prevout: { scriptpubkey_address: "1Hot2" } }] },
    { vin: [{ prevout: { scriptpubkey_address: seed } }, { prevout: { scriptpubkey_address: "1Hot2" } }, { prevout: { scriptpubkey_address: "1Hot3" } }] },
    { vin: [{ prevout: { scriptpubkey_address: "1Other" } }] },
  ];
  const counts = coSpendsFromTxs(txs, seed);
  assert.equal(counts.get("1Hot2"), 2);
  assert.equal(counts.get("1Hot3"), 1);
  assert.equal(counts.get("1Other"), undefined);
});
