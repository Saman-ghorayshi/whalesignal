# Whale Reasoning — Sub-Plan (Phase 3a)

**Parent:** `PLAN.md` Phase 3: Intelligence
**Goal:** Make the analyst's `interpretation` field actually explain *why*
this whale likely moved, not just *that* they did.
**Last updated:** 2026-07-17

---

## ONE-LINE IDEA

Every whale alert already triggers one Gemini call (analyst.js). Right now
that call gets: the tx, market_cache, last 5 transactions of the source
wallet, and "(no recent headlines cached)". We fill in the headline cache
and the wallet-history context with curated, cheap, already-half-built
inputs. No new LLM, no new infra, no new keys. The analyst prompt already
asks for an interpretation — we make the inputs to it non-embarrassing.

> `ponytail:` this is rung-2 of the ladder. The analyst LLM call ALREADY
> exists and ALREADY asks for "why". We are not building a new feature; we
> are feeding real data into an existing prompt slot that currently ships
> "(no recent headlines cached)" as the headline input. The lie is in the
> empty KV, not in missing code.

---

## WHAT EXISTS TODAY (do not rebuild)

| exists | where | status |
|---|---|---|
| analyst prompt with headline + wallet history + news slots | `src/analyst.js:33` buildPrompt | ships empty news |
| wallet history fetch (last 5 tx from source address) | `src/analyst.js` getWalletHistory | works, data is just thin (few whales inserted yet) |
| market_cache (coingecko + alt.me) | `src/scanner.js:318` refreshMarketCache | works live, 5-min TTL |
| KV namespace wired through all 3 workers | wrangler configs + cf-harness | works |
| `news_cache` KV slot already read by analyst | `src/analyst.js:223` `KV.get("news_cache")` | read but never written |
| `wallets` table + `wallet_labels/exchanges.json` | schema + seed | 14 labels seeded, none auto-learned yet |
| analyst LLM constraint: returns `{headline, interpretation, signal, confidence, related_factor}` | `src/analyst.js:67` prompt + `parseAnalysis` | JSON contract is fixed |
| cf-harness simulator with MockFetch | `tools/cf-harness.js` + `tests/e2e.fixture.js` | already stubs Gemini, CryptoPanic-shaped URL, Telegram |

Everything below is *filling those slots with real data*, not building new
ones.

---

## IS THIS A DUMB IDEA? (you asked me to check)

Market scan: every player below either

(a) ships raw alerts but no "why" interpretation (Whale Alert, WhaleStats),
(b) ships "who" via entity labels but no auto-narrative per alert (Nansen, Arkham — $100+/mo), or
(c) ships "why" via manual curation, only for the 5–10 most viral whale
stories per week (Lookonchain Twitter/Telegram).

The free + per-alert + AI-narrated-space is empty. We're not crazy, we're
taking the obvious empty seat that already exists in the product. The
prompt slot literally says `RECENT HEADLINES: - (no recent headlines cached)`.
Plug the hole.

What we are NOT competing with (because ponytail):
- general geopolitical LLM reasoning — wrong horizon (we alert in 12s; geopolitics moves markets in days)
- breaking-news-first bots (Reuters/Whale Alert already do raw news faster than we ever will)
- on-chain forensics (Arkham's whole moat — we don't deanonymize, we just label what already moves)
- price prediction (we interpret one tx, we don't predict where BTC closes)

---

## THE LADDER RUNG WE STOP AT

Rung 1 (does this need to exist)? Yes — analyst already runs, just
answers with empty context.
Rung 2 (already in this codebase)? Yes — `news_cache` slot, `wallets`
label set, `walletLabels` fetch already exist.
**Stop here.** Don't add a third source, don't add a new LLM call,
don't add a new table. Use what's there.

---

## SCOPE — three ladders, shipped one at a time

### Ladder A: fill `news_cache` with one feed, keyword-filtered

**What:** add a `refreshNewsCache` function in `scanner.js` analogous to
`refreshMarketCache`. Same cadence (5-min TTL), same pattern (one fetch,
parse, store in KV). The analyst already reads it.

**Feed:** CryptoPanic. Free tier, no key required for the public
`posts/?auth_token=...&kind=news&filter=hot` reader endpoint if we use the
anonymous `public` API path; OR get a free key in 30 seconds
(cryptopanic.com/developers/api). Pick the free key path — slightly
higher rate limit (50/hour), and gets us real headlines, not the demo feed.

> `ponytail:` one RSS/JSON feed, one keyword filter, one KV write every 5
> minutes. ~50 lines. Do NOT add GDELT, do NOT add Twitter, do NOT add
> Reddit. They are Phase 4+ because the analyst LLM gets diminishing
> returns past 5 headlines in the prompt anyway (token budget + signal
> dilution). One good source beats five shallow ones.

**Keyword filter:** match headlines against a word list relevant to the
asset classes we alert on:

```
exchanges:    Binance, Coinbase, Kraken, Bybit, OKX, Bitfinex, FTX (still appears), Upbit
hack/loss:    hack, exploit, drain, stolen, breach, vulnerability, exit scam
regulatory:   SEC, lawsuit, sued, ban, sanctioned, settlement, charging
macro/risk:   depeg, stablecoin, USDT, USDC, insurance, run, halt, withdrawal
context:      ETF, futures, expiry, options, listing, delisting, upgrade, fork, halving
```

Cache last 5 matching headlines in KV. ~50 tokens into the analyst prompt.

**Saturation rule:** if `news_cache` is older than 30 minutes (don't fail
the scan if CryptoPanic is down), keep last good in KV. Mirror exactly what
`refreshMarketCache` does (catch + warn + continue with stale-or-null).

**Failure mode:** CryptoPanic goes down or rate-limits → write empty
`{headlines: [], updated_at}` to KV. Analyst prompt prints "(no recent
headlines cached)" the same way it already does. No special-case code path.

