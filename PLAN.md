# WhaleSignal AI — Expansion Plan

**Goal:** On-chain intelligence platform, not a signal channel. Explain *why*
whale movements matter using structured evidence, minimize noise, and provide
searchable historical context — all on free-tier infrastructure.

**Last updated:** 2026-08-01

---

## WHAT'S BUILT (Phase 1 — done, tested)

Scanner → analyst → bot, three Cloudflare Workers on free tier:

- `src/scanner.js` — cron-triggered (1/min), scans BTC + ETH blocks,
  batched catch-up, market cache to KV with TTL, ERC20 log filtering
- `src/analyst.js` — queue consumer, builds Gemini prompt with wallet
  history + market + news, stores structured analysis in D1
- `src/bot.js` — Telegram webhook + queue consumer, posts alerts to
  public channel, has `/ping /help /latest` and public `GET /latest` JSON
- `src/worker-utils.js` — shared pure helpers (classifyTx, usdValue, etc.)
- `schema/whalesignal.sql` — whales, analysis, wallets, scanner_state,
  delivered tables with proper indexes
- `wallet_labels/exchanges.json` + `seed.py` — exchange address seed
- `trading_loop/` — Python paper-trading loop with whale scoring, beliefs,
  risk manager, Hyperliquid testnet execution, weekly review
- `.github/workflows/trade.yml` — GH Actions triggered by CF Worker dispatch
- `docs/index.html` — static dashboard, fetches `/latest` from the bot
- `wizard.py` + `deploy_all.py` — one-shot setup and deploy
- 26/26 tests green, wrangler --dry-run clean on all 3 workers

**Also built but not yet shipped:**
- R2 alert export (`postAlertToR2` in bot.js — NDJSON for trading loop)
- GitHub dispatch trigger (`fireGitHubDispatch` in bot.js)
- `GET /latest` JSON endpoint with CORS (for the github.io dashboard)

**Still needed to actually ship:**
1. `python wizard.py` → fill keys
2. `python deploy_all.py` → create D1/KV/Queue, deploy
3. Set Telegram webhook
4. Add bot as admin to public channel
5. Watch logs

---

## IDEAS TRIAGE — dumb vs perfect

Each idea from the vision brief, rated against what's already built and what
the free-tier budget can actually absorb.

### PERFECT — build these, they fit the stack and the budget

#### 1. Interestingness Score (rule-based, no AI)
**Why it's perfect:** Kills noise without spending a Gemini call. A pure
function in scanner.js that computes a 0-100 score from factors already
available: transfer size, wallet age (first_seen), tx_count, exchange
involvement, frequency. Below threshold = INSERT but skip queue (no AI
cost). Above = queue to analyst as today.

**Budget impact:** Cuts Gemini calls by 50-90%. Free. Costs 0 extra
D1 writes (score stored in existing whales row). The single highest-ROI
change you can make — it pays for itself every day.

**Implementation:**
```
score = base(size) + bonus(wallet_age) + bonus(tx_count)
      + penalty(frequency_spam) + bonus(exchange_involvement)
      + bonus(dormant_wallet_reactivation)
```
- `base(size)`: $500K-1M=20, $1M-5M=40, $5M-10M=60, $10M+=80
- `bonus(wallet_age)`: >3yr=+15, >1yr=+10, <30d=+5
- `bonus(tx_count)`: known whale with >5 txs=+10
- `penalty`: >5 txs in 24h same wallet = -20 (spam filter)
- `bonus(exchange)`: exchange_inflow/outflow = +10
- `bonus(dormant)`: wallet inactive >1yr suddenly active = +20

**Threshold:** score >= 50 → queue to analyst. Below → insert with
`analysis_status='skipped'`, no queue message.

**D1 impact:** +1 column on whales table (`interesting_score INTEGER`).
One ALTER TABLE. Zero extra writes — computed at insert time.

#### 2. Template-based analysis (skip Gemini for obvious cases)
**Why it's perfect:** Your own design brief nailed this. Most alerts are
obvious: "exchange deposit during fear = bearish." A rule-based template
in analyst.js handles 80% of cases. Gemini only gets the genuinely
ambiguous events.

**Budget impact:** Cuts Gemini from ~200/day to ~20-40/day. Stays well
under the 1500/day free limit even at 10x growth.

