// tests/sprint5.test.js — free-forever rollups: accumulator folding and
// statement generation. Pure-function coverage; runtime flush is best-effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newRollupAcc, accWhale, rollupStatements, autoPauseState } from "../src/scanner.js";

const HOUR = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000);

test("accWhale: totals, hourly buckets, and per-symbol counters", () => {
  const acc = newRollupAcc(HOUR);
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 1_000_000, tx_type: "wallet_to_wallet", from_address: "a", to_address: "b" });
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 2_000_000, tx_type: "exchange_inflow", from_address: "a", to_address: "BINANCE1" }, "Binance");
  assert.equal(acc.totals.whales, 2);
  assert.equal(acc.totals.volume, 3_000_000);
  assert.equal(acc.totals.tick_max_usd, 2_000_000);
  const h = acc.hours.get("btc");
  assert.equal(h.events, 2);
  assert.equal(h.volume_usd, 3_000_000);
  assert.equal(h.inflow_usd, 2_000_000);
  assert.equal(h.inflow_count, 1);
  assert.equal(acc.symbols.get("BTC").count, 2);
  assert.equal(acc.symbols.get("BTC").volume, 3_000_000);
});

test("accWhale: exchange flow buckets use the label, edges fold inflow/outflow flags", () => {
  const acc = newRollupAcc(HOUR);
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 5_000_000, tx_type: "exchange_inflow", from_address: "whale1", to_address: "BINANCE1" }, "Binance");
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 3_000_000, tx_type: "exchange_outflow", from_address: "BINANCE1", to_address: "whale1" }, "Binance");
  const x = acc.exflow.get("btc|Binance");
  assert.equal(x.inflow_usd, 5_000_000);
  assert.equal(x.outflow_usd, 3_000_000);
  assert.equal(x.inflow_count, 1);
  assert.equal(x.outflow_count, 1);
  // edges are DIRECTED: whale→exchange (deposit) and exchange→whale
  // (withdrawal) are separate edges with opposite meanings — the graph
  // colors them differently.
  assert.equal(acc.edges.size, 2);
  const dep = acc.edges.get('btc|whale1|BINANCE1');
  assert.equal(dep.volume_usd, 5_000_000);
  assert.equal(dep.inflow_cnt, 1);
  const wd = acc.edges.get('btc|BINANCE1|whale1');
  assert.equal(wd.volume_usd, 3_000_000);
  assert.equal(wd.outflow_cnt, 1);
  // self-transfers never become edges
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 1_000_000, tx_type: "wallet_to_wallet", from_address: "same", to_address: "same" });
  assert.equal(acc.edges.size, 2);
});

test("accWhale: unlabeled exchange flow falls back to a truncated address", () => {
  const acc = newRollupAcc(HOUR);
  accWhale(acc, { chain: "eth", symbol: "ETH", usd_value: 900_000, tx_type: "exchange_inflow", from_address: "0xw", to_address: "0x1234567890abcdef1234" }, null);
  const x = acc.exflow.get("eth|0x1234567890…");
  assert.ok(x, "should bucket under the truncated label");
  assert.equal(x.inflow_count, 1);
});

test("rollupStatements: one batch with counters, hours, exflows, edges, symbols", () => {
  const acc = newRollupAcc(HOUR);
  accWhale(acc, { chain: "btc", symbol: "BTC", usd_value: 1_000_000, tx_type: "exchange_inflow", from_address: "w", to_address: "BINANCE1" }, "Binance");
  const stmts = rollupStatements(acc);
  const sqls = stmts.map((s) => s.sql);
  // 2 counters (totals + largest) + 1 hourly + 1 exflow + 1 edge + 2 symbol counters
  assert.equal(stmts.length, 7);
  assert.match(sqls[0], /total_whales/);
  assert.match(sqls[1], /largest_transfer/);
  assert.ok(sqls.some((s) => /hourly_stats/.test(s)));
  assert.ok(sqls.some((s) => /exchange_netflow_hourly/.test(s)));
  assert.ok(sqls.some((s) => /flow_edges_hourly/.test(s)));
  // every statement carries its binds
  for (const s of stmts) assert.ok(Array.isArray(s.binds));
  const totals = stmts[0];
  assert.deepEqual(totals.binds, [1, 1_000_000]);
  // empty accumulator still yields the two counter statements (0-delta)
  const empty = rollupStatements(newRollupAcc(HOUR));
  assert.equal(empty.length, 2);
  assert.deepEqual(empty[0].binds, [0, 0]);
});

