# WhaleSignal 🐳

[![tests](https://github.com/Samsha/whalesignal/actions/workflows/test.yml/badge.svg)](https://github.com/Samsha/whalesignal/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

AI-powered whale-intelligence for crypto. Detects large on-chain BTC/ETH moves,
adds market + wallet context, and posts *interpreted* alerts to Telegram — not a
raw "whale moved X" feed, but an explanation of what the facts indicate.

**By the numbers** (live, self-graded): 100K+ on-chain events processed ·
$960B+ analyzed volume · directional signals graded against price 24h later ·
read-heavy endpoints served from rollups with ~1000× less database reads ·
**$0/month** infrastructure.

Runs entirely on free-tier infrastructure: Cloudflare Workers + D1 + KV +
Queues, Groq + Gemini (multi-provider chain), GitHub Actions and GitHub Pages.

| | |
|---|---|
| 📊 **Live dashboard** | [saman-ghorayshi.github.io/whalesignal](https://saman-ghorayshi.github.io/whalesignal/) |
| 🤖 **Bot** | [@Whalynbot](https://t.me/Whalynbot) on Telegram |
| 📢 **Alert channel** | [@Whaletracker_sig](https://t.me/Whaletracker_sig) |
| 🔌 **Public JSON API** | `https://whalesignal-bot.sthidontknow.workers.dev/latest` |

---

## How it works

```
blockchain.info ──┐                          ┌── CoinGecko (prices)
etherscan V2 ─────┤   ┌───────────┐   KV      │
                  ▼   ▼           ▼   ▼       │
            ┌─────────────────────────────┐   │  every 60s
            │ scanner (cron worker)       │◄──┘
            │ • new blocks on BTC + ETH   │
            │ • native txs + ERC20 logs   │
            │ • USD filter ($500K+)       │
            │ • interestingness score     │── low score → stored, no AI
            │ • classify exchange flows   │
            └──────────────┬──────────────┘
                           │ Cloudflare Queue
                           ▼
            ┌─────────────────────────────┐
            │ analyst (queue consumer)    │
            │ • template analysis first   │── obvious case → no AI call
            │ • Gemini for the ambiguous  │
            │ • evidence-only prompting   │
            └──────────────┬──────────────┘
                           │ Cloudflare Queue
                           ▼
            ┌─────────────────────────────┐        ┌──► Telegram channel
            │ bot (webhook + consumer)    ├────────┤
            │ • alert formatting          │        ├──► GET endpoints (JSON)
            │ • event clustering          │        └──► R2 export (trading loop)
            │ • DM commands               │
            └─────────────────────────────┘

  GitHub Actions (cron): daily reports · 24h prediction evaluation · paper-trading loop
  GitHub Pages:          this static dashboard, fed by the GET endpoints
```

**Why three workers?** The Gemini call takes seconds; the cron scan must not
block on it. Queues decouple scan → analyze → deliver so each stage fails and
retries independently.

## What makes alerts different

1. **Interestingness scoring** — every candidate gets a 0–100 score (size,
   wallet age, dormancy, spam penalty, exchange involvement). Below threshold
   it's stored but never analyzed: 50–90% fewer AI calls.
2. **Templates before Gemini** — obvious patterns (exchange inflow during
   fear, internal wallet routing) get rule-based analysis with zero AI cost.
   Only genuinely ambiguous events reach the model (~80% savings).
3. **Evidence-only prompts** — when Gemini runs, it receives structured facts
   and explicit anti-speculation rules. No "this could potentially lead to…"
4. **Accountability** — BTC/ETH price is snapshotted at detection time; a
   worker grades every directional call against the real price 24h later
   (`correct / wrong / no_move`), tracks accuracy per confidence bucket and
   per wallet, and posts a daily scoreboard to the channel. Accuracy stats
   are computed, not claimed — and nothing is cherry-picked.
5. **Event clustering** — five whales depositing to Binance within 15 minutes
   is one story, not five alerts.

## Public API

All read-only, no auth, served by the bot worker:

| Endpoint | Returns |
|---|---|
| `GET /latest?limit=6` | Most recent analyzed whale events |
| `GET /stats` | Totals, 24h/7d counts, signal split, accuracy rate |
| `GET /netflow?window=24&chain=btc` | Exchange netflow index — USD onto vs. off exchanges, per chain and per exchange, with a plain-language bias (cached 3 min) |
| `GET /graph?window=24&min_usd=&limit=` | Aggregated whale flow edges (from, to, volume) for the network view (cached 3 min) |
| `GET /history?limit=50&offset=0` | Paginated event history |
| `GET /wallet/:address` | Wallet profile, lifetime exchange-flow direction, top counterparties |

Example:

```bash
curl "https://whalesignal-bot.sthidontknow.workers.dev/stats"
```

## Dashboard

Static HTML in [`docs/`](docs/) served by GitHub Pages — charts, the whale
flow graph ([graph.html](docs/graph.html): nodes are wallets/exchanges, red
edges flow onto exchanges, green edges flow off — click any node for its
profile), history browser and wallet profiles, all client-side against the
endpoints above. No backend, no cookies, no tracking. Daily report snapshots
land in [`docs/data/daily/`](docs/data/daily/) as dated JSON files.

## Run your own

```bash
# 1. configure (writes config locally, prints secret commands)
python wizard.py

# 2. create infra + deploy all three workers
python deploy_all.py

# 3. wire the Telegram webhook
export BOT_TOKEN=...
python deploy_all.py --set-webhook

# 4. watch the first scans
npx wrangler tail whalesignal-scanner
```

You'll need free accounts/keys: Cloudflare, a Telegram bot token
(@BotFather), [Google AI Studio](https://aistudio.google.com/apikey)
(Gemini), [Etherscan](https://etherscan.io/apis). Optional: CryptoPanic for
news context, Hyperliquid testnet for the trading loop.

### GitHub Actions setup

Fork/push the repo, then set these repo secrets:

| Secret | Used by |
|---|---|
| `BOT_TOKEN` + `PUBLIC_CHANNEL` | Daily Report |
| `GEMINI_KEY` | Trade Loop, Weekly Review |
| `WS_BOT_TOKEN` + `WS_CHAT_ID` | Weekly Review DMs |
| `HL_TESTNET_KEY`, `R2_ALERTS_URL` | Trade Loop (paper trading) |

Workflows run on their own crons after that — no maintenance.

## Tests

```bash
node tests/run_tests.js
```

Plain `node:test` + asserts, zero dependencies. Covers classification, scoring,
templates, prompt building, parsing, alert formatting, clustering notes and
end-to-end queue flow through a mocked Worker runtime.

## Free-tier budget

| Resource | Limit/day | Typical use |
|---|---|---|
| Worker requests | 100K | ~3.5K |
| D1 writes | 10K | ~600 |
| D1 reads | 100K | ~6K |
| KV writes | 1K | ~330 (tightest — market cache is TTL-gated) |
| Queue ops | 10K | ~600 |
| Gemini calls | 1,500 | ~20–40 after scoring + templates |

Headroom math: ~312 KV writes/day of the 1K cap; LLM calls routed through a
Groq → Gemini chain with templates absorbing ~80% of alerts.

## Layout

```
src/
  scanner.js      cron worker: blocks → candidates → scores → queue
  analyst.js      queue worker: templates / Gemini → analysis rows
  bot.js          webhook + delivery + public GET routes
  worker-utils.js shared pure helpers
schema/           D1 schema (additive migrations only)
wallet_labels/    seed data for known exchanges
trading_loop/     experimental paper-trading bot (Hyperliquid testnet)
tools/            daily report + prediction evaluation scripts
tests/            node:test suites
docs/             static dashboard (GitHub Pages)
.github/workflows trade · weekly review · daily report · evaluate predictions
```

## Status & roadmap

**Running live.** Phase 1 MVP + Sprints 1–3 shipped (interestingness scoring,
multi-surface APIs, daily reports, 24h prediction grading, multi-provider
LLM chain with `/chain` + `/setkey`, token-gated admin worker, webhook
dedup, scanner failover). Sprint 4 (full roadmap: [PLAN.md](PLAN.md)):

- **Directional signals actually fire now** — exchange inflow → bearish,
  outflow → bullish (context modulates confidence). The first three weeks
  produced 0 bullish / 0 bearish / 100% neutral because flow direction was
  gated on market fear/greed + wallet history that first-sight whales don't
  have, and the label set only covered 7 BTC exchange wallets (every event
  classified `wallet_to_wallet` — the real root cause, fixed by expanding
  labels + `tools/harvest_labels.mjs`)
- **Exchange netflow + flow graph** — `/netflow` and `/graph` endpoints,
  `docs/graph.html` network view, netflow card on stats, per-wallet
  accumulator/distributor direction + top connections
- **BTC extraction rewrite** — one whale = one large single transfer
  (largest non-change output); sweeps/consolidations no longer fabricate
  $100M "whale moves"; exchange-internal routing under $5M is never stored
- **Accountability engine** — every bullish/bearish call is graded 24h later
  by a worker cron; outcomes roll up into counters (per confidence bucket)
  and per-wallet track records (`wallet_stats`), and a daily scoreboard
  posts to the channel. Wallet profiles expose their own hit rate.
- **Free-tier survival** — `stats_cache` collapses the scan-heavy endpoints
  to 1 row read per request, per-wallet indexes kill the biggest hidden
  full-scan, and the scanner auto-pauses 30 min when the D1 read cap trips
- Observability enabled on all workers

Current phase: accumulating the prediction ledger and public accuracy
track record (the data moat compounds from here).

## Not financial advice

This project interprets on-chain activity. It does not predict prices and
nothing here is a recommendation to buy or sell anything.