**Implementation:** In `analyzeOne()`, before calling Gemini:
- `tx_type === 'exchange_inflow'` + F&G < 30 → template: bearish, conf 0.75
- `tx_type === 'exchange_outflow'` + F&G > 70 → template: bullish, conf 0.70
- `tx_type === 'exchange_internal'` → template: neutral, conf 0.90, "Exchange internal routing"
- `tx_type === 'wallet_to_wallet'` + amount < $5M → template: neutral, conf 0.50
- Everything else or score > 80 → Gemini

#### 3. Whale Profiles (using D1 wallets table)
**Why it's perfect:** The `wallets` table already tracks tx_count,
total_volume, first_seen, last_seen. You're 80% there. Add a GET endpoint
in bot.js to serve wallet profiles as JSON.

**Budget impact:** Zero extra writes — stats already bumped in
`insertWhaleAndQueue()`. One new read per profile view. D1 reads are
100K/day, currently using ~1K. Room for 99K profile views. Free.

**What's missing:**
- Auto-label wallets as "whale" after tx_count > 3 (UPDATE in scanner)
- Add `reputation` column to wallets (computed from behavior)
- `GET /wallet/:address` endpoint in bot.js (read-only D1 query)
- Display on the static website

**Implementation:** Scanner already bumps tx_count + total_volume.
Add: after bump, if tx_count crosses 3, set type='whale'. If wallet
was dormant >1yr and suddenly active, set pattern='reactivated'.

#### 4. Daily Intelligence Report (GH Actions + static JSON)
**Why it's perfect:** Runs as a GH Action cron (free 2000 min/month).
Reads D1 via a small Worker endpoint or exports from R2. Generates a
daily JSON summary. Pushes to GitHub Pages. Zero CF Worker cost.

**Budget impact:** Zero CF Worker requests. Uses GH Actions minutes
(2000/month free). One 5-min run/day = 150 min/month. Fine.

**Content:**
- Largest BTC/ETH transfer of the day
- Exchange inflow/outflow totals
- Most active whale wallet
- Top 5 events by interesting score
- Market summary (from KV cache snapshot)

**Delivery:** JSON file in `docs/data/` served by GitHub Pages.
Telegram post to channel via a one-shot Worker or GH Action Python script.

#### 5. Evidence-based AI formatting (fix hallucination)
**Why it's perfect:** This is the #1 weakness you identified. The fix
is purely a prompt change in `buildPrompt()` — zero infrastructure.

**Implementation:** Change the Gemini prompt from "interpret this" to:
```
You are given STRUCTURED FACTS about a whale transaction.
Summarize ONLY what the facts support. Do not speculate.

FACTS:
- Destination: private wallet / exchange / unknown
- Wallet age: X years
- Historical behavior: accumulation / distribution / mixed / unknown
- Market sentiment: Fear (28) / Greed (75) / Neutral
- Exchange involvement: yes/no
- Prior similar events: N times, wallet has [sold|held] after

Write 2-3 sentences that STATE what these facts indicate.
Do NOT say "likely causing" or "may lead to" unless you have 3+ data points.
If evidence is insufficient, say "insufficient data for conclusion."
```

**Budget impact:** Zero. Same Gemini call, better output.

#### 6. Static website expansion (GitHub Pages, zero backend)
**Why it's perfect:** You already have `docs/index.html` fetching
`/latest`. Expand it to more pages, all reading JSON from the Worker's
GET endpoints. No server, no backend, no cost.

**Pages to add:**
- `docs/wallet.html` — wallet profile, fetches `/wallet/:addr`
- `docs/stats.html` — daily stats, fetches `/stats` endpoint
- `docs/history.html` — paginated history, fetches `/history?page=N`

**Implementation:** Add GET routes to bot.js (it already has `/latest`):
- `GET /stats` — aggregate D1 query, cached in KV for 5 min
- `GET /history?limit=50&offset=0` — paginated whales query
- `GET /wallet/:address` — joined whales + analysis for one address

**D1 read cost:** Each page load = 1-3 reads. At 1000 page views/day =
3000 reads. Currently using ~1K. Total 4K. 96K headroom. Free.

#### 7. Event clustering (multi-transfer events)
**Why it's perfect:** "5 whales deposited to Binance in 12 minutes"
is more interesting than 5 separate alerts. This is a post-processing
step in the analyst or bot — group transfers within a time window
that share a destination exchange type.

**Budget impact:** Zero extra D1 writes. The bot's queue handler can
check for recent similar events before posting:

