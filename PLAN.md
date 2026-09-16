# WhaleSignal — PLAN

Where the product is, what to build next, and when a shop makes sense.
Written 2026-09-16 after Sprint 4 (directional signals, netflow, flow graph,
wallet flow stats, label expansion, D1 read-budget fixes).

---

## The one-sentence strategy

WhaleSignal's moat is not alerts (those are a commodity) — it is the
**graded prediction ledger** and the **wallet behavior graph**. Everything
we build should feed one of those two.

## What shipped in Sprint 4 (this repo, deployed 2026-09-16)

1. **Directional signal engine.** Exchange inflow → bearish, outflow →
   bullish, always (context only modulates confidence 0.55–0.82). Before
   this, 3 weeks of live data produced 0 bullish / 0 bearish / 100% neutral
   because first-sight whales have no history and F&G sits at 50–74 most of
   the time.
2. **Root-cause fix: exchange labels.** Live D1 showed 100% of events were
   `wallet_to_wallet` — only 7 BTC exchange labels existed, so nothing EVER
   classified as an exchange flow. Harvested 17 more from the BTC rich list
   (24 total) + 14-day backfill. Net effect of #1+#2: the pipeline can now
   actually emit bullish/bearish and grade them.
3. **BTC largest-single-output extraction.** Exchange sweeps with dozens of
   outputs were summing into fake $100M+ "whale transfers". One candidate =
   one real single transfer, change outputs skipped.
4. **Plumbing valve.** Exchange-internal routing under $5M (tunable:
   `config:internal_floor`) is never stored — it's hot↔cold routing, not a
   whale story.
5. **`GET /netflow?window=24&chain=`** — the measured bull/bear meter: USD
   onto exchanges minus off, per chain and per exchange, with a plain-language
   bias label. Cached 3 min.
6. **`GET /graph?window=&min_usd=&limit=`** — aggregated flow edges for the
   network view. `docs/graph.html` renders it (cytoscape, red=onto exchange /
   green=off, click a node → wallet profile), with a netflow strip on top.
7. **Wallet profiles upgraded.** `/wallet/:addr` now returns lifetime
   deposited/withdrawn-to-exchange USD, an accumulator/distributor/balanced
   direction badge, and top counterparties (the per-wallet graph).
   wallet.html renders all of it.
8. **`stats_cache` D1 table.** /stats, /netflow, /graph full-scanned the
   whales table per request (~200K rows for /stats — one dashboard visitor
   could burn the entire daily D1 read budget). Now: 1-row cached payload,
   3-min TTL, stale-served during D1 outages instead of 500ing.

## Known debts / honest limitations

- **Label coverage is still sparse.** 24 BTC exchange addresses catch only
  the famous hot/cold wallets — the 14-day backfill reclassified 9 real
  inflows ($611M) out of ~92K events. Netflow will read "balanced-ish"
  until coverage grows. Re-run `node tools/harvest_labels.mjs` quarterly and
  add a proper licensed label source later (Arkham/HDAPI/walletexplorer
  exports). Backfill + reclassify after each expansion (the harvester
  prints SQL-ready JSON; reuse the seed_backfill flow).
- **D1 read-cap incident (2026-09-16).** The backfill + scan-heavy endpoints
  tripped the free-tier daily row-read cap → all D1 reads 500 until midnight
  UTC. Fixed going forward by stats_cache; the first ~22h after deploy the
  heavy endpoints degrade until the cap resets. If it recurs: Workers Paid
  ($5/mo) lifts D1 limits, or add config flag to pause the scanner
  (`config:paused`) during cap-out windows.
- **Prediction ledger starts now.** All analyses before 2026-09-16 are
  neutral/unevaluated. Expect the first meaningful accuracy numbers after
  ~2 weeks of graded directional signals (evaluate.yml runs daily).

## Roadmap

### Phase A — make the track record real (next 2–4 weeks)
- [x] Directional alerts live (first: $425M BTC deposit, bearish).
- [x] Grading engine: worker cron grades every directional call 24h later
      (outcome + per-bucket + per-wallet counters) and posts a daily channel
      scoreboard at 18:00 UTC. Dashboard accuracy-by-confidence page still open:
      bucket graded predictions by confidence
      (0.55–0.6 / 0.6–0.75 / 0.75+) and show hit-rate per bucket on stats.html.
- [ ] Label expansion #2: mined cluster labels from our own data —
      destinations receiving ≥5 distinct whale senders in 7d are sink
      candidates (`type: exchange_candidate`, displayed but not sold as
      exchanges until confirmed).
- [ ] Weekly review email/DM: netflow trend + hit-rate + biggest wallets
      that flipped direction this week (weekly_review.py already runs).

### Phase B — compounding data features (weeks 2–6)
- [ ] Wallet track record on profile: for each wallet, avg 24h BTC move
      after its past deposits (uses price_at_detect + CoinGecko history,
      KV-cached). "This wallet's deposits preceded −1.8% avg moves" is the
      single most sellable stat the schema already supports.
- [ ] Dormancy alerts: first movement from wallets silent >1yr (score
      already has the dormancy bonus — promote to a distinct alert type).
- [ ] Telegram inline command `/netflow` and `/graph` (bot DM parity).
- [ ] ERC20 label expansion (USDC more issuers, LSTs) + Base/L2 scan via
      the same etherscan V2 pattern.

### Phase C — the shop (only after the ledger is real)
Gate: **100+ graded directional predictions with non-random accuracy, shown
publicly.** Before that, selling signals is selling air and adds support/
refund obligations for a free-tier product.

Sell speed, depth and history — never "predictions":
1. **Free forever:** public channel (delayed/clusted), dashboard, JSON API
   (rate-limited), accuracy page.
2. **Pro (Telegram Stars or Stripe link bot):** instant per-event DMs before
   channel clustering, full wallet profiles + track records, graph depth
   (window > 7d), weekly review DM, API key with higher rate limits.
3. **Plumbing already in place:** `delivered` is keyed per chat_id;
   `subscribers` table was pre-planned in the schema comments; admin worker
   can gate tiers.
4. Compliance posture stays as-is: interpretation of on-chain facts, not
   financial advice (README disclaimer); sell data access, not advice.

## Housekeeping
- `trades.db` (SQLite, local paper-trading artifact) is committed at repo
  root — remove before going public/commercial.
- Consider `git init` + GitHub push so deploys are reproducible.
- Quarterly: re-run label harvester, re-verify treasury/bridge contracts.
