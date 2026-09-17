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

## The meta-rule

Anything added to this project ships with: a test that would catch it
silently failing, a doc line in the model card or audit, and one production
verification the day it deploys. Everything that "just looks complete" gets
an entry here until it's actually complete.