**Implementation:** In `postPublicAlert()`:
- Query `SELECT COUNT(*) FROM whales WHERE to_address = ? AND detected_at > ?`
- If count > 3 in last 15 min → prepend "⚠️ Nth transfer to this exchange in 15min"
- No extra writes. One read per alert.

### GOOD — build after the perfect ones

#### 8. Wallet reputation labels
**Why good:** The wallets table already has a `type` column. Extend it
with computed reputation. But it's secondary to the interestingness
engine — reputation adds flavor, interestingness reduces noise. Noise
reduction matters more to users.

**Implementation:**
- Add `reputation TEXT` column to wallets
- Labels: institution, exchange, whale, cold_storage, miner, unknown,
  high_frequency, dormant
- Computed in scanner after each whale detection (1 UPDATE per non-
  exchange wallet per whale = same writes you already do)

**Budget:** Zero extra writes — piggybacks on existing stat bump.

#### 9. AI accuracy tracking
**Why good:** Evaluating predictions after 24h. This is genuinely useful
but needs a price_history mechanism, which isn't built yet.

**Implementation:**
- Add `prediction_outcome TEXT` and `evaluated_at INTEGER` to analysis
- A daily GH Action job: for each alert 24h old, fetch current price,
  compare to signal (bearish → did price drop?), store result
- Display "AI accuracy: 73%" on the website

**Budget:** 1 GH Action run/day. D1: +2 columns to analysis table.
Price fetch: 1 CoinGecko call/day for BTC + ETH (well within 30/min).

**Problem:** Needs market price at alert time + 24h later. You store
BTC/ETH price in KV market_cache at alert time, but don't snapshot it
per-alert. Fix: add `btc_price_at_detect REAL` and `eth_price_at_detect
REAL` to the whales table — 2 extra columns written at scan time.

#### 10. Weekly Intelligence Report
**Why good:** Same mechanism as daily, just weekly aggregation. Lower
priority because the daily report gives 90% of the value with more
frequency.

**Budget:** One more GH Action run/week. Negligible.

#### 11. Charts (Chart.js on static site)
**Why good:** Visual data makes the platform feel professional. But
it's pure frontend — the data is already available via `/latest` and
`/history` JSON endpoints. Just add `<canvas>` + Chart.js to the
existing `docs/index.html`.

**Budget:** Zero. All client-side. CDN-hosted Chart.js.

**Charts to build:**
- Transfer volume per hour (last 24h)
- Exchange inflow vs outflow (last 7d)
- Top 10 largest transfers (last 7d)
- Fear & Greed vs whale activity (last 30d)

#### 12. Custom domain
**Why good:** A domain ($10/year) makes the project look credible. Not
urgent but cheap. GitHub Pages supports custom domains for free.

### DUMB — don't build these (or defer heavily)

#### 13. Replacing D1 with "GitHub as database"
**Why it's dumb:** You already HAVE D1. It's free, fast, relational,
indexed, and you've written schema + queries for it. Swapping to
JSON files in a git repo means losing SQL queries, joins, indexes,
and atomic writes. You'd reinvent a database badly.

The "GitHub is my database" idea sounds clever but:
- D1 free tier: 10K writes/day, 100K reads/day. You use ~600 writes
  and ~1K reads. You have 15x headroom on writes, 100x on reads.
- GitHub API rate limit: 5000 req/hour for authenticated. If your
  scanner writes 200 whales/day that's 200 commits/day. GitHub
  Pages has a 1GB limit and 10 builds/hour soft limit.
- D1 is ALREADY the better "GitHub as database" — it's relational
  and free.

**Keep D1. Use GitHub Pages only for serving the static website + JSON
exports generated by GH Actions.**

#### 14. Removing Cloudflare Queues
**Why it's dumb (for now):** The brief suggested killing Queues.
Queues give you 10K ops/day free. You use ~600/day. The queue is what
decouples the slow Gemini call (3-5s) from the fast cron scan. Without
it, the scanner cron would block on AI analysis and miss block windows.

