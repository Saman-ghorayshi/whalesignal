// tests/e2e.fixture.js
// WhaleSignal-specific wiring for the cf-harness. Defines the binding env
// (D1/KV/queues/secrets) and a MockFetch router that returns canned responses
// for: blockchain.info, etherscan, coingecko, alternative.me, Gemini,
// Telegram sendMessage — every external call the scanner/analyst/bot make.
//
// Then exports a few high-level scenarios:
//   * fullPipeline() — scanner ticks -> analyst drains -> bot drains — and
//     checks that a Telegram message was sent with the expected alert shape.
//
// This file is the per-project glue. cf-harness.js is generic.

import { Harness, MockD1, MockKV, MockQueue, MockFetch } from "../tools/cf-harness.js";
import * as scanner from "../src/scanner.js";
import * as analyst from "../src/analyst.js";
import * as bot from "../src/bot.js";

export function makeWorld() {
  const DB = new MockD1();
  DB.execFile("schema/whalesignal.sql");

  // Seed wallet labels so classifyWhales stamps exchange_inflow/outflow.
  // The fixture block addresses (Binance-looking dest) need to be labeled
  // 'exchange' for the interestingness score to reach the threshold.
  const seedWallets = [
    "INSERT INTO wallets (address, chain, label, type) VALUES ('1WhaleDestBinanceAddr0000', 'btc', 'Binance', 'exchange')",
    "INSERT INTO wallets (address, chain, label, type) VALUES ('0xExchangeBinanceAddr0000000000000000000000feed', 'eth', 'Binance', 'exchange')",
    "INSERT INTO wallets (address, chain, label, type) VALUES ('16KaJxxxxxxxWhaleSource0000', 'btc', 'Whale Source', 'whale')",
    "INSERT INTO wallets (address, chain, label, type) VALUES ('0xWhaleSourceAddr0000000000000000000000abcd', 'eth', 'Whale Source', 'whale')",
  ];
  for (const sql of seedWallets) DB.prepare(sql).run();

  const KV = new MockKV({
    market_cache: JSON.stringify({
      btc: { price: 100000, change_24h: 1.2 },
      eth: { price: 3500, change_24h: -0.5 },
      usdt: { price: 1, change_24h: 0 },
      usdc: { price: 1, change_24h: 0 },
      dai:  { price: 1, change_24h: 0 },
      wbtc: { price: 100000, change_24h: 1.2 },
      fear_greed: 50,
      fear_greed_label: "Neutral",
      updated_at: Date.now(),
    }),
  });

  const ANALYSTQ = new MockQueue("analystq");
  const BOTQ = new MockQueue("botq");

  const fetches = makeFetches();
  const env = {
    DB, KV, ANALYSTQ, BOTQ,
    BOT_TOKEN: "TEST_TOKEN_123",
    PUBLIC_CHANNEL: "@whalesignal_test",
    GEMINI_KEY: "test-gemini-key",
    ETHSCAN_KEY: "", BSCSCAN_KEY: "",
    MIN_USD: "500000",
    MAX_BLOCKS: "10",
  };
  const harness = new Harness(env, fetches);
  return { env, harness, fetches, ANALYSTQ, BOTQ, DB };
}

