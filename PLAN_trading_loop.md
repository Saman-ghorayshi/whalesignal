# WhaleSignal Trading Loop — Unified Plan

**Replaces:** `PLAN_trading_loop_self_learning.md` (pre-research draft)
**Parents:** `PLAN.md` (whalesignal Phase 3), `PLAN_whale_reasoning.md` (Ladder A-C)
**Research base:** `RESEARCH_whale_trading_projects.md` + 6 papers/repos cited inline
**Date:** 2026-07-17
**Goal:** Close a feedback loop: whalesignal's on-chain whale alerts feed a paper-trading bot on Hyperliquid testnet that learns from outcomes and adjusts its own strategy — using proven patterns from actual research, not invented architecture.

This is the plan for handing to another AI or developer. It's self-contained: the research findings that justify each decision are inline, not in a separate doc.

---

## THE SHORT VERSION (read first)

You have a working system (whalesignal) that detects crypto whale moves on L1 and AI-interprets them. You want to (1) paper-trade $100 fake money based on those signals, (2) have the bot learn from results and adjust, (3) report back to you. This plan connects whalesignal to a Python trading loop on Hyperliquid testnet that uses three patterns from published research and three existing repos. Nothing is built from scratch — each piece is borrowed from a proven project at the minimum dose.

Three research patterns we borrow, each from a specific paper, at minimum dose:

1. **Bull/bear debate before each trade** — from TradingAgents (93.4k stars, TauricResearch). Their trader agent acts only after a bullish and bearish researcher argue. We collapse 5 agents into one LLM call that forces both sides before deciding COPY/SKIP.

2. **Conceptual verbal reinforcement (self-critique)** — from FinCon (NeurIPS 2024). After each trading episode, the agent critiques its own decisions and writes new natural-language "beliefs" that guide future trades. NOT just a numeric score bump — a written rule the agent re-reads next week.

3. **Layered memory** — from FinMem (ICLR 2024). Short-term memory (the trade log) + long-term memory (per-whale beliefs + global regime notes). The agent reads BOTH before each decision and each weekly review.

Three repos we reuse, not rebuild:

4. **Lindagrey/hyperliquid-copy-trader** — reference for HL testnet request shape (httpx + EIP-712 signed messages). STUDY, DON'T IMPORT.

5. **sanketagarwal/hyperliquid-trading-agent** (402 stars) — reference for the safety-guard pattern (position caps, daily circuit breaker, max leverage). We copy the GUARDS, not the per-trade Claude pattern.

6. **FinMem repo** (pipiku915/FinMem-LLM-StockTrading) — reference for the memory code structure. They split memory/ and agents/ dirs; we follow the same shape.

> `ponytail:` Each pattern is ONE LLM call or ONE SQLite column. Total new code: ~600 lines Python + ~40 lines JS in whalesignal. The full TradingAgents framework is 251 commits across 50+ files. We take the three IDEAS, not the codebases. The full FinCon multi-agent hierarchy (manager-analyst-researcher) is 5 LLM calls per decision. We collapse it to one call per week. The full FinMem has a profiling module with character design. We skip that — our agent's personality is "copy whales that make money, skip whales that don't." No character needed.

Total new infra cost: $0 if you run on your Windows laptop (single Python process, you already have Python 3.11 + git-bash). Or $5/mo for a 2GB VPS. No new framework, no event bus, no message queue, no worker pool, no web UI.

---

## THE PROBLEM THIS SOLVES

Whalesignal today: detects whale moves on BTC/ETH L1, AI-interprets them, posts to Telegram. It's a one-way signal producer. It has no feedback loop — you don't know if following the alerts would have made money. You also don't know which whale wallets produce profitable signals vs. which are noise.

This plan adds the missing half: take the signal, paper-trade on it, record what happened, learn from it, and adjust which signals to trust next week. The output is a weekly report to your Telegram telling you (a) what the bot learned this week, (b) which whales it now trusts more/less, and (c) a summary you can read in 10 seconds.

---

## THE PAPERS AND WHAT WE BORROW (with proof each pattern earns its weight)

### Paper 1: TradingAgents (TauricResearch, arXiv 2412.20138, v0.3.1 July 2026)

**The paper:** Multi-agent LLM trading firm. Analyst Team (fundamentals, sentiment, news, technical) → Researcher Team (bullish vs bearish debate) → Trader Agent → Risk Management → Portfolio Manager. LangGraph-based. 93.4k stars on GitHub. 251 commits. Active — v0.3.1 released July 2026, supports Claude Sonnet 5, Fable 5, DeepSeek, Qwen, GLM, Azure. Docker support. CLI. Tests. This is a real maintained framework, not a paper artifact.

**The pattern we borrow — the debate shape:**
Before each trade, a bullish and bearish case is made explicitly, then a decision follows. In the full framework that's 5+ LLM calls per decision (analyst team + researchers + trader + risk). We force both sides into ONE call:

