/**
 * solana.test.js — unit tests for the Solana wallet-watch parser.
 * parseSolanaTx is pure: feed it synthetic tx objects, assert candidates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSolanaTx } from "../src/solana.js";

const ALICE = "alice111111111111111111111111111111111111";
const BOB = "bob1111111111111111111111111111111111111111";

function solTx({ fromIdx = 0, toIdx = 1, lamports = 2_000_000_000_000 }) {
  // 2M SOL lamports = 2000 SOL
  return {
    meta: {
      err: null,
      preBalances: [5_000_000_000_000, 1_000_000_000],
      postBalances: [5_000_000_000_000 - lamports, 1_000_000_000 + lamports],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: {
      message: { accountKeys: [ALICE, BOB] },
    },
  };
}

test("parseSolanaTx detects large SOL transfer", () => {
  // 2000 SOL @ $150 = $300k >= $250k threshold
  const out = parseSolanaTx(solTx({}), 150);
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "SOL");
  assert.equal(out[0].amount, 2000);
  assert.equal(out[0].usd_value, 300_000);
  assert.equal(out[0].from_address, ALICE.toLowerCase());
  assert.equal(out[0].to_address, BOB.toLowerCase());
});

test("parseSolanaTx skips below-threshold SOL", () => {
  // 100 SOL @ $150 = $15k < $250k
  const out = parseSolanaTx(solTx({ lamports: 100_000_000_000 }), 150);
  assert.equal(out.length, 0);
});

test("parseSolanaTx skips failed transactions", () => {
  const tx = solTx({});
  tx.meta.err = { InstructionError: [0, "Custom"] };
  assert.equal(parseSolanaTx(tx, 150).length, 0);
});

test("parseSolanaTx detects large USDC transfer", () => {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const tx = {
    meta: {
      err: null,
      preBalances: [1_000_000_000, 1_000_000_000],
      postBalances: [999_000_000, 1_000_000_000],
      preTokenBalances: [
        { accountIndex: 2, mint: USDC_MINT, owner: ALICE, uiTokenAmount: { uiAmount: 1_000_000 } },
        { accountIndex: 3, mint: USDC_MINT, owner: BOB, uiTokenAmount: { uiAmount: 0 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: USDC_MINT, owner: ALICE, uiTokenAmount: { uiAmount: 400_000 } },
        { accountIndex: 3, mint: USDC_MINT, owner: BOB, uiTokenAmount: { uiAmount: 600_000 } },
      ],
    },
    transaction: { message: { accountKeys: [ALICE, BOB, "t1", "t2"] } },
  };
  const out = parseSolanaTx(tx, 150);
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "USDC");
  assert.equal(out[0].amount, 600_000);
  assert.equal(out[0].from_address, ALICE.toLowerCase());
});

test("parseSolanaTx skips self-transfers", () => {
  const tx = solTx({});
  tx.transaction.message.accountKeys = [ALICE, ALICE];
  const out = parseSolanaTx(tx, 150);
  // from == to, filtered
  assert.equal(out.length, 0);
});
