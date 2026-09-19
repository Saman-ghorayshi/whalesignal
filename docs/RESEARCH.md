# WhaleSignal Research Notes & Laptop Layer

What the 2025–2026 literature says, what it means for us, and what your
laptop (10h/day) unlocks that the free cloud tier never can.

---

## 1. What the papers actually say

### Whale signals: contested, context-dependent
- [Philadelphia Fed WP26-42](https://www.philadelphiafed.org/-/media/FRBP/Assets/working-papers/2026/wp26-42.pdf) — whale trades propagate into returns, but effects are state-dependent.
- [Whale alpha thesis (2025)](https://dspace.cuni.cz/bitstream/handle/20.500.11956/196885/120498252.pdf) + [contrarian quant take](https://medium.com/@laostjen/on-chain-data-analysis-what-whale-wallets-really-tell-us-2443ef8a569c) + [DeepBlueAlpha data study](https://deepbluealpha.io/research/whale-signals-that-work-data-study) — individual large transactions are near coin-flips; **aggregated flows + context is where signal lives**.
- **Our read**: direction-from-one-tx is weak; direction×regime×news is the hypothesis. The grading ledger exists precisely to test this — we're running the experiment the literature says is needed.

### Volatility, not direction, is the easier whale prediction
- [Herremans & Low — whale transactions → volatility spikes (Transformer, IEEE Access 2025 update)](https://arxiv.org/abs/2211.08281) — whale data predicts *volatility spikes* with a transformer.
- **Our takeaway**: add a **vol-spike probability** to every alert ("this flow class historically precedes 2%+ hourly moves X% of the time"). Direction-agnostic, ledger-gradeable differently (did vol spike? no direction bet), and honestly easier to be right about. `tools/laptop/` will compute historical vol-spike rates per flow class.

### Regime-adaptive weights beat static weights
- [Regime-Aware LLM Agents for Crypto (SSRN)](https://papers.ssrn.com/sol3/Delivery.cfm/7031478.pdf?abstractid=7031478&mirid=1) — regime-conditioned agents; taxonomy: news-driven / reasoning-driven / RL-driven.
- [PeerJ CS — adaptive LLM multi-agent quant trading](https://peerj.com/articles/cs-3630.pdf) — TA underperforms because markets adapt; **"lacks adaptive features" is the named gap**.
- [CryptoTrade (OpenReview)](https://openreview.net/pdf?id=J4LCttjx1e) — benchmarks on bull AND bear separately.
- **Our read**: our confluence weights are static priors. The loop closes now: laptop fits per-regime weights from the ledger → publishes to KV → production picks them up. (Built this round — see §3.)

### News-driven agents are a real architecture class
- [Adaptive multi-agent Bitcoin trading with an LLM (2025)](https://arxiv.org/html/2510.08068v1) · [ChatGPT news sentiment → BTC dynamics (2026)](https://link.springer.com/article/10.1186/s40537-026-01392-x) · [multi-stage LLM sentiment for signal-to-noise](https://www.mdpi.com/2673-2688/7/4/138)
- **Our takeaway**: headlines → lexicon sentiment (built) is the noise floor; the upgrade path is **LLM-scored daily narrative digests** (1 call/day, free tier) and an **event-news correlation table** (news within ±2h of a flow). Both planned; the correlation table is what makes /news a research dataset.

### Graph methods are the laptop's job
- [CryptoGAT (2026)](https://arxiv.org/html/2606.27670v1) — graph attention on crypto series beats pure time-series.
- [Bitcoin address clustering with contrastive learning (2026)](https://arxiv.org/html/2609.01942v1) — GNN clustering = the label-coverage answer without paid APIs.
- [Motif-based graph features (2026)](https://link.springer.com/article/10.1007/s10614-025-10940-1)
- **Our read**: we already store a transaction graph (from/to/amount/time). Laptop jobs, in value order: (1) co-spend/change-address clustering for BTC (grows exchange labels fast), (2) graph features per wallet (degree, in/out ratio, clustering coefficient) as confluence features, (3) motif features for the flow graph.

## 2. Free data inventory (everything usable at $0)

| Source | Keyless? | What it gives us | Status |
|---|---|---|---|
| CoinGecko | demo key free | prices, history, market data | ✅ wired (`CG_KEY`) |
| Binance fapi | yes | funding, basis, OI, LSR, taker ratio | ✅ wired |
| Bybit v5 | yes | derivatives fallback | ✅ wired |
| mempool.space / blockstream / publicnode | yes | BTC chain data (4 sources) | ✅ wired |
| Etherscan V2 | free key | ETH chain data | wired (`ETHSCAN_KEY`) |
| alternative.me | yes | Fear & Greed | ✅ wired |
| 7 RSS feeds | yes | news | ✅ wired |
| DefiLlama | yes | stablecoin supply, TVL, yields | next (Piece 4) |
| **CoinMetrics Community** | yes (free CSVs) | daily on-chain metrics for BTC/ETH (SOPR-lite inputs, fees, addresses) | laptop backtest data |
| **GDELT 2.0** | yes | global news events w/ tone, 15-min updates | news engine v2 |
| Blockchain.com charts API | yes | BTC network stats | laptop backtest data |
| Reddit API | free OAuth | r/Crypto+ r/Bitcoin sentiment | phase 2 |
| CryptoPanic | free token | curated news + votes | wired (`NEWS_TOKEN`) |
| Santiment | free tier | some social/on-chain metrics | phase 2 |
| Glassnode/CryptoQuant | **paid** | SOPR/MVRV depth | deferred until revenue |

## 3. The laptop layer (your 10h/day)

The cloud collects 24/7 (free tier sized for it). The laptop **thinks**.
Everything in `tools/laptop/` — plain node, zero dependencies, runs offline:

| Tool | What it does | Output |
|---|---|---|
| `research.mjs` (built) | pulls the graded ledger + hourly prices, builds the feature matrix, per-feature hit-rates, logistic fit → **suggested weights** | `docs/data/research/feature_report.json` (committed → dashboard) |
| `train.mjs` (next) | same fit, per-regime splits (bull/bear/choppy) → regime-conditional weight sets | `config:flow_weights_bull/bear/choppy` KV keys |
| `cluster.mjs` (next) | BTC co-spend/change-address clustering → grows exchange labels from chain data | label JSON → wallets table |
| `features.mjs` (next) | graph features per wallet (degree, in/out ratio) as candidate confluence features | research report |

**The adaptive loop this closes**: ledger → laptop fit → weights in KV →
production picks them up per regime → grading scores the new weights → repeat.
That is the "strategy that shifts with news and market" — not a human editing
numbers, a measured feedback loop.

## 4. Strategies that shift with news/regime (spec)

1. **Regime-conditional confluence weights** — bull/bear/choppy weight sets; regime from the TA engine (built). Shipping: config keys consumed per event.
2. **News-conditioned flow prior** — if asset news sentiment is extreme (|sum| ≥ 3 in 6h), raise the news feature weight for that asset (news-dominated tape) — laptop-fitted threshold.
3. **Vol-spike forecast** (Herremans-style, direction-agnostic) — per flow-class historical P(vol spike | event) → new alert field, graded on realized vol instead of direction.
4. **Basis-squeeze flag** — deeply negative basis + OI rising + price falling = forced-deleveraging window → suppress bullish flows calls (they're catching falling knives) — laptop-fitted threshold.
5. **Whale-cluster tracking** — after clustering, track *clusters* (entities), not addresses: "cluster X (47 addrs) accumulated 1,200 BTC this week" is the real Nansen-style product.

## 5. Limitations & what we do about them

| Limitation | Mitigation |
|---|---|
| No SOPR/MVRV (paid data) | CoinMetrics Community CSVs give fee/addr inputs; SOPR-lite from our own price_at_detect vs current for repeat wallets |
| Label coverage (24 BTC wallets) | sink auto-discovery (live) + laptop clustering (next) |
| Free-tier read caps | rollups + caches + indexes (done); laptop absorbs heavy analysis |
| Static model weights | adaptive loop (built this round) |
| Single-chain depth (BTC/ETH) | etherscan V2 pattern extends to Base/L2s free — after ETH coverage matures |
| No intraday OHLCV | CoinGecko hourly (have) + Binance klines (keyless, add when backtest needs candles) |

---

## 6. Sep 19 wave — four papers turned into live signal logic

Each finding below ships in `src/signal_math.js` (pure + unit-tested) and is
wired into the confluence model. Nothing here is decorative: every formula
answers a question the grading ledger can later confirm or kill.

### 6.1 Square-root law of market impact → the `√impact` feature

**Research.** Expected price impact of a metaorder scales with √(Q/V):
[A Million Metaorder Analysis of Market Impact on the Bitcoin](https://www.worldscientific.com)
confirms the law on Bitcoin specifically across four decades of order sizes;
[Tóth et al. 2016](https://www.cfm.com) extends it to options; the practitioner
form is ΔP = c·σ·√(n/V) (Quant StackExchange). Recent microstructure work
([The "double" square-root law](https://arxiv.org), Feb 2025) traces its
mechanical origin.

**Implementation.** `expectedImpactPct(ratio, dailyVolPct) = σ_daily·√(Q/V)` —
at Q = one full day of volume the model predicts ~one daily vol of impact,
matching the literature's calibration. The flow's expected impact is compared
against **the same vol-adaptive bar the grading engine uses** (max(1%, half
of daily vol)):

- expected ≥ bar → `+W.size` — the flow alone can mechanically clear the bar
- expected < bar/10 → `−W.size` — mechanically negligible, pure intent
- in between → no adjustment (most honest alerts live here)

An alert's interpretation now states the number: "Expected impact ≈0.31% vs
the 1.00% move bar".

**Honest limit.** With BTC's ~$30B daily volume, only a >$7B flow clears a
1% bar — so the boost is rare and always collides with the $100M
huge-unlabeled cap (treasury-migration guard). The damped/neutral zones are
where this feature actually earns its keep.

### 6.2 Time-of-day liquidity → the session factor

**Research.** [Wang 2020, "Time-of-Day Periodicities of Trading Volume and
Volatility in Bitcoin"](https://ideas.repec.org) documents strong intraday
volume/variance cycles tied to traditional sessions; SSRN's ["When Markets
Never Sleep"](https://papers.ssrn.com) finds crypto liquidity is mostly
"volume in disguise" — depth tracks volume.

**Implementation.** `liquidityHourFactor(ts)`: 1.15 in the thin 22:00–06:00
UTC trough, 0.9 in the thick 13:00–21:00 UTC US session, 1.0 otherwise. The
factor multiplies the expected-impact number before it's compared to the bar
— the same flow is genuinely more consequential at 03:00 UTC.

### 6.3 Dormancy / coin-days-destroyed → the reactivation feature

**Research.** Glassnode's [CDD guide](https://docs.glassnode.com/further-information/metric-guides/coin-days-destroyed/cdd-coin-days-destroyed)
and [Average Coin Dormancy](https://docs.glassnode.com/further-information/metric-guides/dormancy/average-coin-dormancy):
long-dormant coins moving is a rare, high-conviction event, historically
read as long-term-holder distribution when it lands on exchanges.

**Implementation.** We can't see UTXO age, so the proxy is our own sighting
gap: `dormancyDays(wallets.last_seen, detected_at)` — a wallet the scanner
hasn't seen doing whale-sized things for N days reactivating. ≥30d quiet →
`+W.history` (conviction behind the flow's own direction); ≥90d → the CDD
literature's "rare event" tier. `dormancyDays` treats an unknown wallet as
null, never as 1970-era dormancy (a `Number(null)=0` bug the unit test
caught before it shipped).

### 6.4 Ledger calibration → closing the accountability loop

**Research.** Standard practice: raw priors should be shrunk toward realized
accuracy with a Beta-Binomial posterior; the strength parameter encodes how
much data you demand before trusting the empirical rate.

**Implementation.** `calibrate(prior, {correct, wrong}, k=20)`:
`(k·prior + correct) / (k + n)` using the grading ledger's
`outcome:{bucket}:{outcome}` counters, bucketed by the confidence we
CLAIMED (high/mid/low, same buckets the grader uses). Engages at n ≥ 10
graded directional calls. `n` counts correct+wrong only — a no_move is a
missed move, not a wrong direction. This is the mechanism that finally makes
docs/SIGNAL_MODEL.md's "weights are priors until calibrated" true: a bad
week drags every confidence down automatically until the weights are refit.

### 6.5 Bonus fix the wave surfaced

`getMarketContext` selected `price_history.ts` — a column that doesn't exist
(the table has `hour_bucket`). The error was swallowed, so the **TA regime
component never fired in production** despite 4,400 price rows sitting in
the table. The same sweep caught the analysts' `price_history` reads being
silent-failed in tests too, because MockD1 tolerated nothing — the fixture
just never asserted `ta != null`. Both fixed; the fix ships with this wave.

### 6.6 What the end-to-end audit of this wave caught (Sep 19, second pass)

Shipping §6 with real pipeline coverage immediately caught what unit tests
couldn't — every one of these is the "looks done, isn't" class:

1. **Missing import, swallowed again**: `getMarketContext` called
   `dailyizedVolPct` without importing it. The `ReferenceError` landed in
   the same catch that guards "no price history yet" — so `ta` computed and
   `volPct` stayed null forever, disabling the √impact bar in production
   while every unit test passed. The e2e fixture now seeds 60 price rows
   and asserts the impact note actually renders.
2. **Dormancy could never fire**: the scanner stamps `wallets.last_seen ≈
   now` on the same tick it inserts the whale, so the analyst's post-hoc
   lookup always read a ~0-day gap. Fix: the pre-sighting `last_seen`
   travels on the queue message (`prev_last_seen`); messages without it
   (admin reanalyze, orphan requeue) honestly carry no dormancy signal.
3. **Two copies of the grading bar**: bot's `volThreshold` and
   signal_math's `gradingThresholdPct` were the same formula implemented
   twice — drift would silently desync the impact feature from the grader.
   The bot now delegates; one source of truth.
4. **The LLM path was blind and uncalibrated**: ambiguous events (the ones
   that NEED the LLM) got a prompt without impact/dormancy facts, and the
   LLM's claimed confidence went to the ledger raw. Both paths now share
   `computeImpactContext` for identical numbers, and ledger calibration
   applies to LLM confidence too.
5. **Dead exports** (`dormancyFactor`, an unused `impactMultiplier`) and a
   prose-only "90d tier" — removed or wired, never just documented.
