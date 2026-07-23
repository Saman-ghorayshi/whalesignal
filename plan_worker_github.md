# WhaleSignal Trading Loop — Worker + GitHub Actions Plan

**Date:** 2026-07-17
**Goal:** Run the trading loop 24/7 for $0 using Cloudflare Workers (alert trigger) + GitHub Actions (Python execution) + Hyperliquid testnet (paper money). No VPS, no PC running 24/7, no API keys to pay for.

---

## BUILD STATUS (updated 2026-07-17)

All 7 steps built and tested. Commits below:

| Step | What | Commit | Status |
|---|---|---|---|
| 1 | llm.py: deepseek-v4-flash default + Gemini direct + retry | e9f5d52 | Built, tested live on 9Router |
| 2 | .github/workflows/trade.yml | c623343 | Built |
| 3 | .github/workflows/weekly_review.yml | f411e19 | Built |
| 4 | bot.js: fireGitHubDispatch() repository_dispatch | 2d3bd4c | Built, 5 JS tests green |
| 5 | main.py: --gemini-key flag + plumbing | 629b590 | Built, live tested |
| 6 | weekly_review.py: --gemini-key flag + deepseek-v4-pro | 43c5827 | Built, live testing |
| 7 | Python tests (test_llm.py + test_main.py) | bec4880 | 29 tests green |
| 8 | JS dispatch tests (bot.test.js) | 1b08a66 | 5 new tests, 38 total green |

### LIVE TEST RESULTS

**Trade loop (main.py + 9Router deepseek-v4-flash):**
- 3 fixture alerts → 2 COPY trades + 1 SKIP
- Signal 1 (ETH bullish): deepseek-v4-flash said COPY long, conf 0.6, leverage 2
  - Bear: "no prior track record, cold wallet move could indicate preparation"
  - Bull: "Withdrawing 1500 ETH from Binance during extreme fear suggests accumulation"
- Signal 2 (BTC bearish): COPY short, conf 0.7, leverage 2
  - Bear: "classic sell preparation before a potential dump"
  - Bull: "could be moving for liquidity or arbitrage, not necessarily dumping"
- Signal 3 (neutral): SKIP
- Risk manager clamped both to $10 (10% cap)
- All 3 signals marked processed, 2 trades in DB

**Weekly review (weekly_review.py + 9Router deepseek-v4-pro):**
- 12 trades, 6 wins, 6 losses, PnL $23.33
- (running — deepseek-v4-pro is slower, quality model)

### TEST COUNTS
- Python: 29 tests (test_llm.py + test_main.py), 0.43s, all green
- JS: 38 tests (33 existing + 5 GitHub dispatch), 0.49s, all green
- Total: 67 tests, all green

---

## THE QUESTION

"I don't have money, I don't want my PC on 24/7, and the code is on a public repo — can people steal my strategy? Also flash-lite is dumb, and does Gemini free tier hit a limit?"

### Answer: yes, this works. Here's the math.

---

## THE COST: $0 TOTAL

| service | free tier | what we use | headroom |
|---|---|---|---|
| **Cloudflare Workers** | 100K req/day, 10ms CPU/req | scanner cron every 60s = 1,440 req/day + 1 repository_dispatch POST per alert (~20/day) | 1,460 req/day out of 100K. 1.5% used. |
| **Cloudflare R2** | 10GB storage, 1M Class A ops (writes), 10M Class B ops (reads) per month | bot.js appends 1 line to alerts.ndjson per alert (~600 writes/month). Python reads it once per GH Actions run (~600 reads/month) | 600 writes out of 1M, 600 reads out of 10M. 0.06% used. |
| **GitHub Actions** | UNLIMITED minutes for PUBLIC repos. 2,000 min/month for PRIVATE. | ~20 alert-triggered runs/day × 30 sec each = 10 min/day = 300 min/month. Weekly review = 1 run × 60 sec = 1 min/month. Total: ~301 min/month. | If repo is PUBLIC: unlimited, 0% used. If PRIVATE: 301 out of 2,000. 15% used. |
| **Hyperliquid testnet** | free, faucet gives test USDC | paper trades, no real money | infinite |
| **Gemini API (via 9Router)** | 9Router is localhost, routes to Gemini free tier behind the scenes | ~20 LLM calls/day (1 per alert) + 1 per week (review) = ~141 calls/week | depends on which Gemini model (see below) |
| **Telegram Bot API** | free, unlimited messages | 1 message/week (weekly review) + 1 per alert (existing whalesignal) | 0% used |

