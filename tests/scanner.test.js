// tests/scanner.test.js
// Tests the pure candidate-extraction and filtering functions of the scanner.
// Does NOT test fetchBlock() or fetchLatestBlockHeight() — those hit the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidatesBTC, extractCandidatesETH, extractERC20Candidates, filterWhales, classifyWhales, statTargets, computeInterestingness, SCORE_THRESHOLD, hexToAmount, parseEnvInt, fetchBlock, fetchLatestBlockHeight, scanChain } from "../src/scanner.js";
import { buildWalletMap } from "../src/worker-utils.js";

const MARKET = {
  btc: { price: 60_000, change_24h: -2.1 },
  eth: { price: 3_000, change_24h: 1.2 },
  usdt: { price: 1 }, usdc: { price: 1 }, dai: { price: 1 },
  wbtc: { price: 60_000 },
};

test("extractCandidatesBTC uses net outflow and largest input as from", () => {
  // blockchain.info amounts are in SATOSHIS. 1 BTC = 1e8 sat.
  const block = {
    height: 850_000,
    time: 1_700_000_000,
    tx: [
      {
        hash: "aaa",
        inputs: [{ prev_out: { addr: "sender1", value: 5_000_000_000 } }],
        out: [{ addr: "recipient1", value: 5_000_000_000 }], // 50 BTC -> $3M
      },
      {
        hash: "bbb",
        inputs: [
          { prev_out: { addr: "sender2", value: 60_000_000_000 } },
          { prev_out: { addr: "sender3", value: 40_000_000_000 } },
        ],
        out: [
          { addr: "intermediate", value: 50_000_000_000 },
          { addr: "final",        value: 50_000_000_000 },
        ], // net outflow = 1000 BTC -> $60M
      },
    ],
  };
  const out = extractCandidatesBTC(block, MARKET);
  assert.equal(out.length, 2);

  // first tx: 5e9 sat = 50 BTC × $60K = $3,000,000
  assert.equal(out[0].tx_hash, "aaa");
  assert.equal(out[0].from_address, "sender1");
  assert.equal(out[0].to_address, "recipient1");
  assert.equal(out[0].amount, 50);
  assert.equal(out[0].usd_value, 3_000_000);
  assert.equal(out[0].symbol, "BTC");
  assert.equal(out[0].is_self_transfer, 0);

  // second: net outflow 100e9 sat = 1000 BTC × $60K = $60M
  assert.equal(out[1].tx_hash, "bbb");
  assert.equal(out[1].from_address, "sender2"); // largest input
  assert.equal(out[1].to_address, "intermediate"); // largest external output (tie -> first)
  assert.equal(out[1].amount, 1000);
  assert.equal(out[1].usd_value, 60_000_000);
});

test("extractCandidatesBTC excludes change outputs from amount and to_address", () => {
  // The S3 regression test: a 1000-BTC wallet paying 100 BTC must NOT be
  // recorded as a 1000-BTC whale transfer to its own change address.
  const block = {
    height: 850_001,
    time: 1_700_000_001,
    tx: [
      {
        hash: "ccc",
        inputs: [{ prev_out: { addr: "whale1", value: 100_000_000_000 } }], // 1000 BTC in
        out: [
          { addr: "recipient9", value: 10_000_000_000 },   // 100 BTC real payment
          { addr: "whale1", value: 899_990_000_000 },      // ~900 BTC change back
        ],
      },
    ],
  };
  const out = extractCandidatesBTC(block, MARKET);
  assert.equal(out.length, 1);
  assert.equal(out[0].amount, 100); // NOT 1000 — change excluded
  assert.equal(out[0].to_address, "recipient9"); // NOT the change address
  assert.equal(out[0].from_address, "whale1");
  assert.equal(out[0].is_self_transfer, 0);
});

