// tests/scanner.test.js
// Tests the pure candidate-extraction and filtering functions of the scanner.
// Does NOT test fetchBlock() or fetchLatestBlockHeight() — those hit the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidatesBTC, extractCandidatesETH, extractERC20Candidates, filterWhales, classifyWhales, statTargets } from "../src/scanner.js";
import { buildWalletMap } from "../src/worker-utils.js";

const MARKET = {
  btc: { price: 60_000, change_24h: -2.1 },
  eth: { price: 3_000, change_24h: 1.2 },
  usdt: { price: 1 }, usdc: { price: 1 }, dai: { price: 1 },
  wbtc: { price: 60_000 },
};

test("extractCandidatesBTC sums outputs and uses first input addr", () => {
  // blockchain.info amounts are in SATOSHIS. 1 BTC = 1e8 sat.
  const block = {
    height: 850_000,
    time: 1_700_000_000,
    tx: [
      {
        hash: "aaa",
        inputs: [{ prev_out: { addr: "sender1" } }],
        out: [{ addr: "recipient1", value: 5_000_000_000 }], // 50 BTC -> $3M
      },
      {
        hash: "bbb",
        inputs: [{ prev_out: { addr: "sender2" } }, { prev_out: { addr: "sender3" } }],
        out: [
          { addr: "intermediate", value: 50_000_000_000 },
          { addr: "final",        value: 50_000_000_000 },
        ], // total = 1000 BTC -> $60M
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

  // second: 100e9 sat = 1000 BTC × $60K = $60M
  assert.equal(out[1].tx_hash, "bbb");
  assert.equal(out[1].amount, 1000);
  assert.equal(out[1].usd_value, 60_000_000);
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