test("autoPauseState: guard pause active until until-passes, then expired", () => {
  const now = 10_000;
  assert.deepEqual(autoPauseState({ until: 20_000, reason: "d1_read_cap" }, now), { active: true, expired: false });
  assert.deepEqual(autoPauseState({ until: 5_000, reason: "d1_read_cap" }, now), { active: false, expired: true });
  assert.deepEqual(autoPauseState(null, now), { active: false, expired: false });
  assert.deepEqual(autoPauseState({}, now), { active: false, expired: false });
});

// ─── accountability engine: grading, buckets, scoreboard ─────────────
import { gradeSignal, confidenceBucket, renderScoreboard, renderWalletJSON } from "../src/bot.js";

test("gradeSignal: bullish/bearish × move direction matrix", () => {
  assert.equal(gradeSignal("bullish", 100, 102), "correct");   // +2%
  assert.equal(gradeSignal("bullish", 100, 98), "wrong");      // −2%
  assert.equal(gradeSignal("bearish", 100, 98), "correct");
  assert.equal(gradeSignal("bearish", 100, 102), "wrong");
  assert.equal(gradeSignal("bullish", 100, 100.5), "no_move"); // <1%
  assert.equal(gradeSignal("bearish", 100, 100.9), "no_move");
  assert.equal(gradeSignal("bullish", null, 102), "no_data");
  assert.equal(gradeSignal("bullish", 100, null), "no_data");
  assert.equal(gradeSignal("bullish", 0, 102), "no_data");
  assert.equal(gradeSignal("neutral", 100, 102), "no_data");
  // threshold is configurable
  assert.equal(gradeSignal("bullish", 100, 100.5, 0.3), "correct");
});

test("confidenceBucket: high ≥0.75, mid ≥0.60, low below", () => {
  assert.equal(confidenceBucket(0.82), "high");
  assert.equal(confidenceBucket(0.75), "high");
  assert.equal(confidenceBucket(0.7), "mid");
  assert.equal(confidenceBucket(0.6), "mid");
  assert.equal(confidenceBucket(0.55), "low");
  assert.equal(confidenceBucket(null), "low");
});

test("renderScoreboard: rates, calls, and the honesty footer", () => {
  const text = renderScoreboard({
    graded24: 14, correct24: 9, wrong24: 3, nomove24: 2,
    accuracy: { total: 48, correct: 31 },
    topCalls: [{
      usd_value: 425_289_098, symbol: "BTC", signal: "bearish", confidence: 0.6,
      prediction_outcome: "correct", price_at_detect: 75_000, price_at_eval: 73_650,
    }],
  });
  assert.match(text, /Graded last 24h: 14/);
  assert.match(text, /Running accuracy: 65%/);
  assert.match(text, /✅ CORRECT/);
  assert.match(text, /-1.8% in 24h/);
  assert.match(text, /No cherry-picking/);
  const empty = renderScoreboard({ graded24: 0, correct24: 0, wrong24: 0, nomove24: 0, accuracy: null, topCalls: [] });
  assert.match(empty, /first grades land/);
});