test("extractCandidatesBTC flags all-change consolidations as self transfers", () => {
  const block = {
    height: 850_002,
    time: 1_700_000_002,
    tx: [
      {
        hash: "ddd",
        inputs: [{ prev_out: { addr: "cold1", value: 100_000_000_000 } }],
        out: [{ addr: "cold1", value: 99_999_000_000 }], // all change
      },
    ],
  };
  const out = extractCandidatesBTC(block, MARKET);
  assert.equal(out.length, 1);
  assert.equal(out[0].is_self_transfer, 1);
  assert.equal(out[0].to_address, "");
  assert.equal(out[0].amount, 1000); // falls back to input total, flagged
});

test("extractCandidatesBTC skips coinbase txs (no real sender)", () => {
  const block = {
    height: 850_003,
    time: 1_700_000_003,
    tx: [
      {
        hash: "coinbase1",
        inputs: [{ coinbase: "04ffff001d020f" }], // no prev_out
        out: [{ addr: "miner1", value: 312_500_000 }], // 3.125 BTC reward
      },
    ],
  };
  assert.equal(extractCandidatesBTC(block, MARKET).length, 0);
});

test("extractCandidatesBTC with missing inputs/out skips gracefully", () => {
  assert.equal(extractCandidatesBTC({}, MARKET).length, 0);
  assert.equal(extractCandidatesBTC({ tx: [] }, MARKET).length, 0);
  assert.equal(extractCandidatesBTC({ tx: [{ hash: "x" }] }, MARKET).length, 0); // missing out
  assert.equal(extractCandidatesBTC({ tx: [{ out: [{ addr: "r", value: 100 }] }] }, MARKET).length, 0); // missing hash
});

test("extractCandidatesETH converts hex wei to decimal eth", () => {
  // 3 ETH -> $9000 with MARKET
  const block = {
    number: "0x64",
    timestamp: "0x650a800",
    transactions: [
      {
        hash: "0xTX1",
        value: "0x29a2241af62c0000", // 3 ETH
        from: "0xaaa",
        to: "0xbbb",
      },
      {
        hash: "0xTX2",
        value: "0x0", // zero — should be skipped
        from: "0xf00",
        to: "0xbaa",
      },
      "0xJustHash", // bare strings get skipped because not full tx objects
    ],
  };
  const out = extractCandidatesETH(block, MARKET);
  assert.equal(out.length, 1);
  assert.equal(out[0].tx_hash, "0xTX1");
  assert.equal(out[0].amount, 3);
  assert.equal(out[0].usd_value, 9000);
  assert.equal(out[0].block_number, 100); // 0x64 = 100
});

test("extractERC20Candidates pulls USDT transfer amounts with decimals=6", () => {
  // USDT 6 decimals: 12_500_000 raw = 12.5 USDT = $12.5 (price 1)
  const logs = [    {
      address: "0xdAc17F958D2ee523a2206206994597C13D831ec7", // USDT (any case)
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000000aaa111aaa111aaa111aaa111aaa111aaa111aaa1", // from (last 20 hex)
        "0x0000000000000000000000000bbb222bbb222bbb222bbb222bbb222bbb222bbb2", // to
      ],
      data: "0x" + (12_500_000).toString(16),
      transactionHash: "0xLOGTX1",
      blockNumber: "0x64",
    },
    {
      // unknown token — should be skipped
      address: "0x0123456789abcdef0123456789abcdef01234567",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x" + "a".repeat(64),
        "0x" + "b".repeat(64),
      ],
      data: "0x" + (1000).toString(16),
      transactionHash: "0xLOGTX2",
      blockNumber: "0x64",
    },
    { topics: [], data: "0x0", transactionHash: "0xBADLOG" }, // malformed
  ];
  const out = extractERC20Candidates(logs, MARKET);
  assert.equal(out.length, 1);
  assert.equal(out[0].tx_hash, "0xLOGTX1");
  assert.equal(out[0].symbol, "USDT");
  assert.equal(out[0].amount, 12.5);
  assert.equal(out[0].usd_value, 12.5);
});

