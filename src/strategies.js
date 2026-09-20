// src/strategies.js — the strategy tournament: several research-grounded
// paper-trading strategies over the SAME hourly price feed, scored by the
// SAME accounting, so forward results say which approach actually earns.
//
// CONTRACT (all strategies are pure):
//   input  ctx = { prices: [{ts, price}] oldest→newest, whaleNet24h?, newsNet? }
//   output {-1 | 0 | 1 }  — target position for the NEXT hour (long/flat/short)
// Decisions at bar i may use data ≤ i only; the tournament engine applies the
// position to bar i+1's return. No lookahead, ever — that's the whole point
// of running a fair tournament.
//
// Honest notes:
//   - fixed notional (start equity 1000), no leverage, long/flat/short
//   - 0.1% fee per position CHANGE (taker-ish), no funding costs modeled
//   - hourly granularity: these are swing strategies, not HFT

export const FEE = 0.001; // 0.1% per position change

// ─── strategy: momentum / Donchian-style breakout ─────────────────────
// Trend-following with a volatility-scaled lookback: long above the N-bar
// high when the tape is a bull trend, short below the N-bar low in a bear
// trend, flat in chop. The regime comes from the same EMA logic as ta.js.
export function momentumBreakout(ctx, { lookback = 24 } = {}) {
  const ps = (ctx.prices || []).map((p) => p.price);
  if (ps.length < lookback + 26) return 0;
  const closes = ps.slice(0, -1); // decide on closed bars only
  const window = closes.slice(-lookback);
  const ema = (n) => {
    let e = closes[closes.length - n];
    for (let i = closes.length - n + 1; i < closes.length; i++) e = e + (2 / (n + 1)) * (closes[i] - e);
    return e;
  };
  const e20 = ema(20), e50 = ema(50);
  const last = closes[closes.length - 1];
  const hi = Math.max(...window), lo = Math.min(...window);
  if (last > hi && e20 > e50) return 1;
  if (last < lo && e20 < e50) return -1;
  // ride the position while the trend holds; exit to flat on regime flip
  if (e20 > e50 && last > e50) return 1;
  if (e20 < e50 && last < e50) return -1;
  return 0;
}

