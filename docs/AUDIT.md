# WhaleSignal — Honest Audit: "looks complete" vs "is complete"

The failure mode of fast development is code that *looks* done. This is the
standing inventory of the gap, maintained deliberately. If an item here is
wrong, fix this doc first.

## Found by audit and FIXED

| Item | How it hid | Fixed |
|---|---|---|
| Sink discovery threw `fmtUSD is not defined` **every day**, silently swallowed | Missing import; try/catch in scheduled hid it | ✅ import + failure logging |
| Grading "expired" window never fired (ms × 3.6M units error) | SQL bound an absurd timestamp; no test covered the boundary | ✅ fixed + window test |
| New wallets never became labeled whales (UPDATE on nonexistent rows) | The stats bump was UPDATE-only; first sighting needs an INSERT | ✅ first-sight insert |
| `/latest` + `/history` sorted ~100K rows per dashboard poll (no index) | Worked fine on the empty DB; degraded as data grew | ✅ partial index |
| `loadWalletMap` full-scanned the wallets table **per tick** | Fine at 19 rows; broke as auto-labeling grew it | ✅ labels-only map + per-candidate infos |
| evaluate.yml computed a second, conflicting accuracy number | Two "accuracy" values = zero trustworthy accuracy | ✅ retired; worker grader is the single truth |
| Windows path bug: laptop tools' CLI guards never matched | Worked on POSIX CI, silently no-op'd on Windows | ✅ pathToFileURL |
| **TRADER: HL sizing bug — size_usd passed as coin quantity** (a $10 decision = 10 BTC position) | Hidden because the live loop never ran on testnet | ✅ mid-price conversion + qty recorded |
| **TRADER: FinMem whale scores never written** — read every decision, updated by nothing | The weekly review's UPDATE matched zero rows | ✅ upsert after each close |
| **TRADER: LLM TP/SL silently discarded** — hardcoded 3%/5% at close | Prompt asked for levels the closer ignored | ✅ persisted per trade, used by the closer |
| Python trading-loop tests never ran in CI | test.yml only ran node tests | ✅ pytest job added |
| **Grading metronome — the last 420K-reads/hour burner** (Sep 19) | The 15-min grade tick ran `FROM whales w JOIN analysis a … ORDER BY w.detected_at` and expire-passed via `whale_id IN (SELECT id FROM whales …)`; SQLite drove BOTH from whales in detected_at order = full ~104K-row scan per tick, per minute-level analytics 105K reads every 15 min like clockwork | ✅ both queries analysis-index-first (`idx_analysis_outcome`); whale rows fetched by PK; expire filter on `analysis.created_at`; vol thresholds deferred until pending ≠ 0; neutrals stamped `'no_signal'` at insert (prod backfill: 3,632 rows) so the `IS NULL` range stays empty; EXPLAIN-plan regression test added (`tests/grading.test.js`) |

## THE recurring cap-trip root cause (found by account inventory + measurement)

**Final chain, established with tools/d1_metrics.mjs (GraphQL analytics):**

1. whalesignal-db read **9.9–10M rows/24h** — the cap was OURS. The neighbors
   were innocent (mechanicfriend: 46 reads, ghanonyar: 24K).
2. Query-level attribution (instrumentDB proxy, per-tick rows_read logs):
   `loadLabelMap` full-scanned the wallets table (~7K rows) on every isolate
   creation — the `label IS NOT NULL OR type IN (...)` filter is unindexable,
   and CF recycles isolates aggressively, so it ran near-constantly.
3. **FIXED**: label map lives in KV (hash-guarded writes, free reads) with an
   indexed D1 fallback; `lower(address)` scans made indexable everywhere
   (labelPair, fetchWalletInfos, graph chunks); bare from/to indexes added.
4. Expected steady state: **<500K reads/day** (10% of cap). Verify with
   `node tools/d1_metrics.mjs` after the next UTC reset.
5. Correction logged: the earlier audit dismissed the "another account" idea —
   partially wrong. The account-share mattered, but our own scan was the
   dominant burn. docs/MIGRATION.md remains the isolation option.