test("filterWhales keeps only txs above MIN_USD", () => {
  const cands = [
    { tx_hash: "x1", symbol: "BTC", usd_value: 100_000 },
    { tx_hash: "x2", symbol: "ETH", usd_value: 1_000_000 },
    { tx_hash: "x3", symbol: "USDT", usd_value: 600_000 },
    { tx_hash: "x4", symbol: "ETH", usd_value: NaN },
  ];
  const big = filterWhales(cands, 500_000);
  assert.deepEqual(big.map((b) => b.tx_hash), ["x2", "x3"]);
});

test("classifyWhales stamps tx_type using lowercase evm labels", () => {
  const cands = [
    { tx_hash: "txA", chain: "eth", from_address: "0xNORM", to_address: "0xANDEX" },
    { tx_hash: "txB", chain: "eth", from_address: "0xDISTRIB", to_address: "0xGENESIS" }, // wallet-to-wallet
  ];
  const wallets = buildWalletMap([
    { address: "0xandex", label: "Binance: Hot Wallet 14", type: "exchange", chain: "eth" },
  ]);
  const out = classifyWhales(cands, wallets);
  assert.equal(out[0].tx_type, "exchange_inflow");
  assert.equal(out[1].tx_type, "wallet_to_wallet");
});

test("statTargets skips exchange-address stat bumps (fix: don't make Binance look like a whale)", () => {
  // both sides non-exchange -> both targets
  assert.deepEqual(statTargets("0xALICE", "0xBOB", null, null), ["0xALICE", "0xBOB"]);
  // to_address is exchange -> only `from` bumped
  assert.deepEqual(statTargets("0xWHALE", "0xBINANCE", null, "exchange"), ["0xWHALE"]);
  // from_address is exchange -> only `to` bumped
  assert.deepEqual(statTargets("0xBINANCE", "0xCOLD", "exchange", null), ["0xCOLD"]);
  // both exchange (exchange_internal) -> nobody bumped
  assert.deepEqual(statTargets("0xBINANCE", "0xOKX", "exchange", "exchange"), []);
  // self-send (same addr on both sides) -> dedup, only one bump if not exchange
  assert.deepEqual(statTargets("0xSELF", "0xSELF", null, null), ["0xSELF"]);
  // self-send to exchange address -> empty (we counted as exchange for the to check too)
  assert.deepEqual(statTargets("0xSELF", "0xSELF", "exchange", "exchange"), []);
  // empty from address -> skipped
  assert.deepEqual(statTargets("", "0xBOB", null, null), ["0xBOB"]);
});

// ─── filterNewsKeywords (Phase 3a / whale-reasoning Plan Ladder A) ─────────
// Pure keyword filter over CryptoPanic items. Mirrors NEWS_KEYWORDS in
// scanner.js — if that regex changes those tests must too (intentional).
import { filterNewsKeywords } from "../src/scanner.js";

test("filterNewsKeywords keeps only titles matching the asset word list", () => {
  const items = [
    { title: "Binance pauses ETH withdrawals amid market panic" },        // binance ✓
    { title: "Beautiful sunset over the beach today" },                    // ✗ no kw
    { title: "SEC charges Coinbase with operating unregistered exchange" },// sec+coinbase ✓
    { title: "Recipe of the week: avocado toast" },                         // ✗
    { title: "USDT depeg rumor surfaces on Crypto Twitter" },              // usdt+depeg ✓
    { title: "Bitcoin halving approaches, miners prep" },                  // halving ✓
    { title: "ETF inflows hit record high" },                              // etf ✓
  ];
  const out = filterNewsKeywords(items);
  assert.equal(out.length, 5, "caps at 5");
  assert.equal(out[0].title, "Binance pauses ETH withdrawals amid market panic");
  assert.equal(out[1].title, "SEC charges Coinbase with operating unregistered exchange");
  assert.equal(out[2].title, "USDT depeg rumor surfaces on Crypto Twitter");
  // every kept item must carry only the title field (not the rest of the item)
  assert.ok(out.every((o) => Object.keys(o).length === 1 && "title" in o),
    "output objects are {title} only — no leaching extra fields into KV");
});