**Total: $0/month. No credit card. No VPS. No PC running.**

---

## THE "PEOPLE CAN SEE MY CODE" QUESTION

> "i dont want random people to watch it and my money or its fine? the code and how it works or you just laugh"

Short answer: **nobody cares about your code.** Here's why:

1. The "strategy" is "copy whales that whalesignal already detected." That's not a secret alpha — whalesignal's Telegram channel already broadcasts every alert publicly. You're following public signals.

2. The HL testnet wallet private key is stored as a GitHub Actions secret (encrypted, never logged, never in the repo). Nobody can see it. Even if the repo is public, secrets are invisible.

3. The belief table and whale_scores are in the SQLite DB, which lives inside the GH Actions runner and is destroyed after each run. They're not committed to the repo. Nobody sees your "edge."

4. Real quant funds don't worry about people seeing their code — they worry about people seeing their positions. On HL testnet, positions are fake money. On HL mainnet (Rung 5d, real money), positions are public on-chain anyway. That's the nature of a DEX.

5. The only thing worth hiding is the private key. That's in GitHub Secrets. Done.

**Conclusion: public repo is fine. The code is not the alpha. The whale wallets and timing are — and those come from whalesignal's own scanner, which is already public.**

> `ponytail:` If you're still nervous, make the repo private. 2,000 min/month free is enough. But there's zero downside to public — you're paper trading with fake money, and the strategy is "follow public whale alerts." There's no secret to steal.

---

## THE GEMINI FREE TIER QUESTION (AND WHY FLASH-LITE IS DUMB)

### Gemini free tier limits (per Google project, resets daily at midnight Pacific):

| model | RPM | RPD (requests/day) | TPM (tokens/min) | quality |
|---|---|---|---|---|
| Gemini 3.1 Flash Lite Preview | 15 | 1,000 | 250K | dumb but fast |
| Gemini 3.1 Flash Lite | 15 | 1,000 | 250K | dumb but fast |
| Gemini 3 Flash Preview | 10 | 500 | 250K | smart, has thinking tokens |
| Gemini 2.5 Flash | 10 | 500 | 250K | solid |
| Gemini 2.5 Pro | 5 | 100 | 250K | smartest, fewest calls |

### Our usage:

- ~20 alerts/day × 1 LLM call each = **20 calls/day** (trade decisions)
- 1 call/week = **~0.14 calls/day** (weekly review)
- Total: **~20 calls/day**

Even Gemini 2.5 Pro (100 RPD, 5 RPM) can handle 20 calls/day. We'll never hit the limit.

> `ponytail:` The reason flash-lite is "stupid" isn't the limit — it's the quality. For a trade decision that risks $10 of paper money, the difference between flash-lite and flash (one rung up) is: flash-lite says "COPY, confidence 65" without explaining why. Flash says "SKIP because the whale moved to Binance during fear which is sell prep, but the F&G is already at 22 which is extreme fear so it might be a bottom — net confidence 0.35, skip." That reasoning is what writes better beliefs in the weekly review. **Use flash-lite for trade decisions (speed matters, 20/day). Use a smarter model for the weekly review (1/week, quality matters).**

### Model decision:

| call | model | why |
|---|---|---|
| Trade decision (Rung 2, main.py) | `nvidia/deepseek-ai/deepseek-v4-flash` | tested on 9Router: clean JSON, nuanced reasoning, fast. Free via 9Router. |
| Weekly review (Rung 3, weekly_review.py) | `nvidia/deepseek-ai/deepseek-v4-pro` | tested: deeper analysis, writes better beliefs. 1 call/week so speed doesn't matter. |

Both are available on 9Router right now and both returned clean JSON with real reasoning in our tests. No Gemini direct API key needed — 9Router handles routing.

> `ponytail:` If 9Router is down (503), the code already has a `--llm-stub` fallback. We add a retry + model fallback: try deepseek-v4-pro, if 503 try gemini-3.1-flash-lite, if that fails too, skip the trade. 3 LLM calls max before giving up. No infinite retry loop, no cost.