test("renderWalletJSON: track_record appears once graded, absent at 0", () => {
  const profile = { address: "0xw", chain: "eth", label: "W", type: "whale", reputation: null, tx_count: 4, total_volume: 1, first_seen: 1, last_seen: 2 };
  const withTrack = renderWalletJSON(profile, [], null, [], { graded: 8, correct: 5 });
  assert.deepEqual(withTrack.track_record, { graded: 8, correct: 5, rate: 63 });
  const ungraded = renderWalletJSON(profile, [], null, [], { graded: 0, correct: 0 });
  assert.equal(ungraded.track_record, null);
});

// ─── market cache fallback (CoinGecko → Coinbase, never clobber good cache) ──
import { buildMarketCache } from "../src/scanner.js";

test("buildMarketCache: coingecko data wins, coinbase fills gaps, nulls never clobber", () => {
  const cg = { bitcoin: { usd: 60_000, usd_24h_change: -2.1 }, ethereum: { usd: 3_000, usd_24h_change: 1.0 } };
  const full = buildMarketCache({ cg, btcSpot: 1, ethSpot: 2, fg: { data: [{ value: "69", value_classification: "Greed" }] } });
  assert.equal(full.btc.price, 60_000);
  assert.equal(full.eth.price, 3_000);
  assert.equal(full.wbtc.price, 60_000);
  assert.equal(full.fear_greed, 69);

  // coingecko 429 → coinbase spot fills in
  const fallback = buildMarketCache({ cg: null, btcSpot: 61_000, ethSpot: 3_100 });
  assert.equal(fallback.btc.price, 61_000);
  assert.equal(fallback.eth.price, 3_100);
  assert.equal(fallback.btc.change_24h, null, "no 24h change from spot fallback");

  // both sources dead → null (caller must NOT overwrite the KV cache)
  assert.equal(buildMarketCache({ cg: null, btcSpot: null, ethSpot: null }), null);

  // partial: only BTC available still yields a usable cache
  const partial = buildMarketCache({ cg: null, btcSpot: 61_000, ethSpot: null });
  assert.equal(partial.btc.price, 61_000);
  assert.equal(partial.eth.price, null);
});

// ─── news context: RSS extraction + related-headline matching ────────
import { extractRssTitles, matchSymbols, headlineHash, headlineSentiment } from "../src/scanner.js";
import { relatedHeadlines, formatAlert } from "../src/bot.js";