```
You are deciding whether to paper-copy this whale trade on Hyperliquid.

Whale alert (from whalesignal): {alert_json}
Whale's current HL position: {hl_position}
Beliefs about this whale: {whale_beliefs}
Current market regime: {regime}

Bearish case (3 sentences max): ...
Bullish case (3 sentences max): ...
Decision: COPY or SKIP
If COPY: side (long/short), size_pct (0-100), TP_pct, SL_pct
Confidence: 0.0-1.0
Return JSON only.
```

One call. Two sides. One decision. The structure that caught 93k people's attention, collapsed to the part that matters.

> `ponytail:` TradingAgents' real innovation is the researcher debate. The analyst team, risk committee, portfolio manager — that's hierarchical approval, useful for a firm with humans, overkill for a $100 paper bot copying whales. One call that forces both sides captures 80% of the value at 1/5 the cost. Full TradingAgents costs ~20-50 LLM calls per decision (debate + approval chain). Our trade decision costs 1 call. Weekly review costs 1 call. Total: ~10-20 LLM calls per week depending on alert volume.

**Why we don't import their code:**
- Their framework targets equities (Alpha Vantage, yfinance). ours is crypto perps on Hyperliquid.
- They fetch fundamentals (P/E, earnings) — irrelevant for BTC/ETH whale copy trading.
- 251 commits across 50+ files. Importing the framework imports its assumptions. We want the SHAPE, not the codebase.

### Paper 2: FinCon (Yu et al., NeurIPS 2024, arXiv 2407.06567)

**The paper:** Manager-analyst LLM hierarchy with "conceptual verbal reinforcement." After each trading episode the agent critiques its own decisions and writes NEW "conceptualized beliefs" — natural-language rules like "avoid shorting in low-volatility regimes" or "this wallet's bearish signals in fear regimes lose 80% of the time" — that guide future decisions. Beliefs are selectively propagated to relevant agents.

**The pattern we borrow — the self-critique loop:**
The weekly review doesn't just bump a numeric score. It writes BELIEFS in natural language. These beliefs are re-read before every future trade decision and every future weekly review. This is the difference between:
- Numeric-only: "score 0.30" (you don't know why)
- With beliefs: "this wallet opens shorts in fear regimes and loses 80% of the time — skip bearish signals from this address when F&G < 25" (you know exactly what broke)

The weekly-review prompt asks the LLM to output both:
- updated whale_scores (0-1 numeric)
- updated beliefs (natural-language rules, stored as TEXT)

**Code on GitHub:** MXGao-A/FAgent (32 stars, 7 commits). Real dirs: agents/, memory/, risk_control/, modules/. Study their `memory/` for how they persist beliefs across episodes.

> `ponytail:` FinCon uses 5 agents per decision and propagates beliefs between them — that's its research contribution. We use ONE weekly agent and write beliefs to a SQLite TEXT column. Same concept, zero inter-agent communication. The communication overhead in FinCon is 4-5 LLM calls per propagation step. We have one propagation step per week (weekly review → beliefs table → next week's trade decisions read those beliefs).

### Paper 3: FinMem (Li et al., ICLR 2024, arXiv 2311.13743)

**The paper:** LLM trading agent with layered memory. Three layers:
- Layer 1: immediate market state (current candle, price)
- Layer 2: recent transaction history (last N trades the agent made)
- Layer 3: long-term characterization (beliefs about the market regime)

**The pattern we borrow — the memory shape:**
Our SQLite has two memory layers mapped to FinMem:
- Short-term = `paper_trades` table (FinMem layer 2: recent trades)
- Long-term = `beliefs` table (FinMem layer 3: per-whale + global rules)

Layer 1 (immediate market state) is already in whalesignal's `market_cache` KV (Coingecko price + alternative.me fear/greed). We pass it THROUGH in the alert payload from R2. We don't re-fetch it in Python.

Before each trade decision, trading_loop.py reads both layers:
- the last 5 trades for THIS whale specifically (`SELECT * FROM paper_trades WHERE whale = ? ORDER BY opened_at DESC LIMIT 5`)
- the beliefs for THIS whale (`SELECT belief FROM beliefs WHERE scope = 'whale' AND target = ?`)
- the global regime beliefs (`SELECT belief FROM beliefs WHERE scope = 'global'`)

Before each weekly review, weekly_review.py reads:
- all trades from the last 7 days
- all existing beliefs (whale + global)
- the current whale_scores

**Code on GitHub:** pipiku915/FinMem-LLM-StockTrading. Study their `memory/` dir for the read-write pattern. They read both layers before each decision. We do the same.

> `ponytail:` FinMem has a "profiling" module that assigns the agent a personality and character setting ("you are a conservative trader named Fred"). We skip this. Our agent's personality is the beliefs table — if it has learned to be conservative by losing money on aggressive trades, it IS conservative. Character design is the nice-to-have we cut.

---

## THE THREE REPOS WE REUSE (not rebuild)