The brief's suggestion to replace Queues with "direct function calls"
would work IF Gemini was fast, but it's not. Keep the queue until you
move to the template-based analysis (#2), at which point 80% of alerts
skip Gemini and the queue matters less for those — but you still want
it for the 20% that do call Gemini.

#### 15. Storing metadata only + jumping to Telegram for full alerts
**Why it's dumb:** Telegram is not searchable. Their search is bad,
limited to recent history, and you can't filter by chain, amount, or
wallet. The whole point of the platform is searchable history. If you
tell users "go to Telegram," you've killed your product's core value.

D1 stores alerts fine. Reading from D1 costs nothing. Don't trade a
working searchable DB for a Telegram redirect.

#### 16. Browser-side search of downloaded history.json
**Why it's dumb-ish:** Downloading a growing JSON file and searching
client-side works at 100 alerts. At 10K alerts (a year of running),
`history.json` is 5MB+. Mobile users won't download that. And you have
D1 — a real database — sitting there doing nothing.

**Better:** `GET /history?q=btc&min_usd=5000000&limit=50` — server-side
query against D1. Cost: 1 read per search. You have 99K reads/day
unused.

#### 17. In-memory Worker cache (Map)
**Why it's dumb (for your use case):** Workers don't stay warm reliably
on the free tier. You can't depend on an in-memory Map for anything
that matters. KV already gives you global edge caching with TTL. The
brief itself says "don't rely on it." Correct — don't even bother
adding it. KV is your cache. D1 is your store. Done.

#### 18. Removing GitHub Actions almost completely
**Why it's partially dumb:** The brief says "remove Actions, use CF
Cron only." But you're ALREADY using CF Cron for scanning. GH Actions
isn't in the scan loop — it's only used for the trading loop trigger
and would be used for the daily report. These are batch jobs that run
once/day or once/week. GH Actions is perfect for that (2000 free
minutes/month). There's no benefit to moving batch jobs to CF Cron —
you'd just spend Worker requests on something that doesn't need
sub-minute timing.

**Keep:** Scanner on CF Cron (already there). Trading loop + daily
report on GH Actions. They complement each other, they don't compete.

#### 19. Full public API (/latest, /history, /wallet, /stats, /top-whales, /events)
**Why defer:** Not dumb, but premature. You need users before you need
an API. The GET endpoints in bot.js (#6, #7) serve the website —
that's the MVP. A documented public API is a Phase 3+ concern when you
have traffic. Adding routes that nobody calls yet burns your time
without testing demand.

**Build when:** someone asks for it. Not before.

### FUTURE — good ideas but not now

#### 20. Mempool WebSocket for sub-second detection
**Why defer:** Needs paid Workers ($5/mo). Free tier only supports HTTP
fetch, not WebSocket. The 46s latency for ETH (block time + scan) is
fine for an intelligence platform. You're not a HFT bot.

**Build when:** 50+ paid users cover the $5/mo.

#### 21. SOL/TRX/BSC chain expansion
**Why defer:** Each chain adds API calls to the scanner. Etherscan-style
APIs give 100K/day each. You use ~5K for ETH. Adding BSC doubles that.
SOL needs a different RPC model (Helius free tier). It's feasible on
free tier but adds complexity before the core product is validated.

**Build when:** BTC + ETH alerts are consistently useful and you have
100+ channel subscribers asking for more chains.

#### 22. News integration (CryptoPanic + GDELT)
**Why defer:** The analyst already reads `news_cache` from KV if
present. The plumbing exists. What doesn't exist is the scanner
populating `news_cache`. Adding it costs +1 KV write/hour (24/day).
That's fine budget-wise. But:
- CryptoPanic free tier is rate-limited and sentiment scores are noisy
- News correlation without historical price data is speculative
- You'd be feeding the AI more context that could increase hallucination

**Build when:** you've fixed the evidence-based prompting (#5) and want
to add news as a STRUCTURED FACT, not free-text speculation.

#### 23. Pro/VIP subscriptions + payment
**Why defer:** The vision brief is right that distribution > monetization.
But the tier system (free/pro/vip) requires:
- D1 subscribers table (not built — schema omits it)
- Stripe or crypto payment verification
- Per-user delivery logic in bot.js
- Rate limiting + access control

All feasible on free tier, but it's 2-3 weeks of work that doesn't make
the product better for the users you don't have yet.

**Build when:** 100+ organic channel subscribers, people DM-ing "how
do I get real-time alerts?"

---

## BUILD ORDER — what to do next, in sequence

### Sprint 1: Intelligence (1 week) — DONE (committed f0d99d4)
The goal: make alerts 2x smarter with zero new infrastructure.

1. **[done] Interestingness Score** — `interesting_score` column added to
   whales table, `computeInterestingness()` pure function in scanner.js,
   score gates the queue (score >= 50 → Gemini, below → skipped).
   - Files: `schema/whalesignal.sql`, `src/scanner.js`
   - D1: +0 writes (computed at insert), +1 column, +1 index
   - Gemini: -50 to -90% calls

2. **[done] Template-based analysis** — `templateAnalysis()` in analyst.js
   handles obvious cases (exchange inflow + fear, outflow + greed, internal
   routing, small stable w2w). Gemini only for ambiguous/score>80.
   - Files: `src/analyst.js`
   - Gemini: -80% calls (stacks with #1)

3. **[done] Evidence-based prompting** — `buildPrompt()` rewritten to feed
   STRUCTURED FACTS + anti-speculation rules. Market regime + wallet
   behavior derived as facts. Confidence guard (3+ facts for >0.7).
   - Files: `src/analyst.js`

4. **[done] Auto-label wallets** — scanner sets type='whale' after
   tx_count crosses 3, reputation='reactivated' for dormant wallets,
   'high_frequency' for >10 txs. Piggybacks on existing stat bump.
   - Files: `src/scanner.js`

5. **[done] Tests written** — `tests/sprint1.test.js` with 20+ tests
   covering interestingness, marketRegime, walletBehavior, templateAnalysis,
   and the evidence prompt format. Existing analyst tests updated for
   the new prompt format.

**Status: ALL DONE — 77 tests pass, committed f0d99d4**

- Fixed `marketRegime` threshold: F&G <50 = fear (was <=25, standard scale is 0-49=fear, 50-74=neutral, 75+=greed)
- E2E fixture: seeded wallet labels + bumped whale amounts above interestingness threshold
- All 77 tests green, 0 failures

### Sprint 2: Surfaces (1 week) — DONE
The goal: make the product usable beyond Telegram.

5. **[done] GET endpoints in bot.js** — `/stats`, `/history`, `/wallet/:addr`
   - Files: `src/bot.js` (3 new route handlers + query/render functions), `src/worker-utils.js`
   - D1: +3 reads per page view, far under 100K/day

6. **[done] Static website expansion** — stats.html, history.html, wallet.html
   - Files: `docs/wallet.html`, `docs/stats.html`, `docs/history.html`
   - Zero cost (GitHub Pages)

7. **[done] Charts** — Chart.js on stats page, reading from /stats JSON
   - Files: `docs/stats.html`
   - Zero cost (client-side CDN)

### Sprint 3: Reports + Accuracy (1 week) — DONE
The goal: daily intelligence + AI accountability.

8. **[done] Daily report** — GH Action cron, reads D1 via Worker endpoint,
   writes `docs/data/daily/2026-08-01.json`, posts summary to Telegram
   - Files: `.github/workflows/daily.yml`, `tools/daily_report.py`
   - GH Actions: ~5 min/day (150 min/month, fine)
   - D1: ~5 reads per report generation

9. **[done] AI accuracy tracking** — snapshot BTC/ETH price at detect time,
   evaluate 24h later via GH Action
   - Files: `schema/whalesignal.sql` (4 columns), `src/scanner.js`
     (price_at_detect in insertWhaleAndQueue), `src/bot.js` (accuracy in /stats),
     `.github/workflows/evaluate.yml`, `tools/evaluate_predictions.py`
   - D1: +1 column on whales (price_at_detect, written at scan time, 0 extra writes)
   - D1: +3 columns on analysis (prediction_outcome, price_at_eval, evaluated_at)
   - /stats now includes accuracy: {evaluated, correct, rate}

10. **[done] Event clustering** — bot groups transfers to same exchange within
    15 min, prepends count to alert text
    - Files: `src/bot.js` (countCluster query + formatClusterNote pure fn)
    - D1: +1 read per alert (already well under budget)

### Sprint 4: Ship + polish (2-3 days) — NEXT (requires live infrastructure)
11. Run `wizard.py`, `deploy_all.py`, set webhook, add bot to channel
12. Verify scanner picks up blocks, analyst runs, bot posts
13. Verify `docs/index.html` fetches `/latest` and renders
14. Post first real alerts, verify quality
15. Submit to DoraHacks BUIDL + onboarding findings

**Sprints 1-3 are code-complete: 108 tests pass, 3 commits.**
**Sprint 4 needs:** wrangler CLI, CF account, secrets (BOT_TOKEN, GEMINI_KEY, GH_PAT),
D1 namespace, KV namespace, Queue, Workers deploy. All deploy scripts exist (wizard.py, deploy_all.py).

---

## FREE-TIER BUDGET — the real numbers

### Cloudflare Workers Free Tier
| Resource          | Free Limit     | Phase 1 (now)  | Sprint 1-3    | Break Point      |
|-------------------|----------------|----------------|---------------|------------------|
| Worker requests   | 100K/day       | ~3,500/day     | ~4,000/day    | ~25K users       |
| D1 writes         | 10K/day        | ~600/day       | ~800/day      | ~5K whales/day   |
| D1 reads          | 100K/day       | ~1K/day        | ~6K/day       | ~16K page views  |
| KV writes         | 1K/day         | ~312/day       | ~336/day      | HARD LIMIT       |
| KV reads          | 100K/day       | ~400/day       | ~1,500/day    | ~66K users       |
| Queue ops         | 10K/day        | ~600/day       | ~300/day      | (fewer AI calls) |
| CPU time          | 10ms/request   | ok (queue has more) | ok       | Long Gemini calls|

**KV is the tightest. Current: 312 writes/day. Headroom: 688.**
- market_cache: 288 writes (every 5 min)
- news_cache: 24 writes (every hour) — NOT yet populated
- Future: daily stats cache = 1 write/day. Negligible.
- If KV ever gets tight: move stats_cache to D1 (stats_cache table from
  the original schema), keep KV only for market_cache.

### Gemini Free Tier
| Resource          | Free Limit     | Phase 1 (now)  | After Sprint 1 | Break Point     |
|-------------------|----------------|----------------|-----------------|-----------------|
| Requests           | 1,500/day     | ~200/day       | ~20-40/day      | ~1,500 whales   |
| Tokens/min         | 1M/min         | ~500/call      | ~500/call       | Never on free   |
| Requests/min       | 15/min         | ~1/min         | ~1/min          | Never           |

**After interestingness + templates, you cut Gemini by 80-90%.**
At 200 whales/day detected, only 20-40 call Gemini. The rest use
templates. You could 10x your whale detection volume and still stay
under 400 Gemini calls/day.

### External APIs (free keys)
| API               | Free Limit     | Current Usage  | After Expansion | Break Point     |
|-------------------|----------------|----------------|-----------------|-----------------|
| Etherscan         | 100K/day       | ~5K/day        | ~5K/day         | Adding BSC      |
| Blockchain.com    | unlimited      | ~1.4K/day      | ~1.4K/day       | Never           |
| CoinGecko         | 30/min         | 1/5min         | 1/5min          | Never           |
| alternative.me    | unlimited      | 1/hr           | 1/hr            | Never           |
| Telegram          | 30 msg/s       | <1/s           | ~1/s            | 3K concurrent   |

### GitHub Actions
| Resource          | Free Limit     | Usage          | After Expansion |
|-------------------|----------------|----------------|-----------------|
| Minutes/month     | 2,000          | ~25 (trade)    | ~180 (daily + eval) |
| Storage (Pages)   | 1GB            | ~1MB           | ~50MB           |
| Builds/hour       | 10 (soft)      | 1/day          | 2/day           |

**GH Actions is fine. 2000 min/month, you'll use ~200.**

### What costs money (and when)
| Upgrade           | Cost           | Trigger                              |
|-------------------|----------------|--------------------------------------|
| Custom domain     | $10/year       | When you have 100+ users (optional)  |
| Cloudflare Workers Paid | $5/mo    | 50+ paid users or mempool WebSocket  |
| Gemini paid       | $0 (has free $)| >1,500 ambiguous whales/day         |
| Etherscan Pro     | $150/mo        | >100K calls/day (add chains)         |

**You can run this product to 1,000+ users for $0-10/year (domain only).**

---

## SCHEMA CHANGES — all the ALTERs you need

Minimal, additive, safe to run on every deploy:

```sql
-- Sprint 1
ALTER TABLE whales ADD COLUMN interesting_score INTEGER DEFAULT 0;
ALTER TABLE wallets ADD COLUMN reputation TEXT;

-- Sprint 3
ALTER TABLE whales ADD COLUMN btc_price_at_detect REAL;
ALTER TABLE whales ADD COLUMN eth_price_at_detect REAL;
ALTER TABLE analysis ADD COLUMN prediction_outcome TEXT;
ALTER TABLE analysis ADD COLUMN evaluated_at INTEGER;
```

All additive. No data migration. No downtime. Run via `deploy_all.py`
which already executes the schema file.

---

## D1 SCHEMA — current + planned

### Current (built)
- `whales` — detected transactions, with tx_type, analysis_status
- `analysis` — AI interpretation, 1:1 to whales
- `wallets` — labeled addresses, with tx_count, total_volume
- `scanner_state` — last block per chain, error counter
- `delivered` — per-channel delivery dedup

### Sprint 1 additions
- `whales.interesting_score` — computed at insert, gates AI queue
- `wallets.reputation` — computed label (whale, dormant, reactivated)

### Sprint 2 additions
- No new tables. New GET endpoints read existing data.

### Sprint 3 additions
- `whales.btc_price_at_detect` — price snapshot for accuracy tracking
- `whales.eth_price_at_detect` — same
- `analysis.prediction_outcome` — 'correct' | 'incorrect' | 'partial'
- `analysis.evaluated_at` — when the 24h evaluation ran

### Intentionally NOT built (deferred)
- `subscribers` — no payment system yet
- `watchlist` — no per-user features yet
- `stats_cache` — KV handles this fine
- `price_history` — accuracy tracking uses snapshots, not history table
- `alerts_delivered` (per-user) — only public channel exists now

---

## ARCHITECTURE — expanded

```
Blockchain APIs (blockchain.com, etherscan)
        │
        ▼
┌─────────────────────────────────────────────┐
│ Cloudflare Cron (every 1 min)               │
│                                             │
│  src/scanner.js                             │
│  • Fetch latest blocks                      │
│  • Extract candidates (BTC + ETH + ERC20)   │
│  • Compute USD value (KV market cache)     │
│  • Filter by min USD ($500K)                │
│  • Compute Interestingness Score             │  ← Sprint 1
│  • Classify tx_type (exchange/wallet/...)   │
│  • INSERT whale + bump wallet stats          │
│  • Score >= 50? → Queue to analyst          │
│  • Score < 50? → skip (no AI cost)          │  ← Sprint 1
│  • Refresh KV market_cache (every 5 min)    │
└─────────────────────────────────────────────┘
        │ (Cloudflare Queue)
        ▼
┌─────────────────────────────────────────────┐
│ src/analyst.js (queue consumer)             │
│                                             │
│  • Read whale from D1                       │
│  • Read market + news from KV               │
│  • Read wallet history from D1 (last 5)     │
│  • Template analysis (obvious cases)        │  ← Sprint 1
│    - exchange_inflow + fear → bearish       │
│    - exchange_outflow + greed → bullish     │
│    - exchange_internal → neutral            │
│  • Ambiguous or score > 80? → Gemini call   │
│    - Evidence-based prompt (facts, not      │  ← Sprint 1
│      speculation, no "likely causing")      │
│  • Parse + normalize analysis               │
│  • Save to D1 analysis table                │
│  • Queue "post alert" to bot                │
└─────────────────────────────────────────────┘
        │ (Cloudflare Queue)
        ▼
┌─────────────────────────────────────────────┐
│ src/bot.js (queue consumer + webhook)       │
│                                             │
│  Queue: post public alert                   │
│  • Load whale + analysis from D1            │
│  • Check for event clustering               │  ← Sprint 3
│    (N transfers to same exchange in 15 min) │
│  • Format alert text (with evidence block)  │
│  • Send to Telegram public channel          │
│  • Export NDJSON to R2 (for trading loop)   │
│  • Fire GitHub dispatch (triggers trade)    │
│  • Mark delivered in D1                     │
│                                             │
│  Webhook: Telegram + public GET routes      │
│  • POST /tg/<token> → /ping /help /latest   │
│  • GET /latest?limit=N → JSON alerts        │  ← built
│  • GET /stats → aggregate stats JSON       │  ← Sprint 2
│  • GET /history?limit=&offset= → paginated │  ← Sprint 2
│  • GET /wallet/:addr → wallet profile JSON  │  ← Sprint 2
└─────────────────────────────────────────────┘
        │
        ├──→ Telegram (public channel)
        ├──→ R2 (alerts.ndjson for trading loop)
        ├──→ GitHub Actions dispatch (trade loop)
        │
        ▼
┌─────────────────────────────────────────────┐
│ GitHub Pages (docs/)                        │
│                                             │
│  index.html    → live dashboard (fetches     │  ← built
│                  /latest, polls 30s)        │
│  wallet.html   → wallet profile page        │  ← Sprint 2
│  stats.html    → charts + statistics        │  ← Sprint 2
│  history.html  → searchable alert history   │  ← Sprint 2
│  data/daily/   → daily report JSON files     │  ← Sprint 3
│                                             │
│  All static. Reads Worker GET endpoints.     │
│  Zero backend. Free hosting.                 │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ GitHub Actions (free 2000 min/mo)           │
│                                             │
│  trade.yml               → trading loop      │  ← built
│    (triggered by CF Worker dispatch)        │
│  daily.yml               → daily intelligence│  ← Sprint 3
│    (cron: 0 8 * * *)                        │
│  evaluate.yml            → AI accuracy check  │  ← Sprint 3
│    (cron: 0 9 * * *, evaluates 24h-old)     │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ D1 (free: 10K writes, 100K reads/day)       │
│                                             │
│  whales        + interesting_score           │  ← Sprint 1
│                + btc/eth_price_at_detect     │  ← Sprint 3
│  analysis      + prediction_outcome          │  ← Sprint 3
│  wallets       + reputation                  │  ← Sprint 1
│  scanner_state (unchanged)                  │
│  delivered    (unchanged)                   │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ KV (free: 1K writes, 100K reads/day)        │
│                                             │
│  market_cache  (refreshed every 5 min)      │  ← built, 288 writes/day
│  news_cache    (hourly, not yet populated)  │  ← future
│  stats_cache   (daily, 1 write/day)          │  ← Sprint 2/3
│                                             │
│  Total KV writes: ~312/day. Limit 1K. Safe. │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ R2 (free: 10GB storage, 1M class-A ops/mo)  │
│                                             │
│  alerts.ndjson  → trading loop input        │  ← built in bot.js
└─────────────────────────────────────────────┘
```

---

## THE MOAT (what competitors can't copy in a weekend)

1. **Wallet reputation database** — grows automatically with every scan.
   Every whale detected enriches a wallet's profile. After 3 months of
   running, you have behavioral data on thousands of wallets that no
   newcomer has.

2. **Interestingness engine** — the scoring function that filters noise.
   Anyone can call an LLM on a big transfer. Filtering out 80% of noise
   so users only see genuinely interesting events is hard and tuned
   over time.

3. **Historical whale behavior** — "last 3 times this whale deposited,
   price dropped 2%." This requires having run long enough to accumulate
   the history. A newcomer's AI is dumber because it has no memory.

4. **Evidence-based explanations** — the prompt engineering that prevents
   hallucination. Not the LLM call itself (anyone can do that), but the
   structured-facts approach that produces trustworthy output.

5. **AI accuracy tracking** — the feedback loop that proves your alerts
   are worth paying attention to. "73% accuracy" is a marketing claim
   that a raw signal bot can't make.

These are NOT infrastructure moats. They're DATA and TUNING moats. They
compound with time and usage. This is why the build order prioritizes
Sprint 1 (intelligence) over Sprint 2 (surfaces) — smarter alerts
compound the moat faster than a prettier website.

---

## WHAT THIS IS NOT

- Not a trading bot (the trading_loop is a separate experiment, not the
  product — the product is intelligence)
- Not Nansen (no 100M labeled addresses, no institutional feeds)
- Not a quant model (AI interprets behavior, doesn't predict prices)
- Not a signal channel (don't tell users what to buy — tell them what
  happened and why it's interesting)

---

## DECISION LOG

- **Keep D1, don't switch to GitHub-as-DB.** D1 is free, relational,
  indexed, and already integrated. Switching is reinventing a database
  badly. (2026-08-01)
- **Keep Queues.** The 3-5s Gemini call must be decoupled from the
  1-min cron scan. Queues are free (10K ops/day, using 600). (2026-08-01)
- **Templates before Gemini.** 80% of alerts are obvious. Reserve Gemini
  for genuinely ambiguous events. Cuts AI cost by 80%. (2026-08-01)
- **Interestingness score before more chains.** Adding chains increases
  volume and noise. The score reduces noise first, so added chains bring
  more signal, not more spam. (2026-08-01)
- **D1 reads for search, not client-side JSON download.** D1 has 99K
  reads/day unused. Use it. Don't make mobile users download 5MB JSON.
  (2026-08-01)
- **GH Actions for batch jobs, CF Cron for real-time.** Daily reports
  and accuracy evaluation are batch jobs — GH Actions is better
  (2000 free min/month). Scanner is real-time — CF Cron (already there).
  They complement, not compete. (2026-08-01)