test("extractRssTitles: items, CDATA, entities, atom entries", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <title>Feed title — must be skipped</title>
    <item><title>Bitcoin ETF sees &amp;$1B outflows</title><desc>x</desc></item>
    <item><title><![CDATA[Exchange halts BTC withdrawals amid "fear"]]></title></item>
    <entry><title>Ethereum staking &#039;reserves&#039; grow</title></entry>
    <item><title></title></item>
  </channel></rss>`;
  const titles = extractRssTitles(xml);
  assert.deepEqual(titles, [
    'Bitcoin ETF sees &$1B outflows',
    'Exchange halts BTC withdrawals amid "fear"',
    "Ethereum staking 'reserves' grow",
  ]);
});

test("relatedHeadlines: asset + directional match, capped at 2, honest empty", () => {
  const news = [
    { title: "Bitcoin ETF sees massive outflows as fear grips markets" },
    { title: "BTC whales deposit to exchanges before possible sell" },
    { title: "Ethereum staking reserves reach new high" },
    { title: "Bitcoin miners capitulate, exchanges see inflow spike" },
  ];
  const hits = relatedHeadlines(news, "BTC", "exchange_inflow");
  assert.equal(hits.length, 2, "max 2 headlines");
  assert.match(hits[0], /outflows|deposit/);
  // no asset match → honest empty, never noise
  assert.deepEqual(relatedHeadlines(news, "SOL", "exchange_inflow"), []);
  assert.deepEqual(relatedHeadlines(null, "BTC", "exchange_inflow"), []);
});

test("formatAlert: related headlines block renders between analysis and market footer", () => {
  const w = { chain: "btc", tx_hash: "0xk", from_address: "0xaaa", to_address: "0xbbb", amount: 5, symbol: "BTC", usd_value: 500_000, tx_type: "exchange_inflow", block_number: 100, detected_at: 1 };
  const a = { headline: "h", interpretation: "i", signal: "bearish", confidence: 0.7, related_factor: "rf" };
  const text = formatAlert(w, a, null, { related: ["Bitcoin ETF outflows spike"] });
  assert.match(text, /📰 Related headlines:\n• Bitcoin ETF outflows spike/);
  const none = formatAlert(w, a, null, {});
  assert.doesNotMatch(none, /Related headlines/);
});

test("templateAnalysis: huge unlabeled-source flows get capped confidence + caveat", () => {
  const w = { tx_type: "exchange_inflow", usd_value: 425_000_000, symbol: "BTC" };
  const r = templateAnalysis(w, { fear_greed: 50, fear_greed_label: "Neutral" }, []);
  assert.equal(r.signal, "bearish");
  assert.equal(r.confidence, 0.55, "huge inflow capped at 0.55");
  assert.match(r.interpretation, /treasury migration/);
  // fear + distribution + huge still capped
  const r2 = templateAnalysis(w, { fear_greed: 20, fear_greed_label: "Fear" }, [
    { tx_type: "exchange_inflow" }, { tx_type: "exchange_inflow" }, { tx_type: "exchange_inflow" },
  ]);
  assert.equal(r2.confidence, 0.55);
  // ordinary $10M inflow during fear keeps its 0.75
  const r3 = templateAnalysis({ tx_type: "exchange_inflow", usd_value: 10_000_000, symbol: "BTC" }, { fear_greed: 20, fear_greed_label: "Fear" }, []);
  assert.equal(r3.confidence, 0.65, "confluence: base 0.60 + F&G agrees 0.05");
});

// ─── backtester engine + news storage helpers ────────────────────────
import { priceAt, gradeEvent, summarize } from "../tools/backtest.mjs";

const DAY = 86_400_000;
const SERIES = [{ ts: 0, price: 100 }, { ts: DAY, price: 102 }, { ts: 2 * DAY, price: 99 }, { ts: 3 * DAY, price: 99.5 }];

test("backtest: priceAt picks nearest-before; gradeEvent mirrors the worker semantics", () => {
  assert.equal(priceAt(SERIES, 5 * 3600_000).price, 100);
  assert.equal(priceAt(SERIES, DAY + 3600_000).price, 102);
  assert.equal(priceAt(null, 0), null);
  // bullish, +4% over 24h → correct
  assert.equal(gradeEvent({ chain: "btc", signal: "bullish", detected_at: 0 }, { btc: SERIES }).outcome, "correct");
  // bearish, +4% → wrong
  assert.equal(gradeEvent({ chain: "btc", signal: "bearish", detected_at: 0 }, { btc: SERIES }).outcome, "wrong");
  // under threshold (99 → 99.5 = +0.5%) → no_move
  assert.equal(gradeEvent({ chain: "btc", signal: "bullish", detected_at: 2 * DAY }, { btc: SERIES }).outcome, "no_move");
  // out of series coverage → skipped (counted, not hidden)
  assert.equal(gradeEvent({ chain: "btc", signal: "bullish", detected_at: 90 * DAY }, { btc: SERIES }).outcome, "skipped");
});

test("backtest: summarize buckets by confidence/signal/symbol and flags small samples", () => {
  const rows = [
    { signal: "bullish", symbol: "BTC", bucket: "high", outcome: "correct", movePct: 2.0 },
    { signal: "bullish", symbol: "BTC", bucket: "high", outcome: "wrong", movePct: -1.5 },
    { signal: "bearish", symbol: "ETH", bucket: "low", outcome: "correct", movePct: -3.0 },
    { signal: "bearish", symbol: "ETH", bucket: "low", outcome: "no_move", movePct: 0.2 },
  ];
  const s = summarize(rows);
  assert.equal(s.overall.directional, 3);
  assert.equal(s.overall.correct, 2);
  assert.equal(s.by_confidence.high.rate, 50);
  assert.equal(s.by_confidence.low.rate, 100);
  assert.equal(s.by_signal.bullish.avgMovePct, 0.25);
  assert.match(s.note, /fewer than 30/);
});

test("news helpers: symbol matcher + stable headline hash", () => {
  assert.equal(matchSymbols("Bitcoin ETF inflows while ETH staking grows"), "BTC,ETH");
  assert.equal(matchSymbols("Recipe of the week: avocado toast"), "");
  const h1 = headlineHash("Bitcoin ETF Inflows!");
  const h2 = headlineHash("  bitcoin   etf inflows! ");
  assert.equal(h1, h2, "normalizes case/spacing");
  assert.notEqual(headlineHash("a"), headlineHash("b"));
});

// ─── research round: sentiment lexicon, stablecoin inversion, size ratio ──
import { renderNetflowJSON, renderGraphJSON, flowDirection } from "../src/bot.js";
import { templateAnalysis, sizeVsHistory } from "../src/analyst.js";
test("headlineSentiment: lexicon, conservative on overlap", () => {
  assert.equal(headlineSentiment("Bitcoin surges to record high as ETF inflows accelerate"), 1);
  assert.equal(headlineSentiment("Exchange halts withdrawals after exploit drains funds"), -1);
  assert.equal(headlineSentiment("Bitcoin ETF inflows surge but market fears crash"), -1, "bearish wins ties");
  assert.equal(headlineSentiment("Weekly recap: everything was quiet"), 0);
});

test("sizeVsHistory: ratio vs wallet's own recent average", () => {
  const hist = [{ usd_value: 1_000_000 }, { usd_value: 3_000_000 }];
  assert.equal(sizeVsHistory(20_000_000, hist), 10);
  assert.equal(sizeVsHistory(20_000_000, []), null);
  assert.equal(sizeVsHistory(20_000_000, [{ usd_value: 0 }]), null);
});

test("STABLECOIN INVERSION: USDT inflow is bullish (dry powder), outflow bearish", () => {
  const inflow = templateAnalysis({ tx_type: "exchange_inflow", usd_value: 15_000_000, symbol: "USDT" }, null, []);
  assert.equal(inflow.signal, "bullish", "stablecoin inflow = buying power staging");
  assert.match(inflow.interpretation, /dry powder/i);
  const outflow = templateAnalysis({ tx_type: "exchange_outflow", usd_value: 15_000_000, symbol: "USDC" }, null, []);
  assert.equal(outflow.signal, "bearish", "stablecoin outflow = powder leaving");
  // native asset unchanged
  const btc = templateAnalysis({ tx_type: "exchange_inflow", usd_value: 15_000_000, symbol: "BTC" }, null, []);
  assert.equal(btc.signal, "bearish");
  // stables arriving from DeFi carry the risk-off caveat
  assert.match(inflow.interpretation, /DeFi/);
});

test("size-vs-history modulation: unusual size moves confidence", () => {
  const hist = [{ tx_type: "exchange_inflow", usd_value: 1_000_000, detected_at: 1 }, { tx_type: "exchange_inflow", usd_value: 1_000_000, detected_at: 2 }];
  const unusual = templateAnalysis({ tx_type: "exchange_inflow", usd_value: 15_000_000, symbol: "BTC" }, null, hist);
  assert.equal(unusual.confidence, 0.70, "0.65 (distribution history) + 0.05 for 15× average size");
  const usual = templateAnalysis({ tx_type: "exchange_inflow", usd_value: 15_000_000, symbol: "BTC" }, null, []);
  assert.equal(usual.confidence, 0.60);
  assert.match(unusual.related_factor, /wallet history agrees/);
  assert.match(unusual.interpretation, /15.0×/);
});

test("netflow baseline: bias requires loud-vs-history when baseline exists", () => {
  // $20M net inflow, balanced gross — but baseline is tiny → still directional
  const r1 = renderNetflowJSON(
    [{ chain: "btc", inflow_usd: 60_000_000, outflow_usd: 40_000_000, inflow_count: 5, outflow_count: 5 }],
    [], 24, null, { avg_abs_net_daily: 5_000_000 }
  );
  assert.equal(r1.totals.bias, "bearish_pressure");
  assert.equal(r1.totals.net_vs_7d_daily_avg, 4);
  // same numbers but baseline is huge → noise, balanced
  const r2 = renderNetflowJSON(
    [{ chain: "btc", inflow_usd: 60_000_000, outflow_usd: 40_000_000, inflow_count: 5, outflow_count: 5 }],
    [], 24, null, { avg_abs_net_daily: 500_000_000 }
  );
  assert.equal(r2.totals.bias, "balanced");
});

test("netflow stablecoin split: inverted bias, kept out of the native totals", () => {
  // $50M BTC inflow (bearish) + $60M USDT inflow (bullish dry powder)
  const totals = [{
    chain: "btc",
    inflow_usd: 110_000_000, outflow_usd: 0, inflow_count: 10, outflow_count: 0,
    stable_inflow_usd: 60_000_000, stable_outflow_usd: 0,
  }];
  const p = renderNetflowJSON(totals, [], 24, null, { avg_abs_net_daily: null });
  // native-asset net stays bearish (USDT excluded from it)
  assert.equal(p.totals.net_inflow_usd, 110_000_000);
  assert.equal(p.totals.bias, "bearish_pressure");
  // stablecoin section carries the inverted read
  assert.equal(p.totals.stablecoin.net_inflow_usd, 60_000_000);
  assert.equal(p.totals.stablecoin.bias, "bullish_pressure");
  assert.match(p.totals.stablecoin.note, /INVERSELY/i);
});

// ─── audit round: grading window, channel gate, directional bonus ─────
import { gradeWindowCheck, channelAllows } from "../src/bot.js";
import { computeInterestingness } from "../src/scanner.js";

test("gradeWindowCheck: only 24-36h-old calls are honestly gradeable", () => {
  const now = 100 * 3_600_000;
  assert.equal(gradeWindowCheck(now - 25 * 3_600_000, now), "due");
  assert.equal(gradeWindowCheck(now - 10 * 3_600_000, now), "young");
  assert.equal(gradeWindowCheck(now - 40 * 3_600_000, now), "expired");
});

test("channelAllows: all/directional/high gating matrix", () => {
  assert.equal(channelAllows("all", "neutral", 0.5), true);
  assert.equal(channelAllows("directional", "neutral", 0.9), false);
  assert.equal(channelAllows("directional", "bearish", 0.55), true);
  assert.equal(channelAllows("high", "bearish", 0.55), false);
  assert.equal(channelAllows("high", "bearish", 0.7), true);
  assert.equal(channelAllows(undefined, "neutral", 0), true, "default = all");
});

test("directional bonus: $1M native exchange flow reaches the ledger, stables do not", () => {
  const w = { usd_value: 1_000_000, tx_type: "exchange_inflow", symbol: "BTC", detected_at: Date.now() };
  assert.equal(computeInterestingness(w, null, []), 50, "size 30 + exchange 12 + directional 8 = threshold");
  const usdt = { usd_value: 1_000_000, tx_type: "exchange_inflow", symbol: "USDT", detected_at: Date.now() };
  assert.ok(computeInterestingness(usdt, null, []) < 50, "stablecoins skip the bonus");
  const below = { usd_value: 900_000, tx_type: "exchange_inflow", symbol: "BTC", detected_at: Date.now() };
  assert.ok(computeInterestingness(below, null, []) < 50, "sub-$1M stays out");
});