**Cost:** 1 fetch every 5 minutes = 288/day. Free tier is 50/hour = 1200/day.
Saturation ceiling: 24% of free quota. Comfortable.

**Test:** the existing `tests/e2e.fixture.js` MockFetch already stubs by
URL prefix. Add one entry for `https://cryptopanic.com/api/v1/posts/`
returning a canned `{ results: [{title: "Binance..."}] }`. Existing
`scanner.test.js` already exercises `refreshMarketCache`; the new function
is the same shape. One new test file is overkill — extend `scanner.test.js`.

---

### Ladder B: enrich the wallet-history context the analyst already gets

**What:** the analyst already does `getWalletHistory(env, whale.from_address,
whale.chain, whale.id)` and gets the last 5 entries from the `whales` table.
The data is just thin: we've only seen ~14 seeded exchanges; nothing else
is labeled.

Three things to make wallet history actually informative:

1. **Auto-learn labels.** When the analyst writes back to the DB, it should
   upsert the source/dest wallets if they're unknown. Pattern: "we've now
   seen this address 3 times, all outflows to Binance → label it
   `frequent_depositor_N`, type `unknown` (not `exchange`)." Don't claim to
   know who they are — just count. The next time this wallet moves, history
   is no longer "(no prior history — first sighting)".

   > `ponytail:` one INSERT OR IGNORE in `analyst.js`. No new table. No graph
   > database. Wallets table already exists with `tx_count` and
   > `total_volume` columns that are currently zero everywhere except
   > seeded entities. Use them.