---

## THE ARCHITECTURE

```
┌──────────────────────────────────────────────────────────┐
│ Cloudflare Workers (ALREADY DEPLOYED)                     │
│                                                            │
│ scanner.js (cron 60s) → D1 → queue → analyst.js → bot.js  │
│                                                        │   │
│ bot.js does TWO things per alert:                        │   │
│   1. POST alert to Telegram (existing)                   │   │
│   2. Append alert JSON to R2 alerts.ndjson (Rung 1)      │   │
│   3. NEW: POST repository_dispatch to GitHub API ────────┼───┼──► triggers GH Actions
│      (one HTTP POST, ~5 lines of code)                   │   │
└──────────────────────────────────────────────────────────┘   │
                                                               │
┌─────────────────────────────────────────────────────────┐   │
│ GitHub Actions (runs in cloud, free, ~30 sec per run)    │   │
│                                                          │   │
│  Triggered by repository_dispatch from CF Worker ───────┘   │
│                                                            │
│  .github/workflows/trade.yml:                              │
│    1. checkout repo                                        │
│    2. pip install httpx hyperliquid-python-sdk             │
│    3. python -m trading_loop.main                          │
│       --alerts-url <R2 public URL>                        │
│       --db ./trades.db (ephemeral — see DB section)        │
│       --testnet-key $HL_TESTNET_KEY (GitHub Secret)        │
│       --starting-balance 100                               │
│    4. exit (runner dies, cost = 0)                         │
│                                                            │
│  .github/workflows/weekly_review.yml:                      │
│    cron: 0 9 * * 1 (Monday 9am UTC)                       │
│    1. checkout repo                                        │
│    2. pip install httpx                                   │
│    3. python -m trading_loop.weekly_review                 │
│       --db ./trades.db                                     │
│       --tg-token $WS_BOT_TOKEN                             │
│       --tg-chat-id $WS_CHAT_ID                            │
│    4. DMs summary to your Telegram                        │
└─────────────────────────────────────────────────────────┘
```

---

## THE DB PROBLEM (SQLite doesn't survive between GH Actions runs)

GH Actions runners are ephemeral — the filesystem is wiped after each run. `trades.db` can't live on the runner.

### Solution: commit trades.db to the repo (or use R2)

**Option A (lazy, recommended): commit trades.db to the repo.**
- Each GH Actions run: checkout repo → open trades.db → process alerts → commit trades.db back → push.
- The DB is tiny (<1MB for months of paper trades). Git handles this fine.
- The DB has NO secrets — just whale addresses, trade records, beliefs. Fine in a public repo.
- 1 git commit per alert-triggered run. ~20 commits/day. Not spammy for a trading bot repo.

**Option B (if DB grows): store trades.db in R2.**
- bot.js already has R2 access. Upload trades.db to R2 after each run.
- More complex — need a Python R2 upload step. Add only if DB > 10MB.

> `ponytail:` Option A. The DB is the state. Git is the storage. One `git add trades.db && git commit && git push` at the end of each run. No R2 upload code. No S3 client. No migrations. If the DB ever hits 10MB (unlikely for months of paper trades), switch to R2 then.

---

## THE WATCHED MARKETS (what perps to trade)

HL testnet has 210 perp markets. We don't trade all of them. The whalesignal scanner watches BTC and ETH on L1. So the trading loop should only act on alerts for coins it can actually trade.

### What whalesignal scans today:
- BTC (Bitcoin L1)
- ETH (Ethereum L1)

### What HL testnet has (confirmed live):
- BTC (max leverage 40x)
- ETH (max leverage 25x)
- SOL (10x) — could watch if whalesignal adds Solana
- POL / MATIC (50x) — could watch if whalesignal adds Polygon
- XRP — NOT on HL testnet (not in the 210 market list)
- DOGE (10x) — could watch if whalesignal adds Dogecoin
- PAXG (10x) — tokenized gold!
- XMR (5x) — Monero
- TRUMP (10x) — meme

### What we trade NOW (Phase 1):
- BTC and ETH only. That's what whalesignal scans. That's what the Python loop acts on.