function makeFetches() {
  // per-world stateful fixture counters (latestblock ctick incrementally).
  let btcLatestCallNum = 0;
  let ethLatestCallNum = 0;
  return new MockFetch([
    // blockchain.info latest block — returns a HIGHER height on each call so
    // tick 1 primes last_block, tick 2 sees "new blocks available" and scans.
    { match: "https://blockchain.info/latestblock",
      handler: () => {
        btcLatestCallNum++;
        return { json: { height: 800000 + btcLatestCallNum - 1 } };  // tick1: 800000, tick2: 800001, ...
      } },

    // blockchain.info rawblock by height — return a block with just tiny txs (below MIN_USD)
    // Use heights 800001+ to feed the scenario below.
    { match: "https://blockchain.info/rawblock/",
      handler: (url) => ({ json: makeBtcBlock(parseInt(url.pathname.split('/').pop(), 10)) }) },

    // etherscan V2 eth_blockNumber — tick 1 (priming): 500000. Tick 2: 500001 so scanner
    // sees a new block. Subsequent ticks increment. My whale lives at block 500001.
    { match: "https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber",
      handler: () => {
        ethLatestCallNum++;
        const height = 500000 + ethLatestCallNum - 1;
        return { json: { result: "0x" + height.toString(16) } };
      } },
    { match: "https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber",
      handler: (url) => ({ json: { result: makeEthBlock(url) } }) },
    { match: "https://api.etherscan.io/v2/api?chainid=1&module=logs",
      handler: (url) => ({ json: { result: [] } }) }, // no erc20 transfers in this block

    // coingecko prices
    { match: "https://api.coingecko.com/api/v3/simple/price",
      handler: () => ({ json: {
        bitcoin: { usd: 100000, usd_24h_change: 1.2 },
        ethereum: { usd: 3500, usd_24h_change: -0.5 },
      } }) },

    // fear & greed
    { match: "https://api.alternative.me/fng/",
      handler: () => ({ json: { data: [{ value: "50", value_classification: "Neutral" }] } }) },

    // CryptoPanic (Phase 3a / whale-reasoning Plan Ladder A — fills news_cache)
    // MockFetch matches by substring; the URL scanner builds is
    // https://cryptopanic.com/api/v1/posts/?kind=news&filter=hot[&auth_token=...]
    // one canned payload, two keyword-matching titles (Binance, ETF)
    // and two non-matching ones — proves filterNewsKeywords runs server-side.
    { match: "https://cryptopanic.com/api/v1/posts/",
      handler: () => ({ json: { results: [
        { title: "Binance resumes ETH withdrawals after brief pause" },
        { title: "Beautiful sunset over the beach — not crypto news" },
        { title: "Bitcoin ETF inflows hit 3-month high" },
        { title: "Recipe of the week: avocado toast" },
      ] } }) },

    // Gemini — returns a well-formed JSON analysis for any prompt
    { match: "https://generativelanguage.googleapis.com",
      handler: () => ({
        json: { candidates: [{ content: { parts: [{ text:
          JSON.stringify({
            headline: "Whale moves 500 BTC to Binance during neutral sentiment",
            interpretation: "Likely a sell-side liquidity move, but small in size — not a strong directional signal.",
            signal: "neutral",
            confidence: 0.62,
            related_factor: "exchange inflow during neutral sentiment",
          })
        }] } }] },
      }) },

    // Telegram sendMessage — record the call so tests can assert on it
    { match: "https://api.telegram.org/botTEST_TOKEN_123/sendMessage",
      handler: (url, init) => {
        const body = JSON.parse(init.body);
        // stash on the MockFetch instance via closure
        telegramSent.push(body);
        return { json: { ok: true, result: { message_id: 1, chat: body.chat_id, text: body.text } } };
      } },
  ]);
}

const telegramSent = [];
export function getTelegramSent() { return telegramSent; }
export function resetTelegramSent() { telegramSent.length = 0; }

// ─── block fixtures ──────────────────────────────────────────────────────
// Build a blockchain.info-style raw block with ONE whale tx above MIN_USD.
// height 800001 .. 800010 are produced (in sequence) by the scanner's
// catch-up loop. The FIRST block contains a 60 BTC whale (=$6M), subsequent
// blocks only contain dust so we can assert scanner found exactly one whale.