### Repo 1: Lindagrey/hyperliquid-copy-trader

- **GitHub:** github.com/Lindagrey/hyperliquid-copy-trader
- **Stats:** 5 stars, ~1 month old, Python/Flask
- **What it has:** full Hyperliquid copy-trading pipeline — wallet watcher, simulation mode on virtual capital, live trading with EIP-712 signed orders via `hyperliquid-python-sdk`
- **What we steal:** the HL testnet request shape. Their `hl_trading.py` shows exactly which httpx calls + which signed-message fields HL accepts. We don't import their Flask UI or their per-wallet allocation sliders — we drive from CLI + cron, not a browser.
- **Why not import the whole thing:** their Flask UI is the product; we want the API layer underneath it

### Repo 2: sanketagarwal/hyperliquid-trading-agent

- **GitHub:** github.com/sanketagarwal/hyperliquid-trading-agent
- **Stats:** 402 stars, 181 forks (10:1 ratio, healthy), 30 commits (some co-authored with Claude → active iteration), last commit 3 months ago
- **What it has:** Claude-powered trader for Hyperliquid perps. Tech indicators computed locally. 8 hard-coded safety guards enforced IN CODE not just prompts. HIP-3 market support (stocks, commodities, indices, forex).
- **What we steal:** the safety-guard pattern. Their `src/risk_manager.py` has:
  - Max Position Size: 10% of portfolio per trade
  - Force Close at -20% loss
  - Max Leverage: 10x
  - Total Exposure cap: 50%
  - Daily Circuit Breaker: -10% daily drawdown stops new trades
  - Mandatory Stop-Loss: 5% if LLM doesn't specify one
  - Max 10 concurrent positions
  - Balance Reserve: don't trade below 20% of starting
- **Why not import the whole thing:** they hit Claude for every decision (expensive, requires anthropic key). We hit 9Router once per trade with the collapsed bull/bear prompt. We use their guard math + their `src/risk_manager.py` structure. Their `src/agent/decision_maker.py` we throw away.

### Repo 3: FinMem-LLM-StockTrading (pipiku915)

- **GitHub:** github.com/pipiku915/FinMem-LLM-StockTrading
- **Stats:** ICLR 2024 paper code. dirs: memory/, agents/, modules/
- **What it has:** Python implementation of FinMem's layered memory.
- **What we steal:** the directory shape (memory/ as a separate concern from agents/). The read/write patterns for each memory layer.
- **Why not import the whole thing:** it's equities-targeted (yfinance). The pattern is portable; the stock-specific code isn't.

---

## THE ARCHITECTURE (lazy, single process, SQLite state)

One Python process. One cron. One SQLite file. No framework.

```
┌──────────────────────────────────────────────────────────┐
│ whalesignal (CF Workers — ALREADY DEPLOYED)              │
│ scanner.js ─► D1 ─► queue ─► analyst.js ─► bot.js         │
│                                  │                        │
│                          NEW: bot.js also                 │
│                          writes alert JSON to R2          │
└──────────────────────────────────┼───────────────────────┘
                                   │ alert NDJSON on R2,
                                   │ polled every 60s
                                   ▼
┌──────────────────────────────────────────────────────────┐
│ trading_loop.py  (single Python process, cron every 60s)  │
│                                                           │
│  loop:                                                    │
│    1. fetch new alerts from R2 NDJSON                     │
│    2. for each alert:                                     │
│       a. fetch whale's HL position (Info API, no key)     │
│       b. read whale beliefs from SQLite                   │
│       c. read global regime beliefs from SQLite           │
│       d. read last 5 trades for this whale (FinMem L2)   │
│       e. ONE LLM call (bull/bear debate → COPY/SKIP)     │
│       f. risk_manager.check() — borrowed from sanket's    │
│          pattern: if COPY, validate guards before sending │
│       g. execute paper order on HL testnet                │
│       h. record trade in SQLite                           │
│    3. check open trades: TP/SL/time → close + record      │
└──────────────────────────────────┬───────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────┐
│ trades.db (ONE SQLite file, 5 tables)                     │
│                                                           │
│  signals       — every alert received                     │
│  paper_trades  — every trade opened/closed (FinMem L2)   │
│  whale_scores  — per-whale numeric score (0-1)           │
│  beliefs       — per-whale + global NL rules (FinMem L3) │
│  weekly_review — raw LLM output per week                 │
└──────────────────────────────────┬───────────────────────┘
                                   │
                          once a week (cron):
                                   ▼
┌──────────────────────────────────────────────────────────┐
│ weekly_review.py  (ONE LLM call per week)                 │
│                                                           │
│  1. read last 7 days of trades + outcomes                 │
│  2. read CURRENT beliefs (whale + global)                 │
│  3. LLM self-critique (FinCon pattern):                  │
│     - what worked, what didn't, what patterns             │
│     - write NEW beliefs (NL rules) → UPDATE beliefs       │
│     - update whale_scores (numeric) → UPDATE whale_scores │
│  4. send 5-sentence summary to your Telegram              │
│     (reuse whalesignal bot webhook, DM yourself)          │
└──────────────────────────────────────────────────────────┘
```