**Also found during live debugging:** 9,849 rows in analysis_status='failed'
(pre-key era LLM failures — /api/reanalyze can retry them now); scanner pause
froze whale storage ~14h (auto-resumed); instrumentation (per-tick rows_read)
stays in the code so any future burn names its query in the logs.

## cryptopay (other account project): CRITICAL secret leak

PAY_SECRET_CONST + ADMIN_SECRET_CONST are plaintext literals in the bundle,
used as the FALLBACK auth for /verify /invoice /debit /grant (gem-minting
and spending). The in-source comment claims no secret literals — it lies.
Also timing-unsafe === compare. Fix order (documented in full in
docs/WORKER_CHANGES.md): rotate secrets → update callers → remove const
fallbacks (fail closed) → constant-time compare. Not auto-fixed: needs a
coordinated deploy with the bot; doing it half-way would lock the bot out.

## Admin worker audit (sprint 5i)

Found: the control plane predated five sprints — /api/config only exposed
pause flags while the system grew a dozen knobs (thresholds, channel mode,
fitted weights, vol spikes, LLM chain/models). FIXED: /api/config now
returns the full knob surface + groq key status. /api/reanalyze now passes
chain in the queue message. Still missing from the panel UI: channel-mode
and weight controls (API-only — the panel HTML is cosmetic-grade).
Security: token compare is constant-time-ish, routes sit behind one gate,
no rate limiting on token attempts (acceptable: long random token, own
subdomain). collectCounts still SUM-scans whales per health call — admin-
only, low frequency; should switch to counters like /stats did.

## Still "looks complete" — ranked by danger

1. **The admin worker (`admin.js`, `admin-panel.js`) has never been audited.**
   It claims a reanalysis queue and pause controls. Unverified: the reanalysis
   path may be broken by every schema/flow change since Sprint 3. *Next: a
   dedicated audit pass.*
2. **The trading loop's LLM config points at `localhost:20128`** — a dev
   proxy. On GitHub Actions it only works via `--gemini-key`. Half the
   "trader" story depends on config the repo doesn't document.
3. **Channel flooding risk remains**: ~165 alerts/day post to the channel.
   `config:channel_mode` exists (all/directional/high) but nothing sets it.
   Suggest: set `directional` once the ledger matures; neutrals stay on the
   dashboard.
4. **`/history` `total` field reports the page size, not the true total** —
   API consumers (trading loop) don't use it, but it's a landmine for the
   public API contract.
5. **Historical rows were re-classified (tx_type) but never re-analyzed.**
   Retro-analysis (tools/laptop/retro.mjs) covers this for *research*, but
   the live dashboard's "signal history" only starts when the model shipped.
   Honest framing, not a bug.
6. **`since_id` on `/alerts/export` bypasses the cache by design** — a scraper
   could vary since_id for cheap-ish unbounded queries. Indexed + LIMIT
   bounds it, but a per-IP rate limit would close it properly.
7. **No alerting on data quality** (vs uptime): the monitor workflow catches
   500s and a stalled scanner; it does NOT catch "signals stopped being
   directional" or "news cache went empty" — both happened historically.
   Next: monitor adds signal-split and news-count checks.

## Verified complete ( audited, not assumed )

- Grading ledger: CAS-guarded, honest windows, expired handling, per-bucket
  counters, per-wallet track records — verified live end-to-end.
- Rollup system: every heavy endpoint reads ≤ a few hundred rows; the D1
  read budget is traffic-sized.
- Multi-source price consensus: 4+ sources with median + 2% agreement,
  provenance exposed in /market and /health.
- First-sighting wallet insert, directional bonus arithmetic, vol-adaptive
  thresholds — all unit-tested with the exact boundary numbers.

## Transparency

The calibration page (docs/research.html) renders the laptop's
feature/retro reports publicly — hit-rates by regime and confidence.
Transparency is the product's answer to the "just looks complete" problem:
the numbers are the numbers.

## The meta-rule

Anything added to this project ships with: a test that would catch it
silently failing, a doc line in the model card or audit, and one production
verification the day it deploys. Everything that "just looks complete" gets
an entry here until it's actually complete.