function makeBtcBlock(height) {
  const isWhaleBlock = (height === 800001);
  return {
    height,
    time: 1700000000 + height, // unix s, deterministic per height
    tx: isWhaleBlock
      ? [{
          hash: `btc-whale-tx-${height}`,
          out: [{ value: 60 * 1e8, addr: "1WhaleDestBinanceAddr0000" }],  // 60 BTC = $6M at $100k
          inputs: [{ prev_out: { addr: "16KaJxxxxxxxWhaleSource0000" } }],
        }]
      : [{
          hash: `btc-dust-${height}`,
          out: [{ value: 10000, addr: "1SmallDest00" }],
          inputs: [{ prev_out: { addr: "1SmallSrc00" } }],
        }],
  };
}

// Etherscan block: at block 500001 (the one AFTER eth_blockNumber returns 500000),
// put one whale tx of 2000 ETH (= $7M). Blocks 500002+ are empty.
function makeEthBlock(url) {
  const tag = new URL(url).searchParams.get("tag");
  const blockNum = parseInt(tag, 16);
  // eth_blockNumber returns 500000 here, so scanner primes to 500000.
  // next tick scanner scans 500001. The whale lives in 500001.
  if (blockNum === 500001) {
    return {
      number: "0x" + blockNum.toString(16),
      timestamp: "0x" + (1700000000).toString(16),
      transactions: [{
        hash: "eth-whale-tx-500001",
        from: "0xWhaleSourceAddr0000000000000000000000abcd",
        to: "0xExchangeBinanceAddr0000000000000000000000feed",
        value: "0x" + (2000 * 1e18).toString(16), // 2000 ETH = $7M at $3500
      }],
    };
  }
  return {
    number: "0x" + blockNum.toString(16),
    timestamp: "0x" + (1700001000).toString(16),
    transactions: [],
  };
}

// ─── full pipeline scenario ───────────────────────────────────────────────
// Runs:
//   1. scanner.scheduled() (primes last_block from latest)
//   2. scanner.scheduled() again — now scans next block, finds BTC + ETH whales, queues to ANALYSTQ
//   3. analyst.consume(ANALYSTQ) — calls Gemini, parses, saves analysis, queues to BOTQ
//   4. bot.consume(BOTQ) — calls Telegram sendMessage, marks delivered
//   5. Asserts: 1 message on ANALYSTQ consumed, 1 on BOTQ consumed, Telegram got 1 call with expected shape.
//
// Returns a structured result you can assert against.

export async function fullPipeline() {
  resetTelegramSent();
  const { env, harness, fetches, ANALYSTQ, BOTQ, DB } = makeWorld();

  // Tick 1: primes last_block for both chains
  await harness.scheduled(scanner.default);

  // After priming, blockchain.info latestblock is 800000 and etherscan returns 500000.
  // We want the scanner to scan 800001+ on BTC and 500001 on ETH on tick 2.
  // But our "whale block" lives at 800001 / 500001 by the fixtures above. ✓

  // Tick 2: scan the next block
  await harness.scheduled(scanner.default);

  // Drain ANALYSTQ → analyst
  let analystResults = [];
  if (ANALYSTQ.pending.length > 0) {
    analystResults = await harness.queue(analyst.default, ANALYSTQ);
  }

  // Drain BOTQ → bot
  let botResults = [];
  if (BOTQ.pending.length > 0) {
    botResults = await harness.queue(bot.default, BOTQ);
  }

  const whales = DB.prepare("SELECT id, chain, tx_hash, amount, symbol, usd_value, tx_type, analysis_status FROM whales ORDER BY id").all().results;
  const analyses = DB.prepare("SELECT whale_id, signal, confidence, headline FROM analysis").all().results;
  const delivered = DB.prepare("SELECT whale_id, chat_id FROM delivered").all().results;

  // Return env.KV (the MockKV instance), not just its store, so callers can
  // assert cache keys were written (e.g. news_cache after Ladder A).
  return {
    whales,
    analyses,
    delivered,
    analystResults,
    botResults,
    telegramSent: getTelegramSent(),
    fetchCalls: fetches.calls.length,
    KV: env.KV,
  };
}