> `ponytail:` One Python file for the loop, one for review, one SQLite file, one LLM call per trade decision, one per week. The full TradingAgents framework has 5+ agents per decision. The full FinCon hierarchy has 5 agents arguing per decision. We have one call per trade + one per week. Total ~10-20 LLM calls/week. At gemini-flash-lite prices through 9Router that's free.

---

## WHAT EXISTS (reuse, do not rebuild)

| exists | where | status |
|---|---|---|
| whale detection on L1 (BTC/ETH) | `src/scanner.js` | works, writes to D1 |
| AI interpretation per whale (Gemini) | `src/analyst.js` buildPrompt | works, gives `{headline, interpretation, signal, confidence}` from whalesignal's own analyst |
| whale labels | `wallets` table + `exchanges.json` | 14 seeded, none auto-learned (this plan adds learning) |
| Hyperliquid testnet | `testnet.api.hyperliquid.xyz` (verify URL at `hyperliquid.gitbook.io`) | free, no deposit, same API shape as mainnet |
| `hyperliquid-python-sdk` | PyPI | thin wrapper over httpx/websockets; SDK optional, httpx direct works |
| 9Router LLM | `localhost:20128/v1/chat/completions` | gemini-3.1-flash-lite-preview, send `stream: false` in body or it defaults to SSE |
| whalesignal Telegram bot | `src/bot.js` | already works, can DM you |
| whalesignal R2 binding | check `wrangler.bot.toml` for R2 binding; add if not present | 10GB free tier covers NDJSON file easily |