test("filterNewsKeywords handles bad input without throwing", () => {
  assert.deepEqual(filterNewsKeywords(null), []);
  assert.deepEqual(filterNewsKeywords(undefined), []);
  assert.deepEqual(filterNewsKeywords([]), []);
  assert.deepEqual(filterNewsKeywords([{ title: "no kw here" }]), []);
  assert.deepEqual(filterNewsKeywords([{ title: "Binance x" }, { noTitle: 1 }, null]), [{ title: "Binance x" }]);
});

// ─── hexToAmount (S2: BigInt instead of parseInt) ─────────────────────

test("hexToAmount converts wei exactly, past the 2^53 parseInt boundary", () => {
  // 10,000 ETH in wei — exact
  assert.equal(hexToAmount("0x21e19e0c9bab2400000", 18), 10000);
  // 3 ETH (existing behavior preserved)
  assert.equal(hexToAmount("0x29a2241af62c0000", 18), 3);
  // 2^53 + 1 wei: parseInt() corrupts the integer wei value itself
  // (rounds down to 2^53); BigInt keeps it exact.
  assert.equal(parseInt("0x20000000000001", 16), 2 ** 53, "parseInt loses the low bit");
  assert.equal(hexToAmount("0x20000000000001", 18), Number(2n ** 53n + 1n) / 1e18);
  // ERC20 6-decimal: 12.5 USDT
  assert.equal(hexToAmount("0x" + (12_500_000).toString(16), 6), 12.5);
  // malformed / missing input -> NaN (caller skips), never throws
  assert.ok(Number.isNaN(hexToAmount("0xzz", 18)));
  assert.equal(hexToAmount("", 18), 0); // BigInt("") === 0n
  assert.equal(hexToAmount(null, 18), 0);
  assert.equal(hexToAmount("0x0", 6), 0);
});

// ─── parseEnvInt (S14: garbage env must not silently zero the scan) ────

test("parseEnvInt falls back to defaults on missing/garbage env", () => {
  assert.equal(parseEnvInt("10", 2), 10);
  assert.equal(parseEnvInt("0", 5), 0); // 0 is a real value, not garbage
  assert.equal(parseEnvInt(undefined, 2), 2);
  assert.equal(parseEnvInt("", 2), 2);
  assert.equal(parseEnvInt("garbage", 2), 2);
  assert.equal(parseEnvInt("10blocks", 2), 10); // parseInt prefix behavior kept
});

// ─── contract-creation skip (S15) ──────────────────────────────────────

test("extractCandidatesETH skips contract creations (to: null)", () => {
  const block = {
    number: "0x64",
    timestamp: "0x650a800",
    transactions: [
      { hash: "0xDEPLOY", value: "0xde0b6b3a7640000", from: "0xaaa", to: null }, // 1 ETH to null
      { hash: "0xTX", value: "0xde0b6b3a7640000", from: "0xaaa", to: "0xbbb" },
    ],
  };
  const out = extractCandidatesETH(block, MARKET);
  assert.equal(out.length, 1);
  assert.equal(out[0].tx_hash, "0xTX");
});

// ═══════════════════════════════════════════════════════════════════════
// Integration tests with a stubbed fetch() — these cover the network half
// the old suite explicitly skipped: fetchBlock, fetchLatestBlockHeight,
// scanChain (per-block persist, confirmation depth, no double-count).
// ═══════════════════════════════════════════════════════════════════════

function jsonResp(obj, status = 200) {
  const body = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300, status, statusText: status === 200 ? "OK" : "ERR",
    text: async () => body, json: async () => obj,
  };
}
function textResp(text, status = 200) {
  return {
    ok: status >= 200 && status < 300, status, statusText: status === 200 ? "OK" : "ERR",
    text: async () => text,
    json: async () => { throw new Error("not json"); },
  };
}

/** Install a stub fetch for the duration of fn(); restores afterwards. */
async function withStubFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

/**
 * Minimal in-memory D1 stand-in supporting exactly the statements
 * scanChain/insertWhaleAndQueue issue. Anything else throws loudly.
 */
