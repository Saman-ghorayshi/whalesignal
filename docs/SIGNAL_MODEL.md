# WhaleSignal Confluence Model — v1

How a whale flow becomes a number. Every confidence value the system emits
is produced by this model — additive, explainable, and designed to be
**recalibrated from the grading ledger** once enough outcomes accumulate.

Framework follows the multi-category confluence practice used in on-chain
analytics (on-chain + technical + sentiment categories, requiring agreement
rather than a single indicator):

- [TradeAlgo — confluence across signal categories](https://www.tradealgo.com/trading-guides/crypto/crypto-trading-signals)
- [SSRN — Explainable AI multi-indicator confluence framework for crypto](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7442857)
- [CryptoQuant — exchange netflow & stablecoin reserves](https://cryptoquant.com/)
- [CryptoSlate — stablecoin exchange supply as buy pressure](https://cryptoslate.com/research-bitcoin-buy-pressure-mounts-as-stablecoin-exchange-supply-moves-higher/)
- [Nansen — on-chain token flow analysis](https://nansen.ai/post/onchain-token-flow-analysis-how-it-boosts-cryptocurrency-trading-insights)

## Category 1 — On-chain flow (the primary evidence)

| Flow | BTC/ETH | Stablecoins (USDT/USDC/DAI) |
|---|---|---|
| **Deposited to exchange** | bearish (sell-side supply) | **bullish** (dry powder staging) |
| **Withdrawn from exchange** | bullish (self-custody accumulation) | **bearish** (powder leaving) |

Stablecoins invert. Research and practice (CryptoQuant: "the inverse
applies"; CryptoSlate; Nansen) read stablecoin exchange inflows as deployable
buying power, not sell pressure. Caveat encoded in the alert text: stables
arriving from DeFi exits can be risk-off, not fresh capital.

## Category 2 — On-chain behavior & sizing

- **Wallet history** (last 5 txs): an accumulation-pattern wallet supports
  bullish/outflow reads; a distribution pattern supports bearish/inflow.
- **Size vs the wallet's own average** (`sizeVsHistory`): a transfer ≥5× the
  wallet's recent norm strengthens the signal; ≤0.25× weakens it. $5M from a
  wallet that usually moves $200K is a different event than from one that
  moves $50M.

## Category 3 — Technical regime (chart reading)

Computed per event from hourly price snapshots (`price_history` table):
- **RSI(14)** — Wilder's definition (`src/ta.js`)
- **EMA(20) vs EMA(50)** and price position → `bull_trend`, `bear_trend`,
  `oversold` (RSI ≤30), `overbought` (RSI ≥70), `choppy`
- Trends agree with same-direction calls; stretched regimes agree with
  mean-reversion calls (oversold↔bullish, overbought↔bearish)

## Category 4 — Sentiment

- **Fear & Greed index** (cached from alternative.me): fear supports bearish
  flow reads, greed supports bullish.
- **News sentiment**: lexicon score (+1/0/−1 per headline, bearish wins
  ties) summed over the asset's last 6h of matching headlines. Needs ≥2
  matching headlines before it counts — one headline is noise.

## The composite

`flowConfidence()` — base 0.60, additive adjustments:

| Feature | Aligned | Conflicting |
|---|---|---|
| Fear & Greed regime | +0.05 | −0.05 |
| Wallet history | +0.05 | −0.05 |
| TA regime alignment | +0.08 | −0.08 |
| Size vs wallet norm (≥5× / ≤0.25×) | +0.05 | −0.05 |
| News sentiment (≥2 headlines) | +0.05 | −0.05 |

Hard bounds **[0.50, 0.85]**. Flows ≥$100M with unlabeled counterparties are
capped at **0.55** (treasury-migration risk — our first $425M "bearish call"
graded no_move, which is exactly this failure mode). TA weights are larger
(±0.08) because regime context is measured, not inferred; each alert lists
its applied adjustments under "Confluence:".

## Aggregate context (endpoints, not per-event)

- `/netflow` bias requires the net to be ≥5% of gross **and** ≥1.5× the
  trailing 7-day daily average — raw dollar amounts are not signals.
- `/market` exposes the current RSI/EMA/regime per coin.
- The backtester (`tools/backtest.mjs`) grades every call against hourly
  prices and reports **edge vs the market's own up/down base rate** —
  accuracy in a trending market is not skill.

## Calibration plan (the honest part)

The weights above are priors, not fitted values. The grading worker writes
every outcome with its confidence bucket; once ≥200 graded calls exist:
1. Accuracy per confidence bucket from the `outcome:*` counters.
2. If high-bucket accuracy isn't materially above low-bucket, the buckets
   are miscalibrated → fit logistic weights on the logged features
   (direction, regime, size ratio, sentiment, bucket) and ship as v2.
3. Per-asset and per-exchange splits from `wallet_stats` before trusting
   any wallet's public track record on fewer than 10 graded calls.

## Explicit non-goals

- No order-book or derivatives data (funding, OI) — candidate for v2.
- No UTXO age/SOPR — needs indexed chain data we don't have at free tier.
- No ML scoring until the ledger can train and validate on ≥1,000 outcomes.
