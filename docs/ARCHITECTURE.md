# WhaleSignal Platform Architecture — the puzzle

WhaleSignal (whale flows) is **one piece**. This document is the blueprint for
the full intelligence platform: every module, its data sources, its algorithm,
and how the pieces glue together. All free-tier; paid sources listed as
optional upgrades only.

```
                    ┌─────────────────────────────────────────────┐
 DATA LAYER         │ scanner (chains) · market feeds · news      │
                    │ · derivatives · price history               │
                    └──────────────────┬──────────────────────────┘
                                       ▼
                    ┌─────────────────────────────────────────────┐
 SIGNAL LAYER       │ whale flows · netflow index · TA regime     │
                    │ · derivatives crowding · news sentiment     │
                    │ → confluence model (SIGNAL_MODEL.md)        │
                    └──────────────────┬──────────────────────────┘
                                       ▼
                    ┌─────────────────────────────────────────────┐
 TRUTH LAYER        │ grading ledger (24h, honest windows)        │
                    │ backtester (edge vs market baseline)        │
                    └──────────────────┬──────────────────────────┘
                                       ▼
                    ┌─────────────────────────────────────────────┐
 DISTRIBUTION       │ Telegram channel/DM · dashboard · JSON API  │
                    │ · paper trader feed · daily scoreboard      │
                    └─────────────────────────────────────────────┘
```

---

## Piece 1 — Whale flows (BUILT)

Scanner → classification → interestingness → directional templates →
confluence → grading. See SIGNAL_MODEL.md. Label discovery now grows from
our own data (sink-candidate auto-discovery).

**Known limit**: BTC label coverage (~24 wallets). Every label expansion
multiplies signal coverage.

## Piece 2 — Market regime engine (BUILT, evolving)

TA from hourly prices (RSI/EMA regime) + Fear&Greed + **derivatives crowding
(funding + OI — Binance fapi, keyless)**. The 2026 regime literature treats
funding/basis/OI as *state variables* (path-signature, HMM papers below) —
ours feeds them into the composite as a contrarian feature.

**Next algorithms** (in build order):
- Spot-perp basis as a second state variable (Binance premiumIndex already
  returns it: `lastFundingRate` companion `markPrice` vs index)
- OI-direction × price-direction matrix (4 regimes: trend confirm, squeeze,
  capitulation, distribution)
- HMM-lite regime states once the ledger can validate (≥200 graded calls)

## Piece 3 — News & narrative engine (PARTIAL)

Have: 7 RSS feeds → keyword filter → lexicon sentiment → per-alert matching +
Gemini prompt facts. **Next**:
- Daily LLM narrative digest (1 call/day): "what the news says about why
  whales moved" → channel post
- Event-news correlation table (news ↔ whale events within ±2h) → makes
  /news a queryable "narrative around flows" dataset
- **CryptoPanic token** (free — we already support `NEWS_TOKEN`)

## Piece 4 — Stablecoin / liquidity context (NEXT)

DefiLlama (keyless): total stablecoin supply 7d change → the research's own
caveat is checkable: inflows during flat supply = rotation, during rising
supply = fresh capital. One KV-cached call/day; adds a context line to
/netflow and a feature to the composite.

## Piece 5 — On-chain depth (FUTURE, needs keys/budget)

SOPR, MVRV, dormancy, coin-days-destroyed need indexed chain data
(Glassnode/CryptoQuant are paid; Chainbase/Allium have free tiers). Defer —
the flow-side signals above are free and already differentiated.

## Piece 6 — Truth layer (BUILT — the differentiator)

Grading ledger (24h, honest windows, expired handling) + backtester with
edge-vs-baseline. **This is what makes the platform defensible**: every
signal category gets validated or killed by data. The backtester's
by-regime and by-confidence breakdowns tell us which features deserve their
weights (calibration plan in SIGNAL_MODEL.md).

## Piece 7 — Distribution & monetization (PARTIAL)

Telegram channel + scoreboard + DM bot (premium waitlist live) + dashboard
+ JSON API + paper-trader feed. Monetization gate: the accuracy ledger
(PLAN.md Phase C) — sell speed/depth/history, never predictions.

---

## Free APIs — get these keys (they plug into existing code)

| # | Key | Where to get | What it unlocks | Already wired? |
|---|---|---|---|---|
| 1 | **CryptoPanic auth token** | cryptopanic.com/developers/api/ (free account) | curated news + sentiment votes | ✅ set `NEWS_TOKEN` |
| 2 | **CoinGecko demo key** | coingecko.com/en/api (free) | kills the 429s on prices | ✅ set `CG_KEY` |
| 3 | **Etherscan API key** | etherscan.io/apis (free) | full-rate ETH scanning | ✅ set `ETHSCAN_KEY` |
| 4 | CoinMarketCap key | coinmarketcap.com/api (free tier) | extra price source | phase 2 |
| 5 | Santiment sanApi | santiment.net (free tier, limited metrics) | some on-chain/social metrics | phase 2 |
| 6 | Binance / Bybit | **no key needed** (public endpoints) | funding, OI, basis — already live | ✅ |
| 7 | DefiLlama | **no key needed** | stablecoin supply, TVL | phase: Piece 4 |
| 8 | GDELT / RSS | **no key** | global news breadth | ✅ (7 feeds) |
| 9 | Reddit API (free OAuth) | reddit.com/prefs/apps | r/Crypto sentiment | phase 2 |
| 10 | Glassnode/CryptoQuant | **paid** — skip until revenue | SOPR/MVRV depth | deliberately deferred |

## Research base

- [Path Signatures for Regime Detection in Crypto (2026)](https://nhsjs.com/2026/path-signatures-for-regime-detection-in-cryptocurrency-markets-a-rough-path-framework-using-spot-perpetual-basis-and-funding-rates/) — funding/basis as state variables
- [HMM regime detection preprint (2026)](https://www.preprints.org/manuscript/202603.0831) · [K-Means+HMM study](https://www.researchgate.net/publication/401135300_Market_Regime_Detection_in_Bitcoin_Time_Series_Using_K-Means_Clustering_and_Hidden_Markov_Models)
- [Funding rate market structure (MDPI 2026)](https://www.mdpi.com/2227-7390/14/2/346)
- [Philadelphia Fed WP26-42 — whale alerts and returns](https://www.philadelphiafed.org/-/media/FRBP/Assets/working-papers/2026/wp26-42.pdf)
- [Do Bitcoin whales generate alpha? (2025 thesis)](https://dspace.cuni.cz/bitstream/handle/20.500.11956/196885/120498252.pdf) · [whale-signal data study](https://deepbluealpha.io/research/whale-signals-that-work-data-study) — aggregator flows > individual tx tracking
- [Kraken — funding as a contrarian signal](https://www.kraken.com/learn/futures-trading-funding-rate-strategy) · [Blofin — funding regimes](https://blofin.com/en/academy/education/trading/funding-and-open-interest-signals)
