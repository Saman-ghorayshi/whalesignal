# Worker-by-Worker Changes & Cross-Project Audit

Everything that changed in each deployed worker (so downstream projects and
integrations can be updated), plus the audit of the OTHER projects sharing
this Cloudflare account.

---

## Part 1 — WhaleSignal workers: what changed, per worker

### whalesignal-scanner

| Change | Detail | Watch out for |
|---|---|---|
| BTC extraction rewrite | One whale = largest single non-change output (was: sum of ALL outputs attributed to the first output's address). Exchange sweeps no longer fabricate $100M "whales" | Old rows used the old semantics — historical comparisons shift after Sep 18 |
| Plumbing valve | `exchange_internal` under $5M (tunable `config:internal_floor`) never stored | Stored volume dropped ~98% — that is intended |
| Directional bonus | $1M+ native exchange flows score +8 → reach the analysis ledger ($1M-5M previously skipped) | More alerts analyzed; stablecoins excluded |
| Label map → KV | The wallets-table full scan (unindexable OR-NULL filter) ran per isolate creation ≈ 10M reads/day. Now: KV-cached (`labels:json`, hash-guarded writes), D1 fallback uses `idx_wallets_type` | `wallets` rows with `label IS NULL AND type NOT IN (exchange set)` are no longer in the map — only classification-relevant rows ever were |
| Wallet infos per-candidate | `fetchWalletInfos` — one indexed IN query per tick (raw+lowercase variants) replaces the full wallets scan | `lower(address)` on the column defeats indexes — pattern removed everywhere |
| First-sight wallet INSERT | New wallets get a row on first sighting (was UPDATE-only → tx_count never accumulated → whale auto-label never fired) | `wallets` table now grows with real whales — expected |
| Status counters | `status:pending/skipped` at insert; `status:done/failed` transitions in the analyst | Backfilled to 3,489 done / 101,065 skipped |
| Per-tick rows_read logging | Every tick logs total + top-4 queries by rows read | Any future read burn names itself in `wrangler tail` |
| Multi-source prices | CoinGecko → Coinbase → Kraken → Bitstamp → OKX → Coinpaprika → Binance, median consensus, 2% agreement flag (`prices_from` in market_cache, exposed on /market) | Binance/Coinbase geo-blocks from some egress — chain degrades gracefully |
| Price history | Hourly BTC/ETH snapshots to `price_history` (2 writes/hour) → TA regimes (RSI/EMA) live via /market and the confluence model | Needs 51 hourly rows after fresh deploy — backfilled 90d on Sep 18 |
| News: 8 sources + rotation | CoinDesk, Cointelegraph, Decrypt, NewsBTC, CryptoSlate, BitcoinMagazine, TheBlock RSS + GDELT DOC API; start feed rotates per 5-min slot | GDELT JSON needs no key |
| Cap guard | D1 read-cap hit → `config:auto_paused` (30 min, self-expires, separate from admin's `config:paused`) | Old guard key `config:paused` self-heals/clears |

### whalesignal-analyst

| Change | Detail | Watch out for |
|---|---|---|
| Confluence model | `flowConfidence()` — 6 documented categories (docs/SIGNAL_MODEL.md), bounds [0.50, 0.85], treasury-migration cap 0.55 | Weights are priors until calibrated |
| Stablecoin inversion | USDT/USDC/DAI inflow = bullish (dry powder), outflow = bearish — inverse of native assets | Any external consumer assuming "inflow=bearish for all symbols" must split by symbol class |
| Per-regime + fitted weights | `config:flow_weights_bull/_bear/_choppy` → generic `config:flow_weights` → defaults; regime selected per event from the TA engine | Weights sanitized (0–0.12/bucket); garbage in KV is ignored |
| Derivatives feature | Funding-rate crowding (contrarian, ±0.05) from market cache | Requires derivatives panel to answer; nulls skip the feature |
| Market context cache | 400-row price read + news sentiment per event → 60s isolate cache | — |
| Gemini prompt | Now includes TA regime + news sentiment facts | — |
| Signal rollups | `hourly_stats` bullish/bearish/neutral + counters at analysis time | — |
| Daily LLM news scoring | Hourly cron (`7 * * * *`): one batched call scores ≤20 headlines (llm_sentiment/llm_event/scored_at on `news`) | New columns were MISSING from prod until Sep 18 — if you deploy from an old dump, run the ALTERs |
| Daily market brief | One LLM call/day → `daily_brief` KV → bot posts at 18:00 UTC | Analyst still never touches Telegram |

### whalesignal-bot

| Change | Detail | Watch out for |
|---|---|---|
| New endpoints | `/netflow`, `/graph`, `/market`, `/news`, `/alerts/export` (+`since_id`), `/feed.xml`, `/health` — all rollup-backed or cached; `/feed.xml` = RSS of directional calls only | All quantized/cache-guarded; `since_id` bypasses cache (indexed, bounded) |
| Grading worker | 15-min cron: grades 24–36h-old directional calls, vol-adaptive threshold per asset, CAS-guarded; 'expired' closes missed windows | Threshold = max(1%, half of 7d dailyized vol) — same semantics in tools/backtest.mjs |
| Scoreboard | 18:00 UTC daily post: graded counts, accuracy, biggest closed calls | Skips silently when nothing graded in 24h |
| Daily brief delivery | Posts the analyst's `daily_brief` after the scoreboard | — |
| 👍/👎 feedback | Inline buttons on every channel alert → `alert_feedback` + `feedback:*` counters, exposed in /stats | One reaction per reader per event |
| Channel mode gate | `config:channel_mode` = all/directional/high — set to **directional** in prod on Sep 18 | Neutral alerts still analyzed/graded; only channel posting is gated |
| Retention | Monthly prune of raw whales older than 18 months (rollups keep forever) | Runs on the 1st of each month at the grading tick |
| Wallet API upgrade | `/wallet/:addr` adds lifetime flow stats, accumulator/distributor direction, track record (graded/correct), top counterparties | — |
| Instrumentation | queueHandler batches log rows_read when > 500 | — |

### whalesignal-admin

| Change | Detail |
|---|---|
| Full knob surface | `/api/config` returns every config key + AI key status (was pause-flags only) |
| Knob writes | `POST /api/knob` — whitelisted: channel_mode (enum), internal_floor/eval_min_age_h/min_usd (bounded numbers), flow_weights (per-key clamp 0–0.12). `validateKnob()` is pure + unit-tested |
| Reanalyze fix | Queue message now carries `chain` |
| Known gap | Panel HTML has knobs UI but no channel-mode/weights controls yet; `collectCounts` now reads rollups (the old version full-scanned whales per 30s poll — THE cap-trip root cause) |

---

## Part 2 — OTHER projects on this account (audit results)

The D1 free cap is account-wide, so every project below shares WhaleSignal's
budget. Measured over 24h (Sep 17→18): whalesignal 10.0M, ghanonyar 24K,
mechanicfriend 46, battery-relay/cryptopay ≈ 0. **Reads are NOT the shared
problem today — WhaleSignal was, and the fix landed.**

### 🚨 cryptopay — CRITICAL: hardcoded secrets guard money endpoints

- `PAY_SECRET_CONST` and `ADMIN_SECRET_CONST` are **plaintext literals in the
  bundle** (lines 42–43), used as the fallback for `/verify`, `/invoice`,
  `/debit`, `/grant` — the endpoints that credit and spend user gems. The
  comment above them claims "the deployed worker source contains no secret
  literals" — it does.
- `checkSecret`/`checkAdminSecret` use `===` (timing-unsafe compare).
- **Fix procedure (do it in this order):**
  1. `npx wrangler secret put ADMIN_SECRET` + `PAY_SECRET` with NEW values
     (the old constants are burned — treat them as leaked).
  2. Update the bot (and anything calling cryptopay) to send the new values.
  3. Edit the source: delete both consts, make `paySecret()/adminSecret()`
     return `env.*` only (fail closed when unset). Redeploy.
  4. Use a constant-time compare (crypto.subtle.timingSafeEqual or a
     double-hash pattern) instead of `===`.
- Also: 4× `COUNT(*)` full-table scans per admin-stats call — fine at 40KB,
  will grow; move to counters when users > 100K.

### battery-relay / battery-relay-staging

- Auth is decent (min-length key + salted SHA-256 compare).
- **Latent issue**: `daily_stats` refresh runs correlated `COUNT(*)` subqueries
  with `date(created_at, 'unixepoch') = day` — non-sargable (the date function
  on the column defeats indexes). Harmless at 156KB/456KB tables; will degrade
  as `events` grows. Fix when events > ~100K: generate daily_stats rows from a
  scheduled worker at insert time (same rollup pattern as whalesignal), or add
  expression indexes.
- Staging mirrors production code — apply any fix to both.

### ghanonyar (fifth DB, no worker on this account)

- 8.9MB, 24K reads + 30K writes per day — whatever writes it is healthy and
  light. No action.

### mechanicfriend

- 1.5MB, essentially idle (46 reads/24h). No action.

---

## Cross-cutting recommendations for the whole account

1. **Account isolation**: WhaleSignal competes with 5 databases for the shared
   5M reads/day. Either migrate WhaleSignal to its own free account
   (docs/MIGRATION.md, 30–45 min) or move the quiet projects out. Post-fix
   steady state for WhaleSignal alone is <500K/day, so isolation is comfort,
   not necessity — until any neighbor grows.
2. **Secrets hygiene**: the cryptopay pattern (const fallback for secrets)
   exists nowhere in WhaleSignal — keep it that way. Audit any new worker for
   literals before deploy.
3. **Rotation legitimacy**: multi-key rotation (CG_KEYS, etherscan) is fine
   with a handful of real accounts; key farms violate ToS.
