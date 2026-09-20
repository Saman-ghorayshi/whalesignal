
---

## Research base per strategy (arXiv / journals / practitioner studies)

Every strategy in the arena maps to published findings. Citations checked
Sep 20, 2026; honest caveats included — where a paper shows the signal is
weak or regime-dependent, that's part of the entry.

### momentum / momentum_slow — intraday time-series momentum

- **Wen, Z. (2022), "Intraday Return Predictability in the Cryptocurrency
  Markets: Momentum, Reversal, or Both", North American Journal of Economics
  and Finance 62** ([SSRN 4080253](https://papers.ssrn.com) /
  [RePEc](https://ideas.repec.org), ~51 citations) — documents BOTH intraday
  momentum and reversal in crypto; momentum dominates at short horizons,
  reversal at longer ones. This single paper justifies running BOTH our
  momentum and mean-reversion entries: the tournament lets the data pick
  which regime we're in.
- **"The Quarter-Hour Effect: Periodic Algorithmic Trading"**
  ([arXiv, Aug 2026](https://arxiv.org)) — periodic volatility/volume bursts
  at minute marks in crypto; supports intraday strategies having structure
  to exploit.
- **Bellocca et al. (2022), *Expert Systems with Applications*** — ML
  detection of momentum effects in crypto markets.
- Mapping: our breakout uses 24/72-bar Donchian levels + EMA(20/50) regime —
  a restrained version of the documented effect. Caveat: Wen's effect sizes
  are small and decay fast; fees are the enemy (see the backtest table).

### meanrev — intraday reversal

- Same **Wen (2022)** reversal component; also **"Cryptocurrency Momentum
  and Reversal"** (cross-sectional, weekly+ horizons) — reversal shows up
  when momentum exhausts.
- Mapping: Wilder-RSI(14) < 30 → long, > 70 → short. Caveat: in a strong
  trend the strategy bleeds — exactly what the 94-day backtest showed
  (−44%): honest, documented, and the reason it races rather than being
  trusted.

### whale_follow — on-chain flows → returns

- **Chi, Y. et al. (2024/25), "Return and Volatility Forecasting Using
  On-Chain Flows"** ([arXiv](https://arxiv.org) /
  [Semantic Scholar](https://www.semanticscholar.org)) — the closest match
  to our data: intraday return- AND volatility-forecasting power of on-chain
  flow data for BTC, ETH and USDT.
- **Herremans, D. et al., "Forecasting Bitcoin Volatility Spikes from Whale
  Transactions and CryptoQuant Data"** ([arXiv](https://arxiv.org) / IEEE
  2025, ~29 citations) — whale transactions + exchange data predict
  VOLATILITY spikes (stronger than direction) via attention models.
- **Chernoff, A. et al. (Federal Reserve Bank of Philadelphia), "The Hidden
  Effect of Crypto Whales"** — transaction-level evidence that large ETH
  holders move the market.
- Cautionary: industry reporting (Yahoo Finance, Jan 2026) — apparent
  "whale accumulation" is sometimes **exchange wallet maintenance**; our
  sink-promotion gate exists precisely to avoid misreading that.
- Mapping: follow the net bullish−bearish whale-call imbalance from OUR
  graded ledger (only calls the ledger has verified count). Caveat: Chi et
  al. find the strongest effects intraday with granular flow data; our
  24h-imbalance proxy is coarser.

### narrative — LLM news sentiment + market state

- **Kirtac, R. & Germano, G. (2025)** — LLM-based news sentiment drives
  portfolio decisions (referenced in ["Agentic Trading: When LLM Agents Meet
  Financial Markets"](https://arxiv.org), arXiv 2026).
- **Jung, H.S. (2025), "Detecting Bitcoin Sentiment: Leveraging Language
  Models"** ([Springer](https://link.springer.com)) — LLM sentiment +
  technical indicators improve Bitcoin prediction robustness.
- Mapping: our news graph clusters scored headlines into narratives; the
  strategy trades the market-state gauge when a narrative corroborates it.
  Caveat: LLM sentiment literature shows strongest effects at daily horizons
  on major coins — our hourly application is a reasonable stretch, not a
  proven one.

### funding_carry (planned — data accumulating now)

- **Ackerer, D. et al. (2024), "Perpetual Futures Pricing"** (Wharton,
  ~80 citations) — the funding-rate mechanism formalized.
- **Presto Research (2024), "Can Funding Rate Predict Price Change?"** —
  empirical test of funding as a return signal.
- **Helminen, S. (2022, Aalto)** — ETH funding rate vs price analysis.
- Mapping: contrarian at funding extremes (crowded longs pay shorts).
  `funding_history` started accumulating hourly rows today; the strategy
  enters the arena after enough rows exist.

### buy_hold — the baseline to beat

No paper needed: it's the market. The tournament's real question is whether
ANY active strategy beats it after fees — the 94-day backtest says not yet.

## Data sufficiency (measured Sep 20, 2026)

| Data | Status | After today's fixes |
|---|---|---|
| Hourly BTC/ETH prices | ✅ 2,252 rows (~94 days) | continues hourly |
| Whale-call ledger | ✅ grading live since Sep 19 | accumulates 24/7 |
| hourly_stats (flow rollups) | ✅ since Sep 19 | accumulates |
| News volume | ❌ 55 rows total, 3/day, 4 sources | keyword filter widened (was exchange-only), cap 5→25/refresh, +3 feeds → expect 30-100/day |
| News scoring | ✅ LLM scores 20/hour | continues |
| Funding history | ❌ did not exist | funding_history table live, hourly rows start now |
| Narrative graph | ✅ built hourly | accumulates |

## References

- [Wen 2022 — Intraday Return Predictability (SSRN)](https://papers.ssrn.com) · [RePEc](https://ideas.repec.org)
- [Quarter-Hour Effect (arXiv 2026)](https://arxiv.org)
- [Chi et al. — Return and Volatility Forecasting Using On-Chain Flows (arXiv)](https://arxiv.org)
- [Herremans et al. — Whale Transactions + CryptoQuant (ar5iv/arXiv)](https://ar5iv.labs.arxiv.org) · [IEEE](https://ieeexplore.ieee.org)
- [Chernoff et al. — The Hidden Effect of Crypto Whales (Fed Philadelphia)](https://www.philadelphiafed.org)
- [Agentic Trading: When LLM Agents Meet Financial Markets (arXiv 2026)](https://arxiv.org)
- [Jung 2025 — Detecting Bitcoin Sentiment (Springer)](https://link.springer.com)
- [Ackerer et al. 2024 — Perpetual Futures Pricing (Wharton)](https://finance.wharton.upenn.edu)
- [Presto Research 2024 — Can Funding Rate Predict Price Change?](https://www.prestolabs.io)
- [Helminen 2022 — ETH Funding Rate (Aalto)](https://aaltodoc.aalto.fi)