We do NOT need:
- No TradingAgents framework import (take the debate shape, one call, not the codebase)
- No FinCon's 5-agent manager-analyst hierarchy (take the self-critique, collapse to weekly)
- No FinMem profiling module (character design — overkill)
- No HyPaper (HL testnet is free and serves the same role)
- No MarilynClarke bot (fork-spam smell — covered in RESEARCH doc)
- No investing-algorithm-framework (1.4k stars — overkill for one strategy; revisit in Rung 6+ if we need backtests)
- No full FinRL RL training loop (RL needs thousands of episodes; we have ~20-50 trades/week. Not enough data. Use LLM-based adjustment instead — that's the lazy/right move for this scale)

---

## THE STATE (SQLite, one file, 5 tables)

> `ponytail:` The `beliefs` table is the one we add vs the old draft. It's the FinCon + FinMem contribution — long-term memory in natural language, not just numbers.

```sql
CREATE TABLE signals (
  id INTEGER PRIMARY KEY,
  whale TEXT, chain TEXT, signal TEXT, from_label TEXT, to_label TEXT,
  usd_value REAL, detected_at INTEGER, raw_json TEXT,
  processed INTEGER DEFAULT 0  -- 0 = new, 1 = reached a COPY/SKIP decision
);

CREATE TABLE paper_trades (
  id INTEGER PRIMARY KEY,
  signal_id INTEGER, whale TEXT, side TEXT, size_usd REAL, entry_price REAL,
  coin TEXT, leverage INTEGER,
  opened_at INTEGER, closed_at INTEGER, exit_price REAL, pnl_usd REAL,
  close_reason TEXT,           -- tp, sl, time, circuit_breaker, manual
  bear_case TEXT,              -- the LLM's bearish case (audit trail)
  bullish_case TEXT,           -- the LLM's bullish case (audit trail)
  llm_confidence REAL,
  hl_order_id TEXT             -- the testnet order ID, for verification
);

CREATE TABLE whale_scores (
  whale TEXT PRIMARY KEY,
  trade_count INTEGER DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  total_pnl_usd REAL DEFAULT 0,
  score REAL DEFAULT 0.5,      -- 0-1, updated weekly by LLM
  last_updated INTEGER
);

CREATE TABLE beliefs (
  id INTEGER PRIMARY KEY,
  scope TEXT,                  -- 'whale' or 'global'
  target TEXT,                 -- whale address if scope='whale', else NULL
  belief TEXT,                 -- natural-language rule
  created_at INTEGER,
  source TEXT                  -- 'weekly_review' or 'manual'
);

CREATE TABLE weekly_review (
  week_id INTEGER PRIMARY KEY,
  review_text TEXT,            -- raw LLM output, kept for audit
  score_deltas TEXT,           -- JSON of {whale: delta}
  belief_changes TEXT,         -- JSON of {scope, target, belief}
  created_at INTEGER
);
```

That's it. One file. No migrations framework — run `CREATE TABLE IF NOT EXISTS` on boot.

---

## RUNG 1 — Alert bridge (whalesignal side, ~40 lines JS)

**What:** whalesignal's analyst.js already produces the alert JSON. Add ONE call to write that same JSON to R2 as an append-only NDJSON file.

**Why this rung:** closes the gap between CF Workers and your Python trading loop. Without this, trading_loop.py has no signal to act on.

**Files:**
- `src/bot.js` — add `await postAlertToR2(env, alert)` next to the existing `sendTelegram`. ~10 lines. The current bot already constructs the alert payload for Telegram; R2 upload reuses the same JSON shape.
- `wrangler.bot.toml` — add `[[r2_buckets]]` binding if not present. Use the existing Workers account; R2 free tier is 10GB.
- `tools/alert_export_schema.md` — short doc describing the NDJSON shape so Python knows what to parse. ~20 lines.

**Shape of one NDJSON line (this is the contract between whalesignal and Python):**

```json
{
  "id": 123,
  "whale": "0xABC...",
  "chain": "ETH",
  "signal": "exchange_inflow_during_fear",
  "from_label": "Unknown",
  "to_label": "Binance Hot Wallet",
  "usd_value": 5_200_000,
  "detected_at": 1721280000,
  "market": {"btc_price": 61200, "eth_price": 3100, "fear_greed": 22},
  "analyst_interpretation": "Whale moved 1500 ETH to Binance during ..."
}
```

**Test:** one assertion in `tests/bot.test.js` that the alert payload has `whale`, `chain`, `signal`, `usd_value`, `detected_at`, and `market.btc_price`. Don't unit-test R2 itself — just assert the shape matches the contract above.

**Cost:** $0 (R2 free tier).

> `ponytail:` Option A (webhook) was on the table — Flask listening for alerts. Skip it: CF Workers can't receive arbitrary POSTs without a worker-bound route, and securing a webhook is more code than the value. R2 NDJSON file is pull-based; no security surface; Python fetches it every 60s. One read per minute is free.

---

## RUNG 2 — trading_loop.py (the meat, ~250 lines)

**What:** a single Python file that polls alerts, decides COPY/SKIP via the bull/bear debate pattern, executes paper orders on HL testnet, records results.

**Why this rung:** this is the trading half of the loop. Without it, you have alerts but no trades to learn from.

**Flow:**

1. `main()` boots: open SQLite, run `CREATE TABLE IF NOT EXISTS` for all 5 tables, connect to HL testnet via httpx (URL: `https://api.hyperliquid-testnet.xyz` — verify against their docs first).
2. Every 60s: fetch R2 NDJSON, find `processed=0` signals.
3. For each new signal:
   a. Call HL Info API (`POST /info` with `{"type": "userFills", "user": "<whale_address>"}`) — no key needed, this is public. Get the whale's last 30 min of HL positions.
   b. Read memory from SQLite (FinMem L2 + L3):
      - `SELECT * FROM paper_trades WHERE whale = ? ORDER BY opened_at DESC LIMIT 5`
      - `SELECT belief FROM beliefs WHERE scope='whale' AND target = ?`
      - `SELECT belief FROM beliefs WHERE scope='global'`
      - `SELECT score FROM whale_scores WHERE whale = ?`
   c. ONE LLM call via 9Router with the bull/bear debate prompt (Paper 1 pattern):
      ```
      POST http://localhost:20128/v1/chat/completions
      body: {
        "model": "gemini/gemini-3.1-flash-lite-preview",
        "stream": false,
        "messages": [{"role": "user", "content": "<prompt>"}]
      }
      ```
      Prompt forces bearish_case / bullish_case / decision / side / size_pct / TP_pct / SL_pct / confidence.
   d. Parse JSON. If SKIP → `UPDATE signals SET processed=1`. Continue.
   e. If COPY → validate via `risk_manager.check()` (Repo 2 pattern):
      - position size: size_pct * balance <= 10% of starting balance
      - daily loss so far >= -10% of starting balance → circuit breaker, skip
      - current open positions >= 10 → skip
      - balance < 20% of starting → skip
      - leverage > 10x → cap to 10x
   f. Execute on HL testnet: `POST /exchange` with signed EIP-712 message. Use the shape from Lindagrey's `hl_trading.py` (Repo 1 study). You need a testnet wallet; HL's faucet gives you free test USDC for it.
   g. Insert into `paper_trades` with `bear_case`, `bullish_case`, `llm_confidence`, `hl_order_id`, `opened_at`.
   h. `UPDATE signals SET processed=1`.
4. Every iteration also checks open trades: if `exit_price` crossed TP or SL based on current HL testnet price, or `now - opened_at > 24h` (time limit), close the trade, compute `pnl_usd`, record `close_reason`.

**Files:**
- `trading_loop/main.py` — entry, loop, cron targets
- `trading_loop/hl_client.py` — ~80 lines: the testnet POST wrappers, EIP-712 signing (study Lindagrey's `hl_trading.py`)
- `trading_loop/risk_manager.py` — ~70 lines: the 6 guards from sanketagarwal's pattern (Repo 2). Pure functions, no LLM.
- `trading_loop/llm.py` — ~30 lines: the 9Router call wrapper. Takes prompt string, returns parsed JSON.
- `trading_loop/memory.py` — ~40 lines: read-only helpers for FinMem L2/L3 queries above. Wraps SQLite SELECT.
- `trading_loop/schema.sql` — the 5 CREATE TABLE statements

**Run:**
```
python trading_loop/main.py \
  --alerts-url https://<your-r2-bucket>.r2.cloudflarestorage.com/alerts.ndjson \
  --db ./trades.db \
  --testnet-wallet 0xPAPERTEST \
  --testnet-key 0xPAPERKEY \
  --starting-balance 100 \
  --llm http://localhost:20128/v1/chat/completions
```

**Test:** `python trading_loop/main.py --dry-run --alerts-file tests/fixture_alerts.ndjson`:
- boots, opens SQLite
- reads fixture with 3 alerts (1 bullish, 1 bearish, 1 ambiguous)
- calls LLM (or stubs it if 9Router down — set `HL_LLM_STUB=tests/fixture_llm_responses.json` env)
- decides COPY for bullish, COPY for bearish (both with risk_manager passing)
- decides SKIP for ambiguous on confidence < 0.4
- exits 0
- ~50 lines of test, no pytest dependency — just asserts against expected outcomes

**Cost:** $0. Testnet faucet gives free test USDC. 9Router is local + free trades cost ~1k tokens each.

> `ponytail:` The risk_manager is the only safety boundary. sanketagarwal's agents got burned by LLMs suggesting 100% allocation — they added code guards after the fact. We add them up front because the code already exists to copy. Don't trust the LLM to self-limit; enforce the guards in Python before the signed message leaves the process.

---

## RUNG 3 — weekly_review.py (the learn + report, ~200 lines)

**What:** runs once a week via cron. Reads last 7 days of trades, existing beliefs, current scores. ONE LLM call produces: updated beliefs (NL rules), updated whale_scores, 5-sentence summary. Writes all three to SQLite. DMs you the summary via whalesignal's Telegram bot.

**Why this rung:** this is the FinCon self-critique + FinMem long-term memory write. Without it, the loop has paper trades but no learning.

**Flow:**

1. Query `paper_trades` for last 7 days, joined to `signals` for context.
2. Compute per-whale: trade_count, win_count, total_pnl, avg_confidence.
3. Compute global stats: total trades, win rate, total PnL, biggest_loss, biggest_win.
4. Read existing `beliefs` (scope='whale' AND scope='global') and current `whale_scores`.
5. Build prompt for ONE LLM call:

```
You are reviewing a paper-trading bot's last 7 days. The bot copies
Hyperliquid testnet trades made by whale wallets when whalesignal's on-chain
alert system flags the same whale moving on L1.

The bot TRADES only when it sees a whale alert AND a matching HL position
opened by the same wallet within 30 minutes. It used the FinCon
self-critique pattern last week and wrote beliefs you'll see below.

## This Week's Trades
{trade_list_with_outcomes}

## Current Whale Scores
{score_list_with_win_rate_and_pnl}

## Current Beliefs
{existing_beliefs_nl}

Critique this week. Output JSON:
{
  "new_beliefs": [
    {"scope": "whale", "target": "0xABC...", "belief": "natural-language rule"},
    {"scope": "global", "target": null, "belief": "natural-language rule"}
  ],
  "updated_scores": [
    {"whale": "0xABC...", "new_score": 0.62, "reason": "1 sentence"}
  ],
  "weekly_summary": "5 sentences, plain English, what happened and what you changed"
}

Constraints:
- new_beliefs: write rules that would have prevented this week's losses OR
  would have amplified this week's wins. Each belief should be a one-sentence
  rule, not a paragraph.
- updated_scores: only change scores for whales with >= 3 trades this week.
  Score changes should reflect actual win rate + PnL, not vibes.
- weekly_summary: write TO Samsha, the human operator. Say "you" not "the bot."
  Tell him what worked, what didn't, and what you changed for next week.
```

6. ONE call to 9Router, same shape as Rung 2's call.
7. Parse JSON. UPDATE `beliefs` (insert new ones; old beliefs remain — they're a log, not overwritten). UPDATE `whale_scores`. INSERT into `weekly_review` (audit trail).
8. Send the `weekly_summary` to your Telegram via whalesignal bot's existing webhook:
   ```
   POST https://api.telegram.org/bot<TOKEN>/sendMessage
   body: {"chat_id": "<YOUR_CHAT_ID>", "text": summary}
   ```
   Use the same bot token already in whalesignal's env. No new bot.

**Files:**
- `trading_loop/weekly_review.py` — entry, the LLM call, SQLite updates
- `trading_loop/llm.py` — same wrapper as Rung 2; no new file.
- `trading_loop/tg_notify.py` — ~15 lines: the Telegram webhook POST. Or just inline it.

**Run:**
```
python trading_loop/weekly_review.py \
  --db ./trades.db \
  --llm http://localhost:20128/v1/chat/completions \
  --tg-token $WS_BOT_TOKEN \
  --tg-chat-id $YOUR_CHAT_ID
```

Cron: `0 9 * * 1` (Monday 9am — gives you weekend data + start-of-week decisions).

**Test:** `python trading_loop/weekly_review.py --dry-run --fixture tests/week1.json --llm-stub tests/fixture_review_response.json`:
- loads canned week of trades + existing beliefs
- runs the LLM call (or uses the stub if 9Router down)
- verifies new beliefs were written to `beliefs` table
- verifies whale_scores updated for whales with 3+ trades
- verifies weekly_summary exists in `weekly_review` row
- ~60 lines of test, asserts on table state not on LLM output quality

**Cost:** $0. One LLM call/week via local 9Router.

> `ponytail:` The beliefs table is an append-only LOG, not a state. Old beliefs stay. The LLM reads ALL of them next week and decides which still apply. This is FinCon's pattern — beliefs accumulate, the agent reasons over the full history rather than overwriting. Avoids "the bot forgot what it learned last month."

---

## RUNG 4 — REPORT BACK TO YOU (Telegram, ~20 lines)

**What:** weekly_review.py already posts the 5-sentence summary to your Telegram via the whalesignal bot (Rung 3 step 8). For the "report back" you asked for: that's it. One message per week, written in plain English by the LLM to "you" (Samsha), saying what worked, what didn't, and what the bot changed.

Optional add-on (~20 lines): if you want ongoing visibility without waiting for Monday, add a `/paperstatus` command to whalesignal's bot.js that reads from the live trades.db and returns current open positions + running PnL. One SQL query, one Telegram message. Skip this until you actually find yourself checking — YAGNI.

> `ponytail:` Use the existing whalesignal bot — don't build a second Telegram client. The summary ships via fetch to the existing bot webhook. One message/week. If you want it more often, bump cron to daily. Don't build a dashboard.

---

## RUNG 5+ (DEFERRED — only if data says to)

> `ponytail:` Don't ship these until Rungs 1-4 have 4 weeks of paper-trade data showing non-trivial learning (whale_scores actually diverge, beliefs actually change, not all "scores stuck at 0.5").

- **5a. Second decision rule**: skip alerts for whales the LLM demoted last week. That's one `if score < 0.3: SKIP` line added to the trade decision step. Ship this only if Rungs 1-4 show the LLM can reliably rank whales.
- **5b. Signal causality**: did the whale's L1 move PREDICT the HL position, or did HL open first? Phase 5 in PLAN.md. Adds one timestamp-correlation table. Ship only if you want to merge L1 and HL signals formally.
- **5c. Backtest harness**: switch to investing-algorithm-framework v8.10 (1.4k stars, 1842 commits). It handles backtests, parameter sweeps, Monte Carlo permutation tests. Overkill until you have 100+ paper trades and want to ask "what if I had changed TP from 3% to 5%?".
- **5d. Real money**: open positions on Hyperliquid mainnet with $20 real money, same logic. Only after 4 weeks of positive paper PnL.

---

## WHAT THIS PLAN IS NOT

- Not building the full TradingAgents multi-agent framework (we take the debate shape — one call, not 5+)
- Not building the full FinCon 5-agent manager-analyst hierarchy (we take the self-critique — one weekly call, not per-decision propagation)
- Not building the full FinMem profiling/character module (we take the memory-layer shape — SQLite tables, not personality)
- Not building an RL training loop (needs thousands of episodes; we have ~20-50/week — LLM-based adjustment is the right tool at this scale, RL isn't)
- Not auto-generating new trading strategies (TradingGroup does that; we don't). The strategy is hardcoded: copy whales the beliefs table trusts.
- Not running on Hyperliquid mainnet until Rung 5d (paper only for Rungs 1-4)
- Not replacing PLAN.md or PLAN_whale_reasoning.md — those still ship Ladder A on their own schedule. This plan wraps around whalesignal as a CONSUMER of its alerts.
- Not touching whalesignal's scanner or analyst logic — Rung 1 just adds one extra write to R2 alongside the existing Telegram send.

---

## COST SUMMARY

| item | cost | new infra |
|---|---|---|
| R2 alert NDJSON (1 file, append-only, Rung 1) | $0 (R2 free tier) | 0 — reuse existing Workers account |
| Hyperliquid testnet API (Rung 2-5) | $0 (testnet faucet gives free USDC) | 0 |
| 9Router LLM (Rungs 2-3) | $0 (localhost, gemini-flash-lite through Hermes' existing config) | 0 — already running |
| VPS (optional, Rungs 2-3) | $0 if you run on Windows; $5/mo for Hetzner CX22 2GB | 0 or 1 small VPS |
| Telegram delivery (Rung 4) | $0 (existing whalesignal bot) | 0 |

Total: $0 on Windows, or $5/mo on VPS. No new framework. No new cloud service. No new API keys.

---

## FAILURE AND STOP SIGNALS

**Stop after week 1 if:** trading_loop.py spends 99% of signals in the SKIP branch. That means your whalesignal L1 alerts don't correlate with Hyperliquid whale activity at all. Pivot: instead of matching the SAME whale on both chains (L1 + HL), just paper-copy HL leaderboard top traders based on their signal TYPE ("exchange inflow during fear" → open short on HL, regardless of whether the HL wallet is the same as the L1 whale). Removes the hard part (wallet matching) and tests the softer signal-only hypothesis.

**Stop after week 3 if:** PnL is consistently negative AND whale_scores isn't diverging (all whales stuck around 0.5). That means either (a) the signals aren't predictive, or (b) the LLM isn't learning anything useful from 7 days of data. Either way, paper-trading more weeks won't help — either add more data sources (news, Ladder A from PLAN_whale_reasoning.md) or accept that whale-copy alone isn't an edge.

**Keep going if:** whale_scores diverge (some whales consistently at 0.8+, others at 0.2) AND average PnL across trades is positive OR flat. The divergence IS the learning — even flat PnL with diverging scores tells you which whales are worth tracking for real money.

**Ship Rung 5a only if:** Rungs 1-4 showed the LLM can rank whales (weekly_review actually moved scores, didn't just leave them all at 0.5).

---

## ORDER OF OPERATIONS

```
Pre-req: ship PLAN_whale_reasoning.md Ladder A (fills news_cache).
         Takes ~50 lines, 1 day. Doesn't block this plan but makes the
         whalesignal alerts that feed this loop meaningfully better.

[RUNG 1] DONE — committed 85521a0
  Alert bridge (R2 NDJSON) — 40 lines JS + 3 tests
  bot.js: buildAlertJSON() pure contract builder + postAlertToR2() append
  wrangler.bot.toml: ALERTS_R2 binding added
  tools/alert_export_schema.md: NDJSON contract doc
  tests: 8/8 green (formatAlert 5 + buildAlertJSON 3)
  full suite: 33/33 green
  NEXT: deploy with wrangler to actually create the R2 bucket and binding

[RUNG 2] DONE — committed 99b7c16, 23252d8, 5786574
  trading_loop/ — 6 Python files, ~500 lines
  2a: schema.sql (5 tables), memory.py (FinMem L2/L3 reads), risk_manager.py (6 guards)
      self-test: memory + risk_manager pass against in-memory sqlite
  2b: hl_client.py (hyperliquid-python-sdk wrapper, SDK handles EIP-712),
      llm.py (9Router httpx wrapper, extract_json strips fences)
      verified: testnet Info API live, BTC=63k ETH=1821
  2c: main.py (loop + decision + dry-run), fixture_alerts.ndjson, fixture_llm_responses.json
      dry-run verified: COPY long for bullish, COPY short for bearish, SKIP for ambiguous
      3/3 signals processed, 2 trades opened, risk_manager clamped sizes correctly
  NEXT: run live for 1 hour with $100 fake USDC (needs testnet wallet from faucet)
        check: at least one COPY decision fires, one SKIP, one close-on-TP

[RUNG 3] NEXT — ~200 lines Python + test
  weekly_review.py — FinCon self-critique loop + Telegram report
  commit: "weekly_review: FinCon self-critique loop + Telegram report"
  verify: cron Monday 9am fires, you get Telegram DM with summary,
          whale_scores updated, beliefs table has new rows

[RUNG 4] OPTIONAL — ~20 lines, YAGNI
  bot.js: /paperstatus command for live position check
  skip if you don't find yourself checking — YAGNI

WATCH 4 WEEKS. Then decide Rung 5a based on stop signals above.

Rung 5+: deferred per stop signals section above
```

---

## PONYTAIL TALLY

- New framework: 0
- New external services: 0 (reuse R2, HL testnet, 9Router, existing bot)
- New LLM calls: ~10-20 per week (1 per trade decision + 1 per weekly review)
- New code: ~550 lines Python + ~40 lines JS + ~150 lines tests = ~740 total
- New SQLite tables: 5 (one file, no migration framework)
- New infra: optionally one $5/mo VPS, or $0 on existing Windows laptop
- Repos studied (not imported): 3 — Lindagrey, sanketagarwal, FinMem
- Papers applied (not reimplemented): 3 — TradingAgents, FinCon, FinMem
- Patterns taken from research at minimum dose: debate shape (1 call), self-critique (1 weekly call), layered memory (2 SQLite tables)
- Rungs skipped until data: parameter sweep, backtest framework, real money, RL training, full multi-agent framework, strategy auto-generation

The shortest path to "bot that learns and reports back": paper-trade on HL testnet → record outcomes in SQLite → one LLM call per week rewrites the beliefs table → that table steers next week's trade decisions. Three papers, three repos, three patterns at minimum dose — none at full complexity.
