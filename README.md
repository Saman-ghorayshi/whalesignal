# WhaleSignal 🐳

AI-powered whale-intelligence Telegram bot. Detects large on-chain moves, adds
context (market + news + wallet history), and posts interpreted alerts — not raw
"whale moved X."

Runs 100% on Cloudflare free tier (Workers + D1 + KV + Queues).

## Status

Phase 1 (MVP): public channel with AI-enhanced whale alerts from BTC + ETH.
See `PLAN.md` for the full roadmap and `[done]` markers.

## Stack

- Cloudflare Workers (3: `scanner`, `analyst`, `bot`)
- Cloudflare D1 (relational storage)
- Cloudflare KV (market + news cache — kept under 1K writes/day)
- Cloudflare Queues (scanner → analyst → bot decoupling)
- Gemini 2.0 Flash free tier (AI analysis)
- Free blockchain APIs (blockchain.info, etherscan, etc.)

## Quick start

```bash
# 1. install deps (none needed at runtime — workers have no node_modules)
# 2. configure
python wizard.py           # interactive — writes config.json + prints wrangler secret commands
# 3. deploy
python deploy_all.py       # creates D1/KV/Queue, runs schema, deploys workers, seeds wallets
# 4. set the telegram webhook
python deploy_all.py --set-webhook
# 5. watch logs
npx wrangler tail scanner
```

## Layout

```
whalesignal/
  PLAN.md                  — roadmap + done markers
  README.md
  .gitignore
  wrangler.toml            — bindings for 3 workers
  config.example.json      — copy → config.json, fill in keys
  wizard.py                — interactive setup
  deploy_all.py            — one-shot deploy
  schema/
    whalesignal.sql        — D1 schema
  src/
    worker-utils.js        — shared helpers (imported by all 3 workers)
    scanner.js             — cron-triggered chain scanner
    analyst.js             — queue consumer, Gemini analysis
    bot.js                 — Telegram webhook handler
  wallet_labels/
    exchanges.json         — seed: known exchange addresses per chain
    seed.py                — loads exchanges.json into D1 wallets table
  tests/
    *.test.js              — node tests (no test runner — plain assert)
    run_tests.js           — `node tests/run_tests.js` runs everything
```

## Why three workers

A single worker can't do scanning + AI analysis + bot interaction within one
request envelope. Splitting them via a queue decouples the slow Gemini call
(3–5s) from the fast cron scan and the Telegram webhook.

## Free-tier budget

See `PLAN.md` → "LIMITS SUMMARY". TL;DR: ~600 D1 writes/day at Phase 1,
~312 KV writes/day, ~3500 worker requests/day. All well within free limits.
KV is the tightest — we use it ONLY for market_cache + news_cache.
