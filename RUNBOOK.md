# WhaleSignal Runbook

Operational guide for the WhaleSignal whale-intelligence system.

## Architecture

8 Cloudflare Workers (all free tier):
- **scanner** (cron * * * * *) — 6-chain whale detection → D1 → analyst queue
- **analyst** (queue consumer) — AI analysis (Groq) → bot queue
- **bot** (HTTP + queue) — Telegram alerts, public API
- **news** (cron */2 * * * *) — 47 RSS sources → D1 + KV
- **price** (cron */10 * * * *) — OHLCV → D1, TA → KV
- **sentiment** (cron */15 * * * *) — 5-factor composite → D1 + KV
- **eval** (cron 0 * * * *) — scores predictions, leaderboard → KV
- **health** (cron */5 * * * *) — pings all workers, Telegram on failure

## Chains

| Chain | Source | Status |
|-------|--------|--------|
| BTC | Blockstream/Blockcypher | ✅ Live |
| ETH | Etherscan V2 | ✅ Live |
| BSC | Public RPC (failover ×3) | ✅ Live |
| Base | Public RPC (failover ×3) | ✅ Live |
| TRON | TronGrid | ✅ Live |
| Solana | Wallet watch (4 wallets) | ✅ Live |

## Key Endpoints

- `GET /latest` — latest whale alert
- `GET /stats` — aggregate stats
- `GET /history` — paginated whale history
- `GET /intel?view=X` — 20 analytics views
- `GET /content` — content brief for studio

## Common Issues

### Chain not scanning
Check `scanner_state`: `SELECT chain, last_block, errors FROM scanner_state`
- `errors >= 5`: Circuit breaker tripped, check RPC
- `last_block NULL`: Never primed, check `fetchLatestBlockHeight`

### D1 locked (5M reads/day)
Check indexes: `SELECT name FROM sqlite_master WHERE type='index'`
All `idx_*` should exist (migration 010).

### No Telegram alerts
1. Check bot queue: `wrangler queues list`
2. Check `delivered` table for stuck claims
3. Verify BOT_TOKEN secret: `wrangler secret list`

### AI failures
Analyst falls back to rule-based (`ai_provider='rule-based'`).
Check Groq key: `wrangler secret list -c wrangler.analyst.toml`

## Free Tier Limits

- D1: 5M row reads/day (indexed, ~500K/day actual)
- KV: 1K writes/day (~500/day actual)
- Workers: 100K requests/day
- Queues: 1M messages/month

## Credential Rotation

All secrets in chat history (2026-10-15) should be rotated:
1. Cloudflare API token
2. Telegram bot token → reset webhook after
3. Groq/Gemini/Etherscan keys
4. GitHub PAT

```bash
wrangler secret put BOT_TOKEN -c wrangler.bot.toml
# ... repeat for each worker
```