2. **Simple pattern tags, computed when inserting.** Same place we
   upsert the wallet, run a pure function `patternFor(history, currentTx)`
   that returns one of `{accumulator, dumper, frequent_depositor,
   fresh_stealth, unknown}`. Pure function, easy to test. Stored in
   `wallets.pattern` (column already exists, schema line 388 of PLAN.md).

   Rules (the dumb rules engine already drafted in PLAN.md lines 397–409,
   recently re-read — look before you write, that's rung-2):
   - 3+ exchange outflows in last 30d + current tx to exchange →
     `frequent_depositor`
   - 3+ exchange inflows in last 30d → `accumulator`
   - current tx to exchange + wallet first seen <24h ago → `fresh_stealth`
   - current tx to exchange, history has 3+ to-exchange → `dumper`
   - else `unknown`

3. **Inject the pattern into the prompt.** `buildPrompt` already takes
   `history`; just pass the new pattern field too and add one line to the
   prompt:

   ```
   WALLET BEHAVIORAL TAG: ${pattern || "unknown"}
   ```

   The analyst LLM is smart enough to do the reasoning ("frequent_depositor
   during market fear → likely sell-side liquidity move").

**Cost:** 0 new API calls. Pure D1 reads + 1 D1 upsert per whale
(currently `insertWhaleAndQueue` already writes a whale row; piggyback
the wallet upsert on the same `try` block).

**Test:** `analyst.test.js` already exists. Add 3 cases for `patternFor`
pure function (one per non-trivial branch: accumulator, dumper,
fresh_stealth). Then extend the existing e2e fixture so a 3-tick scan
walks through a wallet becoming a "frequent_depositor" — proves the
upsert + pattern + prompt-injection flow end to end in the simulator.

---

### Ladder C: classify "why" outputs so the bot can filter noise

**What:** the analyst's JSON contract already has `signal`
(bullish/bearish/neutral) and `confidence` (0–1). Add ONE field:
`context_relevance` ∈ `{low, medium, high}` — how context-saturated this
alert is. The analyst LLM fills it. Examples:

- big move + exchange label + 4 fresh matching headlines → `high`
- fresh stealth wallet + no news + no wallet history → `medium`
- routine stablecoin mint from 0x0 with no other signal → `low`

Then bot.js uses it for emoji/priority only (existing channel already
posts everything — no new delivery path):

```
high   → 🐋 + bold signal
medium → 🐋 (current default)
low    → 🐡 + muted
```

> `ponytail:` one new field on the JSON schema, one emoji map in bot.js.
> Don't add a "spam filter" abstraction (if/else filters, confidence
> thresholds, user-configurable rules). The LLM does the reasoning; the
> bot does a 3-line if/else on a single field. Add the user-customizable
> filter only if users actually ask for it after watching the channel for
> a month.

**Cost:** 1 new response field. ~20 extra tokens into the prompt + ~20 out.
Per-whale cost goes from ~400 output tokens to ~420. = +5% on a channel
that's already far under gemini's 1500/day cap.

**Test:** existing `analyst.test.js` parseAnalysis case — extend
`normalizeAnalysis` to accept `context_relevance` (default "medium" for
back-compat with already-written analyses). One assertion in bot.test.js
that `high` → bold and `low` → muted.

---

## ORDER OF OPERATIONS (sequence, not parallel)

```
A (news_cache)         → ship, watch the channel for a few days
                          (analyst now writes real "why" — see what it
                           hallucinates, what gets the relevance right)
↓
B (wallet patterns)   → only after A has been live for a few whales,
                          because B depends on having wallet history to
                          pattern-match. If A hasn't shipped, B has nothing
                          to read.
↓
C (relevance tiering)  → only after B. We can't tier "relevance" until
                          the analyst has both news and history to weight.
```

Each ladder ships alone, tested in the simulator, committed atomically. If
A doesn't move the needle in real alerts after a week, B and C are still
shippable independently — each has positive value on its own. If A fails
(CryptoPanic turns out to be unusably noisy), throw it away; B and C don't
depend on A's existence, only on the KV slot A fills (which can stay empty).

---

## WHAT THIS PLAN IS NOT

- Not building an "agent with memory of world events that predicts crypto"
  — wrong product, wrong horizon, wrong cost. The analyst LLM already does
  per-tx reasoning; we don't need a second LLM doing macro reasoning. We
  feed it curated context, not a feed reader.
- Not adding oil prices / geopolitics / China-Taiwan / Russia-Ukraine inputs.
  Those don't move BTC in the 12s block cadence we alert on. They'd move
  into a "weekly macro brief" cron job — separate product, not WhaleSignal.
- Not building entity resolution (Arkham's moat) or smart-money labeling
  (Nansen's moat, $100+/mo, requires a 5K-wallet curated set that takes
  months of manual work). We label accumulators/dumpers behaviorally from
  *our own data*, not by resolving entities to legal persons.
- Not adding a new LLM call per whale. One call per whale, same as today.
  The marginal cost of A+B+C is ~70 extra prompt tokens per whale,
  i.e. ~$0 extra on gemini free tier.
- Not building a backtest harness for "does the interpretation actually
  predict price?" That's Phase 5+ (a separate project); the "is it useful"
  signal for A is whether channel subscribers read it and stay subscribed.

---

## HONSCOPE COSTEÉ

| item | tokens/day extra on gemini | new fetches/day | new tables | new keys needed |
|---|---|---|---|---|
| Ladder A (news_cache) | 0 (analyst call is unchanged, just better-fed) | +288 (CryptoPanic, free) | 0 | 0 (free key optional, 30 sec to get) |
| Ladder B (wallet patterns) | ~+50/whale (prompt grows by pattern tag + 5 hist rows already there) | +0 | 0 | 0 |
| Ladder C (relevance tier) | ~+20/whale (one field in + one field out) | +0 | 0 | 0 |

Total marginal cost: CryptoPanic is free + reads-per-day fit comfortably
in 24% of the free quota; gemini free tier is 1500/day — we're at ~144
whales/day ceiling before any tier work, and A+B+C don't change that
ceiling meaningfully.

---

## SUCCESS / FAILURE SIGNALS

We ship A and watch the actual Telegram output for a week.
**Success:** at least 3 alerts in the week where the `interpretation`
field mentions a real headline as context (the analyst picked up a
`news_cache` entry), and at least 5 alerts where `related_factor` is
non-generic ("frequent depositor during BTC drawdown" beats "exchange
inflow").

**Failure (A) → roll back A alone:** if 7 consecutive alerts have
`interpretation` referring to events CryptoPanic didn't actually cover
(hallucinated news), empty the `news_cache` slot and treat A as
broken — jump to B and skip A.

**Failure (B) → don't roll back:** if patterns produce ≥80%
`unknown` (i.e., no behavioral tagging firing), it just means we need
the wallets table to age. Don't roll back; ship the column, leave it
empirically underused.

**Failure (C) → roll back C alone:** if `context_relevance=high` lands
on alerts that channel readers visibly ignore (read the public channel,
look at reaction counts), demote `high` to `medium` and stop showing it.

---

## FILES TOUCHED (prediction — not a contract)

```
scanner.js          +refreshNewsCache (~50 lines), called from scheduled()
analyst.js          +patternFor (~30 lines, pure), wallet upsert on insert,
                    +context_relevance field added to the prompt request
                    and to normalizeAnalysis
bot.js              +3-line if/else on context_relevance for emoji
tests/scanner.test.js   +refreshNewsCache tests (mirror existing)
tests/analyst.test.js    +patternFor cases, normalizeAnalysis back-compat
tests/bot.test.js        +emoji tier test
tests/e2e.fixture.js     +CryptoPanic stub in MockFetch
schema/whalesignal.sql    ALREADY has `wallets.pattern` — verify before touching
```

No new files, no new directories. The only schema change is upstream
verification that `pattern` column already exists (per PLAN.md line 388,
it does — no migration).

---

## SHIP-IT CHECKLIST

- [x] Ladder A: refreshNewsCache in scanner.js, 5-min TTL, catch + warn + continue on failure
      — shipped 2dbdc0b (also 66b65f2 for the Phase 3 /latest route shipped same session)
- [x] Ladder A tests: scanner.test.js + e2e.fixture.js CryptoPanic stub — 4 new tests, all green
- [ ] Ladder A live-probe: extend tools/live_scan_*.mjs to print news_cache contents
- [x] Commit A. Watch channel 1 week. (committed; live-probe still pending)
- [ ] Ladder B: patternFor pure function, analyst upsert wallet rows, inject into prompt
- [ ] Ladder B tests: 3 branch cases + e2e multi-tick scenario
- [ ] Commit B. Watch channel 1 week.
- [ ] Ladder C: context_relevance in prompt + parse, bot emoji tiers
- [ ] Ladder C tests: tier emoji in bot.test.js
- [ ] Commit C. Watch channel 1 week.

Each commit is atomic (one ladder). Each ladder is independently revertable.
There is no Ladder D.

---

## WHEN TO STOP EARLY

- If after shipping A the analyst output is already clearly better than
  pre-A, ship B but SKIP C — C is the weakest of the three (tier emojis).
  Ponytail: don't build the third rung if the first two already cover the
  gap that motivated this plan.
- If A fails (hallucination or noisy feed), skip to C and ship a simpler
  version (only `context_relevance`, computed from existing market_cache
  + wallet pattern, no news feed at all). This is the fallback if
  CryptoPanic turns out to be a basket case.
- Don't add a second news source before A lives for two weeks. The signal:
  CryptoPanic misses a real market event and you can see it on the chart
  but it wasn't in `news_cache`. Until you can point at a specific
  incident where CryptoPanic missed, adding a second source is YAGNI.

---

## PONYTAIL TALLY

- New LLM calls: 0 (reuse the one that already runs)
- New DB tables: 0 (pattern column exists)
- New external sources: 1 (CryptoPanic, free tier, 30-second key)
- New code dependencies: 0
- Files deleted: 0
- Files created: 0
- Net new lines (prediction): ~150 across scanner/analyst/bot + ~80 in tests
- Rungs skipped: geopolitical reasoning, oil/macro, entity resolution,
  smart-money labeling, multi-feed news, backtest harness.

**The shortest path to "the analyst tells you why" is: feed the existing
analyst prompt the data it was already asking for.** That's it.
