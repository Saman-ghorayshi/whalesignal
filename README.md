# WhaleSignal 🐳

AI-powered whale-intelligence Telegram bot. Detects large on-chain moves, adds
context (market + news + wallet history), and posts interpreted alerts — not raw
"whale moved X."

Runs 100% on Cloudflare free tier (Workers + D1 + KV + Queues).

## Build progress

Phase 1 (MVP): public channel with AI-enhanced whale alerts from BTC + ETH.
All Phase 1 items **done**: 4 src files, 3 wrangler configs, schema, seed,
wizard, deploy script, 26/26 tests green, 3-worker bundle validates clean
via `wrangler --dry-run`. See `PLAN.md` for per-item `[done]` markers.

**To actually ship it** you still need:
1. Run `python wizard.py` — answer questions, copy the printed
   `wrangler secret put` commands and run them.
2. `python deploy_all.py` — creates D1 + KV, runs schema, seeds wallet
   labels, deploys all 3 workers.
3. Set the Telegram webhook: `export BOT_TOKEN=...` then
   `python deploy_all.py --set-webhook`.
4. Add the bot as admin to your public channel.
5. Watch logs: `npx wrangler tail whalesignal-scanner`.

The first scan primes `last_block` to the current tip (no historical
whales get scanned); from the next scan onward, BTC + ETH blocks within
your USD threshold get queued → analyzed → posted. Realistic latency is
_block time + 1min scan + 3-5s Gemini + 1s Telegram_, not the plan's
"30s cron" — that isn't achievable on free-tier cron (real floor is 1min).

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