function makeFakeEnv(seed = {}) {
  const state = {
    scanner_state: {
      btc: { last_block: null, total_whales: 0, errors: 0, tx_offset: 0, last_scan: 0 },
      eth: { last_block: null, total_whales: 0, errors: 0, tx_offset: 0, last_scan: 0 },
    },
    whales: [],
    wallets: new Map(),
  };
  if (seed.last_block) {
    for (const [chain, v] of Object.entries(seed.last_block)) state.scanner_state[chain].last_block = v;
  }
  let whaleId = 0;
  const DB = {
    prepare(sql) {
      const stmt = {
        _binds: [],
        bind(...args) { this._binds = args; return this; },
        first() {
          if (sql.includes("FROM scanner_state")) {
            const row = state.scanner_state[this._binds[0]];
            return row ? { ...row } : null;
          }
          if (sql.includes("SELECT id FROM whales")) {
            const [chain, tx_hash, symbol] = this._binds;
            const r = state.whales.find((w) => w.chain === chain && w.tx_hash === tx_hash && w.symbol === symbol);
            return r ? { id: r.id } : null;
          }
          throw new Error("fakeDB first(): unhandled SQL: " + sql.slice(0, 80));
        },
        all() {
          if (sql.includes("FROM wallets")) {
            return { results: [...state.wallets.values()].map((w) => ({ ...w })) };
          }
          if (sql.includes("FROM whales WHERE from_address")) {
            const [addr, chain] = this._binds;
            const rows = state.whales
              .filter((w) => w.from_address === addr && w.chain === chain)
              .sort((a, b) => b.detected_at - a.detected_at)
              .slice(0, 10)
              .map((w) => ({ detected_at: w.detected_at }));
            return { results: rows };
          }
          throw new Error("fakeDB all(): unhandled SQL: " + sql.slice(0, 80));
        },
        run() {
          if (sql.includes("UPDATE scanner_state SET last_block")) {
            const [last_block, last_scan, delta, tx_offset, chain] = this._binds;
            const s = state.scanner_state[chain];
            s.last_block = last_block; s.last_scan = last_scan; s.errors = 0;
            s.total_whales += delta; s.tx_offset = tx_offset;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("errors = errors + 1")) {
            state.scanner_state[this._binds[0]].errors += 1;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("INSERT OR IGNORE INTO whales")) {
            const [chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type,
              block_number, block_time, detected_at, analysis_status, interesting_score,
              price_at_detect, is_self_transfer, contract_address] = this._binds;
            const dup = state.whales.some((w) => w.chain === chain && w.tx_hash === tx_hash && w.symbol === symbol);
            if (dup) return { success: true, meta: { changes: 0 } };
            state.whales.push({
              id: ++whaleId, chain, tx_hash, from_address, to_address, amount, symbol,
              usd_value, tx_type, block_number, block_time, detected_at, analysis_status,
              interesting_score, price_at_detect, is_self_transfer, contract_address,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE wallets SET last_seen")) {
            const addrs = this._binds.slice(4, -1);
            const chain = this._binds[this._binds.length - 1];
            for (const a of addrs) {
              const key = String(a).toLowerCase() + "|" + chain;
              let w = state.wallets.get(key);
              if (!w) {
                w = { address: a, chain, label: null, type: null, tx_count: 0, total_volume: 0, first_seen: null, last_seen: null, last_tx_hash: null };
                state.wallets.set(key, w);
              }
              w.last_seen = this._binds[0];
              w.last_tx_hash = this._binds[1];
              if (w.first_seen == null) w.first_seen = this._binds[2]; // COALESCE(first_seen, ?)
              w.tx_count += 1;
              w.total_volume += this._binds[3];
            }
            return { success: true, meta: { changes: addrs.length } };
          }
          if (sql.includes("UPDATE wallets SET") && sql.includes("WHERE address = ?")) {
            return { success: true, meta: { changes: 0 } }; // autoLabelWallets: not asserted here
          }
          if (sql.includes("INSERT INTO scanner_state") && sql.includes("ON CONFLICT")) {
            // persistState/bumpErrors upsert — track in fake state
            const chain = this._binds[0];
            if (!state.scanner_state) state.scanner_state = {};
            if (sql.includes("errors = errors + 1")) {
              const s = state.scanner_state[chain] || { errors: 0 };
              s.errors = (s.errors || 0) + 1;
              state.scanner_state[chain] = s;
            } else {
              const prev = state.scanner_state[chain] || { total_whales: 0 };
              state.scanner_state[chain] = {
                last_block: this._binds[1],
                last_scan: this._binds[2],
                errors: 0,
                total_whales: (prev.total_whales || 0) + (this._binds[3] || 0),
                tx_offset: this._binds[4] || 0,
              };
            }
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error("fakeDB run(): unhandled SQL: " + sql.slice(0, 80));
        },
      };
      return stmt;
    },
  };
  const ANALYSTQ = { sent: [], async send(msg) { this.sent.push(msg); } };
  return { env: { DB, ANALYSTQ }, state };
}

const FAKE_MARKET = {
  btc: { price: 100_000, change_24h: 0 },
  eth: { price: 3_500, change_24h: 0 },
  usdt: { price: 1, change_24h: 0 },
  usdc: { price: 1, change_24h: 0 },
};

function btcTx(hash, fromAddr, toAddr, btc) {
  const sat = Math.round(btc * 1e8);
  return {
    hash,
    inputs: [{ prev_out: { addr: fromAddr, value: sat } }],
    out: [{ addr: toAddr, value: sat }],
  };
}

// ─── fetchBlock pagination (S1) ────────────────────────────────────────

test("fetchBlock paginates blockstream txs past the 25-tx first page", async () => {
  const HASH = "ff".repeat(32);
  const page0 = Array.from({ length: 25 }, (_, i) => ({ txid: `tx${i}`, vin: [], vout: [] }));
  const page1 = Array.from({ length: 25 }, (_, i) => ({ txid: `tx${25 + i}`, vin: [], vout: [] }));
  const page2 = Array.from({ length: 10 }, (_, i) => ({ txid: `tx${50 + i}`, vin: [], vout: [] }));
  const fetchedUrls = [];
  const stub = async (input) => {
    const u = String(input);
    fetchedUrls.push(u);
    if (u.includes("/block-height/")) return textResp(HASH);
    const m = u.match(/\/block\/[0-9a-f]{64}\/txs\/(\d+)$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (idx === 0) return jsonResp(page0);
      if (idx === 25) return jsonResp(page1);
      if (idx === 50) return jsonResp(page2);
      return jsonResp([]);
    }
    if (new RegExp(`/block/${HASH}$`).test(u)) return jsonResp({ timestamp: 1700000000 });
    throw new Error("unstubbed: " + u);
  };
  await withStubFetch(stub, async () => {
    const block = await fetchBlock("btc", 800001, {}, {});
    assert.equal(block.tx.length, 60, "all three pages collected");
    assert.equal(block.tx[0].hash, "tx0");
    assert.equal(block.tx[59].hash, "tx59");
    assert.equal(block.txComplete, true);
    assert.equal(block.nextTxIndex, 0);
    assert.ok(fetchedUrls.some((u) => u.endsWith("/txs/50")), "third page was actually fetched");
  });
});

test("fetchBlock stops paginating when the subrequest budget runs out (resumable)", async () => {
  const HASH = "ff".repeat(32);
  const stub = async (input) => {
    const u = String(input);
    if (u.includes("/block-height/")) return textResp(HASH);
    if (new RegExp(`/block/${HASH}$`).test(u)) return jsonResp({ timestamp: 1700000000 });
    if (u.includes("/txs/")) return jsonResp(Array.from({ length: 25 }, (_, i) => ({ txid: `p${i}`, vin: [], vout: [] })));
    throw new Error("unstubbed: " + u);
  };
  await withStubFetch(stub, async () => {
    const budget = { remaining: 2 }; // hash + header, then dry
    const block = await fetchBlock("btc", 800001, {}, { budget });
    assert.equal(block.txComplete, false);
    assert.equal(block.nextTxIndex, 0, "no page was fetched — resume from 0");
    assert.equal(budget.remaining, 0);
  });
});

test("fetchBlock resumes pagination from a persisted tx offset", async () => {
  const HASH = "ff".repeat(32);
  const fetched = [];
  const stub = async (input) => {
    const u = String(input);
    fetched.push(u);
    if (u.includes("/block-height/")) return textResp(HASH);
    if (new RegExp(`/block/${HASH}$`).test(u)) return jsonResp({ timestamp: 1700000000 });
    const m = u.match(/\/txs\/(\d+)$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (idx === 25) return jsonResp(Array.from({ length: 7 }, (_, i) => ({ txid: `q${i}`, vin: [], vout: [] })));
      throw new Error("should not refetch page 0, got index " + idx);
    }
    throw new Error("unstubbed: " + u);
  };
  await withStubFetch(stub, async () => {
    const block = await fetchBlock("btc", 800001, {}, { startTxIndex: 25 });
    assert.equal(block.tx.length, 7);
    assert.equal(block.txComplete, true);
    assert.ok(!fetched.some((u) => u.endsWith("/txs/0")), "page 0 was not refetched");
  });
});

// ─── fetchLatestBlockHeight validation (S5) ────────────────────────────

test("fetchLatestBlockHeight throws on garbage ETH tip instead of returning NaN", async () => {
  const stub = async (input) => {
    const u = String(input);
    if (u.includes("eth_blockNumber")) return jsonResp({ result: "0x", status: "0", message: "rate limit" });
    throw new Error("unstubbed: " + u);
  };
  await withStubFetch(stub, async () => {
    await assert.rejects(fetchLatestBlockHeight({ ETHSCAN_KEY: "" }, "eth"), /garbage/);
  });
});

test("fetchLatestBlockHeight still returns good heights", async () => {
  const stub = async (input) => {
    const u = String(input);
    if (u.includes("blockstream.info/api/blocks/tip/height")) return textResp("870123\n");
    if (u.includes("eth_blockNumber")) return jsonResp({ result: "0x7a1200" });
    throw new Error("unstubbed: " + u);
  };
  await withStubFetch(stub, async () => {
    assert.equal(await fetchLatestBlockHeight({}, "btc"), 870123);
    assert.equal(await fetchLatestBlockHeight({ ETHSCAN_KEY: "" }, "eth"), 0x7a1200);
  });
});

// ─── scanChain: per-block persist, no double-count, confirmation depth ──

test("scanChain persists per block: mid-batch failure does not double-count wallet stats", async () => {
  const { env, state } = makeFakeEnv({ last_block: { btc: 100 } });
  const fetchedBlocks = [];
  const stub = async (input) => {
    const u = String(input);
    if (u.includes("blockstream.info")) throw new Error("blockstream down in test");
    if (u.includes("blockchain.info/latestblock")) return jsonResp({ height: 103 });
    const m = u.match(/\/rawblock\/(\d+)/);
    if (m) {
      const h = parseInt(m[1], 10);
      fetchedBlocks.push(h);
      if (h === 102) throw new Error("boom at 102");
      return jsonResp({ height: h, time: 1700000000, tx: [btcTx("whale-101", "whaleA", "whaleB", 600)] });
    }
    throw new Error("unstubbed: " + u);
  };

  // Tick 1: block 101 has a 600 BTC whale ($60M), block 102 explodes.
  await withStubFetch(stub, async () => {
    const r = await scanChain(env, "btc", FAKE_MARKET);
    assert.equal(r.processed, 1);
    assert.equal(r.newWhales, 1);
  });
  assert.equal(state.scanner_state.btc.last_block, 101, "block 101 persisted despite 102 failing");
  assert.equal(state.whales.length, 1);
  assert.equal(state.scanner_state.btc.total_whales, 1, "total_whales incremented (S8)");
  const wA = state.wallets.get("whalea|btc");
  assert.equal(wA.tx_count, 1, "wallet bumped exactly once");
  assert.ok(wA.first_seen != null, "first_seen written (S12)");

  // Tick 2: 102 still explodes. Nothing should be re-processed.
  await withStubFetch(stub, async () => {
    const r = await scanChain(env, "btc", FAKE_MARKET);
    assert.equal(r.processed, 0);
  });
  assert.equal(state.scanner_state.btc.last_block, 101);
  assert.equal(state.wallets.get("whalea|btc").tx_count, 1, "no double-count on retry");
  assert.ok(!fetchedBlocks.includes(103), "confirmation depth: tip block 103 not scanned (S16)");
});

test("scanChain resumes after the failure without reprocessing block 101", async () => {
  const { env, state } = makeFakeEnv({ last_block: { btc: 100 } });
  let fail102 = true;
  const stub = async (input) => {
    const u = String(input);
    if (u.includes("blockstream.info")) throw new Error("blockstream down in test");
    if (u.includes("blockchain.info/latestblock")) return jsonResp({ height: 104 });
    const m = u.match(/\/rawblock\/(\d+)/);
    if (m) {
      const h = parseInt(m[1], 10);
      if (h === 102 && fail102) throw new Error("boom at 102");
      const txs = h === 101 ? [btcTx("whale-101", "whaleA", "whaleB", 600)] : [];
      return jsonResp({ height: h, time: 1700000000, tx: txs });
    }
    throw new Error("unstubbed: " + u);
  };
  await withStubFetch(stub, async () => {
    await scanChain(env, "btc", FAKE_MARKET); // 101 ok, 102 boom
    assert.equal(state.scanner_state.btc.last_block, 101);
    fail102 = false;
    const r = await scanChain(env, "btc", FAKE_MARKET); // 102 ok (empty), scanTo = 104-1 = 103
    assert.equal(r.processed, 2, "blocks 102 and 103 processed");
    assert.equal(state.scanner_state.btc.last_block, 103);
  });
  assert.equal(state.whales.length, 1, "whale from 101 inserted exactly once");
  assert.equal(state.wallets.get("whalea|btc").tx_count, 1, "block 101 wallet stats bumped exactly once");
  assert.equal(state.scanner_state.btc.total_whales, 1);
});

test("scanChain applies ETH confirmation depth of 2", async () => {
  const { env, state } = makeFakeEnv({ last_block: { eth: 500000 } });
  const fetchedBlocks = [];
  const stub = async (input) => {
    const u = String(input);
    if (u.includes("eth_blockNumber")) return jsonResp({ result: "0x7a123" }); // 500003
    const m = u.match(/tag=(0x[0-9a-f]+)/);
    if (m) {
      const h = parseInt(m[1], 16);
      fetchedBlocks.push(h);
      return jsonResp({ result: { number: m[1], timestamp: "0x650a800", transactions: [] } });
    }
    if (u.includes("action=getLogs")) return jsonResp({ result: [] });
    throw new Error("unstubbed: " + u);
  };
  await withStubFetch(stub, async () => {
    const r = await scanChain(env, "eth", FAKE_MARKET);
    assert.equal(r.processed, 1, "only block 500001 (latest-2)");
    assert.deepEqual(fetchedBlocks, [500001]);
    assert.equal(state.scanner_state.eth.last_block, 500001);
  });
});

test("scanChain first run primes without processing (unchanged behavior)", async () => {
  const { env, state } = makeFakeEnv();
  const stub = async (input) => {
    const u = String(input);
    if (u.includes("blockstream.info")) throw new Error("down");
    if (u.includes("blockchain.info/latestblock")) return jsonResp({ height: 900000 });
    throw new Error("unstubbed: " + u);
  };
  await withStubFetch(stub, async () => {
    const r = await scanChain(env, "btc", FAKE_MARKET);
    assert.equal(r.primed, true);
    assert.equal(r.processed, 0);
  });
  assert.equal(state.scanner_state.btc.last_block, 900000);
  assert.equal(state.whales.length, 0);
});