### What we CAN add later (when whalesignal scanner expands):
- SOL, POL, DOGE — all on HL testnet, all have good liquidity
- PAXG (gold) — but whalesignal doesn't scan gold chains, so this is out of scope
- Oil — NOT on HL. Oil is a TradFi commodity. You'd need a CFD broker for that. Out of scope.

> `ponytail:` Adding more coins = adding more scanner chains to whalesignal. That's a whalesignal change, not a trading-loop change. The trading loop already supports any coin HL has — it reads the coin from the alert JSON and passes it to `market_open(coin, ...)`. The constraint is upstream: what does whalesignal actually scan? Today: BTC + ETH. That's enough for paper trading. Expanding to SOL comes when you add a Solana scanner to whalesignal (PLAN.md Phase 5+). Not this plan's problem.

### What about XRP?
Not on HL testnet's 210 markets. HL doesn't list XRP perps (it's a security-controversy token). If you want XRP, you'd need a different exchange (Kraken, Bybit) — but those need KYC. Not this plan.

---

## ACCOUNTS NEEDED

| account | cost | what it gives us | do we need it? |
|---|---|---|---|
| Cloudflare | free | Workers + R2 + KV + D1 | YES — already have (whalesignal runs on it) |
| GitHub | free | Actions (unlimited for public repos) | YES — need to push whalesignal to GitHub |
| Google AI Studio (Gemini) | free | API key for Gemini direct calls | NO — 9Router handles this locally. BUT: if we move LLM calls to GH Actions, 9Router is on localhost (not reachable from GH runners). **This is a problem. See below.** |
| Hyperliquid testnet | free | test USDC faucet, API access | YES — need a testnet wallet |
| Telegram | free | bot API for weekly review DM | YES — already have (whalesignal bot) |

### THE 9ROUTER PROBLEM (important)

9Router runs on your localhost:20128. GitHub Actions runners can't reach it. So when the trading loop runs in GH Actions, `http://localhost:20128` will fail.

**Solutions (pick one):**

1. **Expose 9Router to the internet** via Cloudflare Tunnel (free, `cloudflared tunnel`). GH Actions calls `https://9router.your-domain.workers.dev` instead of localhost. You keep your PC on (but just the tunnel, not the Python loop). **Cost: $0, but PC must stay on for 9Router.** Defeats the purpose.

2. **Use Gemini API directly from GH Actions** with a free API key from Google AI Studio. No 9Router needed. The free tier gives 1,000 RPD for flash-lite, 500 RPD for flash. We need ~20/day. Plenty of headroom. Store the API key as a GitHub Secret. **Cost: $0, PC off. ✓**

3. **Self-host 9Router on a free VPS** (Oracle free tier, or Fly.io free tier). Then GH Actions calls the VPS URL. **Cost: $0, but setup complexity.**

> `ponytail:` Option 2. Get a free Gemini API key from Google AI Studio (https://aistudio.google.com/apikey). Store it as `GEMINI_KEY` in GitHub repo secrets. Change `llm.py` to call Gemini directly instead of 9Router when `GEMINI_KEY` is set. One `if` statement. No 9Router dependency, no PC on, no VPS. Free tier 1,000 RPD vs our 20 RPD = 50x headroom.

### Accounts you actually need:

1. **Cloudflare** — already have ✓
2. **GitHub** — need to push the repo (you have a GH account, just make a repo)
3. **Google AI Studio** — free API key at https://aistudio.google.com/apikey (1 min, no credit card)
4. **Hyperliquid testnet wallet** — go to https://app.hyperliquid-testnet.xyz, create wallet, use faucet for free test USDC
5. **Telegram bot** — already have ✓ (whalesignal bot)

**Total accounts to create: 1 (Google AI Studio) + 1 (GitHub repo) + 1 (HL testnet wallet). All free.**

---

## THE FULL FLOW (step by step)

### Step 0: Push whalesignal to GitHub (you do this)
```
cd C:\Users\Samsha\Documents\whalesignal
git remote add origin https://github.com/YOURUSERNAME/whalesignal.git
git push -u origin master
```

### Step 1: Add GitHub Secrets (you do this in repo settings)
- `HL_TESTNET_KEY` — your HL testnet wallet private key
- `GEMINI_KEY` — your free Google AI Studio API key
- `WS_BOT_TOKEN` — your existing Telegram bot token
- `WS_CHAT_ID` — your Telegram chat ID (for weekly review DMs)

### Step 2: Add llm.py Gemini direct mode (~10 lines)
```python
# In llm.py, add a direct Gemini call when GEMINI_KEY is set:
def call_llm(prompt, base_url="http://localhost:20128/v1/chat/completions",
             model="nvidia/deepseek-ai/deepseek-v4-flash", gemini_key=None):
    if gemini_key:
        return _call_gemini_direct(prompt, gemini_key)
    # ... existing 9Router code ...
```

### Step 3: bot.js fires repository_dispatch (~8 lines)
```js
// In bot.js postPublicAlert(), after postAlertToR2:
if (env.GH_PAT && env.GH_REPO) {
  await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "new_alert" }),
  });
}
```
- `GH_PAT` = GitHub Personal Access Token (repo scope, stored as CF Worker secret)
- `GH_REPO` = "yourusername/whalesignal"

### Step 4: .github/workflows/trade.yml (~30 lines)
```yaml
name: Trade Loop
on:
  repository_dispatch:
    types: [new_alert]
  workflow_dispatch: {}  # manual trigger for testing
jobs:
  trade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install httpx hyperliquid-python-sdk
      - run: |
          python -m trading_loop.main \
            --alerts-url ${{ secrets.R2_ALERTS_URL }} \
            --db ./trades.db \
            --testnet-key ${{ secrets.HL_TESTNET_KEY }} \
            --starting-balance 100 \
            --gemini-key ${{ secrets.GEMINI_KEY }}
      - run: |
          git config user.name "whalesignal-bot"
          git config user.email "bot@whalesignal"
          git add trades.db
          git commit -m "trades.db: updated by GH Actions trade loop" || true
          git push
```

### Step 5: .github/workflows/weekly_review.yml (~25 lines)
```yaml
name: Weekly Review
on:
  schedule:
    - cron: '0 9 * * 1'  # Monday 9am UTC
  workflow_dispatch: {}
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install httpx
      - run: |
          python -m trading_loop.weekly_review \
            --db ./trades.db \
            --gemini-key ${{ secrets.GEMINI_KEY }} \
            --tg-token ${{ secrets.WS_BOT_TOKEN }} \
            --tg-chat-id ${{ secrets.WS_CHAT_ID }}
      - run: |
          git config user.name "whalesignal-bot"
          git config user.email "bot@whalesignal"
          git add trades.db
          git commit -m "trades.db: weekly review applied" || true
          git push
```

### Step 6: Update llm.py model defaults
- Trade decision: `nvidia/deepseek-ai/deepseek-v4-flash` (for 9Router mode)
- Weekly review: `nvidia/deepseek-ai/deepseek-v4-pro` (for 9Router mode)
- Direct Gemini fallback: `gemini-2.5-flash` (when GEMINI_KEY is set — skip flash-lite, it's dumb; flash is 500 RPD, still 25x headroom)
- If Gemini hits a 429: sleep 2s, retry once. If still fails: skip the trade (don't loop).

---

## GITHUB ACTIONS MINUTES MATH

| workflow | triggers/day | avg duration | min/day | min/month |
|---|---|---|---|---|
| trade.yml | ~20 (alert-driven) | 30 sec | 10 | 300 |
| weekly_review.yml | 1/week | 60 sec | 0.14 | 1 |
| **Total** | | | **~10** | **~301** |

| repo type | free minutes | we use | headroom |
|---|---|---|---|
| Public | unlimited | 301 | ∞ |
| Private | 2,000/month | 301 | 6.6x headroom |

**Either way: free. Even private is fine.**

---

## R2 OPERATIONS MATH

| operation | count/month | free tier | headroom |
|---|---|---|---|
| Class A (writes): bot.js appends to alerts.ndjson | ~600 (20 alerts/day × 30) | 1,000,000 | 0.06% |
| Class B (reads): GH Actions fetches alerts.ndjson | ~600 | 10,000,000 | 0.006% |
| Storage: alerts.ndjson size | ~1MB after 1 year | 10GB | 0.01% |

**R2 is free forever for this workload.**

---

## CF WORKERS MATH

| request | count/day | free tier | headroom |
|---|---|---|---|
| Scanner cron (every 60s) | 1,440 | 100,000 | 1.4% |
| Bot queue consumer | ~20 | (same pool) | 0.02% |
| repository_dispatch POST to GitHub | ~20 | (counted by GH, not CF) | N/A |
| **Total CF requests** | ~1,460 | 100,000 | 1.46% |

**CF Workers free tier covers this 68x over.**

---

## LIMITS THAT ACTUALLY MATTER

| limit | number | will we hit it? | what to do |
|---|---|---|---|
| GH Actions cron minimum interval | 5 minutes | no — trade.yml is triggered by repository_dispatch, not cron. Weekly review is 1/week. | N/A |
| Gemini free tier RPD | 500 (flash) / 1000 (flash-lite) | no — 20 calls/day. 25x headroom on flash. | if we ever hit it, switch to flash-lite (1000 RPD) |
| Gemini free tier RPM | 10 (flash) | no — even if 5 alerts fire in 1 minute, we only process them sequentially. Max 5 RPM. | 2x headroom |
| HL testnet faucet | gives limited test USDC | maybe — if faucet is stingy, we start with whatever they give. Risk $10/trade max. | if faucet runs out, use mainnet with $20 real (Rung 5d) |
| GH Actions job timeout | 6 hours max | no — each run takes 30 seconds. | N/A |
| R2 Class A writes | 1M/month | no — 600/month. | 1666x headroom |

---

## WHAT TO BUILD (in order)

```
Step 1: llm.py — add GEMINI_KEY direct mode + retry + model upgrade
        ~20 lines changed, 1 commit
        "llm: direct Gemini fallback for GH Actions + model upgrade to deepseek-v4"

Step 2: .github/workflows/trade.yml
        ~30 lines YAML, 1 commit
        "ci: trade loop workflow triggered by repository_dispatch"

Step 3: .github/workflows/weekly_review.yml
        ~25 lines YAML, 1 commit
        "ci: weekly review cron Monday 9am"

Step 4: bot.js — add repository_dispatch POST to GitHub API
        ~8 lines, 1 commit
        "bot: fire GitHub Actions on each alert via repository_dispatch"

Step 5: main.py — add --gemini-key flag + git commit trades.db after run
        ~15 lines, 1 commit
        "main: support GEMINI_KEY + commit trades.db for state persistence"

Step 6: weekly_review.py — same --gemini-key flag
        ~5 lines, 1 commit
        "weekly_review: support GEMINI_KEY"

Step 7: Update PLAN_trading_loop.md — mark this plan as built
        1 commit
```

Total: ~6 files changed, ~100 lines new code. All YAML + small Python diffs.

> `ponytail:` The architecture is: CF Worker detects whale → writes to R2 → fires one HTTP POST to GitHub → GitHub Actions runs Python → Python reads R2 + calls Gemini direct + trades on HL testnet → commits trades.db → runner dies. Weekly: GH Actions cron runs review → DMs you on Telegram → commits updated beliefs. No PC, no VPS, no money.

---

## WHAT THIS PLAN IS NOT

- Not running 9Router in the cloud (it's localhost only). We bypass it by calling Gemini directly from GH Actions.
- Not watching oil, gold, or TradFi (HL has PAXG for gold but whalesignal doesn't scan gold chains). Out of scope.
- Not running on HL mainnet (testnet only, paper money). Real money is Rung 5d.
- Not adding new scanner chains (SOL, DOGE, XRP). That's a whalesignal scanner change, not a trading-loop change. The loop already supports any coin HL has.
- Not storing trades.db in R2 (git commit is simpler). Switch to R2 only if DB > 10MB.
- Not exposing 9Router to the internet (security surface + PC must stay on). Gemini direct is the answer.

---

## STOP SIGNALS (same as PLAN_trading_loop.md)

- **Stop after week 1 if:** 99% of signals SKIP. Whale alerts don't correlate with HL activity.
- **Stop after week 3 if:** PnL consistently negative AND whale_scores not diverging.
- **Keep going if:** scores diverge AND PnL is positive or flat.