// ─── strategy: mean reversion (RSI extremes) ──────────────────────────
// Wilder RSI; fade exhaustion moves back toward the mean. Works in ranges,
// bleeds in trends — the tournament says which regime we're actually in.
export function meanReversion(ctx, { period = 14, lo = 30, hi = 70 } = {}) {
  const ps = (ctx.prices || []).map((p) => p.price);
  if (ps.length < period + 30) return 0;
  const closes = ps.slice(0, -1);
  let gains = 0, losses = 0;
  const start = closes.length - period;
  for (let i = start + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  const rsi = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  if (rsi <= lo) return 1;   // oversold → long
  if (rsi >= hi) return -1;  // overbought → short
  // hold the position while RSI is extreme-ish; flat in the mid-band
  if (rsi < 45) return 1;
  if (rsi > 55) return -1;
  return 0;
}

// ─── strategy: whale-follow (our own graded ledger as the edge) ───────
// Follow the net directional whale-flow imbalance from hourly_stats over the
// last 24h: strongly more bullish calls than bearish → long, inverse → short.
// This is the strategy that directly tests "do whale flows predict price?"
export function whaleFollow(ctx, { minImbalance = 3 } = {}) {
  const net = Number(ctx.whaleNet24h); // bullish count − bearish count (24h)
  if (!Number.isFinite(net)) return 0;
  if (net >= minImbalance) return 1;
  if (net <= -minImbalance) return -1;
  return 0;
}

// ─── strategy: narrative (news clusters + market state) ───────────────
// LIVE-ONLY (the news graph has no long history to backtest). Follow the
// market-state gauge when a news narrative corroborates it.
export function narrative(ctx) {
  const score = Number(ctx.marketStateScore);
  const narrNet = Number(ctx.newsNarrativeNet) || 0;
  if (!Number.isFinite(score)) return 0;
  if (score >= 65 && narrNet > 0) return 1;
  if (score <= 35 && narrNet < 0) return -1;
  if (score >= 65) return 1;
  if (score <= 35) return -1;
  return 0;
}

export const STRATEGIES = {
  momentum: momentumBreakout,
  meanrev: meanReversion,
  whale_follow: whaleFollow,
  narrative,
};

// ─── strategy: momentum, slow variant ─────────────────────────────────
// The backtest showed hourly momentum churns 274 trades in 94 days and fees
// eat it alive. The slow variant demands a deeper breakout and only rides
// established trends — the tournament decides whether selectivity fixes it.
export function momentumSlow(ctx) {
  return momentumBreakout(ctx, { lookback: 72 });
}
STRATEGIES.momentum_slow = momentumSlow;

// ─── tournament engine (pure; shared by backtest and the live cron) ───

/** One hour of accounting. Returns the new state. */
export function step(state, bar, target, { fee = FEE, notional = 1000 } = {}) {
  const pos = [-1, 0, 1].includes(target) ? target : 0;
  let pnl = 0;
  if (state.position !== 0 && bar.prevPrice > 0) {
    pnl = state.position * (bar.price / bar.prevPrice - 1) * state.equity;
  }
  let equity = state.equity + pnl;
  const trades = pos !== state.position ? 1 : 0;
  if (trades) equity -= equity * fee; // charge on position change
  return { position: pos, equity, trades };
}

/** Run a strategy over a price series, walk-forward. Returns hour-by-hour
 *  equity + summary metrics. Strategies only look at recent bars, so the
 *  decision window is capped (keeps the backtest O(n) instead of O(n²)). */
export function backtest(prices, strategyFn, opts = {}) {
  const ps = (prices || []).map((p) => (typeof p === "object" ? { ts: p.ts, price: p.price } : { ts: 0, price: p }));
  if (ps.length < 60) return null;
  let state = { position: 0, equity: 1000 };
  let trades = 0;
  const curve = [{ ts: ps[0].ts, equity: state.equity }];
  for (let i = 1; i < ps.length; i++) {
    // data ≤ i-1 decides bar i — no lookahead
    const ctx = { prices: ps.slice(Math.max(0, i - 120), i) };
    const target = strategyFn(ctx, opts);
    const next = step(state, { price: ps[i].price, prevPrice: ps[i - 1].price }, target, opts);
    trades += next.trades;
    state = next;
    curve.push({ ts: ps[i].ts, equity: state.equity });
  }
  return { curve, trades, ...metrics(curve) };
}

/** Metrics from an equity curve. Pure. */
export function metrics(curve) {
  if (!curve || curve.length < 2) return null;
  const eqs = curve.map((c) => c.equity);
  const rets = [];
  for (let i = 1; i < eqs.length; i++) {
    if (eqs[i - 1] > 0) rets.push(eqs[i] / eqs[i - 1] - 1);
  }
  const total = eqs[eqs.length - 1] / eqs[0] - 1;
  // annualized Sharpe from hourly returns (sqrt of hours per year)
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(24 * 365) : 0;
  // max drawdown
  let peak = eqs[0], maxDD = 0;
  for (const e of eqs) {
    if (e > peak) peak = e;
    const dd = peak > 0 ? (peak - e) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    total: Math.round(total * 10000) / 100, // percent, 2dp
    sharpe: Math.round(sharpe * 100) / 100,
    maxDD: Math.round(maxDD * 10000) / 100,
    finalEquity: Math.round(eqs[eqs.length - 1] * 100) / 100,
  };
}

/** Benchmark: buy and hold BTC over the same window, same accounting. */
export function buyHold(prices, opts = {}) {
  return backtest(prices, () => 1, opts);
}
