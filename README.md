# WhaleSignal 🐳

AI-powered whale-intelligence for crypto. Detects large on-chain BTC/ETH moves,
adds market + wallet context, and posts *interpreted* alerts to Telegram — not a
raw "whale moved X" feed, but an explanation of what the facts indicate.

Runs entirely on free-tier infrastructure: Cloudflare Workers + D1 + KV +
Queues, Gemini 2.0 Flash, GitHub Actions and GitHub Pages. Total cost: $0.

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
4. **Accountability** — BTC/ETH price is snapshotted at detection time; a daily
   GitHub Action grades every prediction 24h later. Accuracy stats are computed,
   not claimed.
5. **Event clustering** — five whales depositing to Binance within 15 minutes
   is one story, not five alerts.

## Public API

All read-only, no auth, served by the bot worker:

| Endpoint | Returns |
|---|---|
| `GET /latest?limit=6` | Most recent analyzed whale events |
| `GET /stats` | Totals, 24h/7d counts, signal split, accuracy rate |
| `GET /history?limit=50&offset=0` | Paginated event history |
| `GET /wallet/:address` | Wallet profile + recent movements |

Example:

```bash
curl "https://whalesignal-bot.sthidontknow.workers.dev/stats"
```

## Dashboard

Static HTML in [`docs/`](docs/) served by GitHub Pages — charts, history
browser and wallet profiles, all client-side against the endpoints above.
No backend, no cookies, no tracking. Daily report snapshots land in
[`docs/data/daily/`](docs/data/daily/) as dated JSON files.

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

Headroom math lives in [PLAN.md](PLAN.md).

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

Phase 1 MVP shipped and running live. Sprints 1–3 (scoring, surfaces, reports,
accuracy tracking) complete — see the `[done]` markers in
[PLAN.md](PLAN.md). Current phase: watching real alerts, tuning thresholds.

## Not financial advice

This project interprets on-chain activity. It does not predict prices and
nothing here is a recommendation to buy or sell anything.
