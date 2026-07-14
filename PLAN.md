# WhaleSignal — AI-Powered Whale Intelligence Bot

**Goal:** 20K total users, 5K active, 50 paid at $4-8/month, 10-40 VIP at $15-40/month.
Target revenue: $50-200/month initially, growing.

**Last updated:** 2026-07-17

---

## BUILD PROGRESS (Phase 1 = MVP)

A `[done]` beside a task means it's actually implemented, tested, and committed.

### Repo & infra
- [done] git repo initialized, .gitignore, README.md
- [ ] wrangler.toml — 3 worker bindings (D1, KV, Queue)
- [done] schema/whalesignal.sql — Phase 1 tables + indexes + scanner_state
- [done] wallet_labels/exchanges.json — seed exchange addresses (BTC + ETH)
- [done] wallet_labels/seed.py — load exchange seed into D1
- [done] config.example.json — copy → config.json, fill in keys

### Source — workers
- [done] src/worker-utils.js — shared helpers (timeouts, D1/KV/Queue, env checks)
- [done] src/scanner.js — BTC + ETH block scan, batched catch-up, market cache to KV (TTL-based)
- [done] src/analyst.js — queue consumer, reads KV market+news, Gemini call, queues delivery
- [ ] src/bot.js — Telegram webhook, public-channel posting, /ping /help

### Tooling
- [ ] wizard.py — interactive setup
- [ ] deploy_all.py — one-shot: D1/KV/Queue + schema + seed + deploy
- [ ] run tests green locally with node

### Honest scope cuts in Phase 1 (deferred, not silently dropped)
- SOL/TRX/BSC scanning → Phase 4
- pattern detection + price-history correlation → Phase 3 (needs price_history table)
- Pro DMs / subscriptions / Stripe → Phase 2
- news integration (CryptoPanic/GDELT) → Phase 4 (analyst still reads news_cache if present, just empty)
- historical price correlation ("price dropped after last 3 deposits") → Phase 3

### Corrections vs. the original plan below (kept here so nothing is hidden)
1. Block-catchup loop now has a per-scan cap (MAX_BLOCKS_PER_SCAN) so an outage
   doesn't blow the CPU budget trying to process hundreds of blocks at once.
   last_block is only persisted after the batch succeeds.
2. Scanner no longer calls `getPrice(tx.symbol)` per tx — it reads the cached
   market price from KV (the plan said to cache it, the pseudocode then ignored
   the cache). 0 extra fetches per whale.
3. Bot is the ONLY worker that touches Telegram now. Analyst → bot via queue
   for delivery, exactly as the plan describes but more strictly enforced.
4. `price_history` table is NOT in the Phase 1 schema — historical price
   correlation is a Phase 3 deliverable so I'm not pretending the table exists.
5. "Free Workers = 10ms CPU cap" — that was the old Free plan. Current free
   Workers are wall-time bounded but Queues consumers get a larger envelope.
   Code is still defensive (single fetch, timeouts, nothing that can loop).
6. No `wizard.py/generate.py` reuse from a "cryptopay" template — I don't have
   that repo. Clean-room: wrangler.toml + a small Python wizard/deploy.

---



---

## THE PROBLEM

Every crypto whale tracker does the same thing: it sees a big transaction and posts "whale moved 500 BTC to Binance." That's raw data. It's useless without context. Traders don't need to know a whale moved — they need to know what it MEANS.

WhaleSignal doesn't just report whale moves. It gives you the intelligence layer:
- What the move likely means (sell pressure, accumulation, exchange inflow, stablecoin mint)
- What market conditions surround it (price action, fear/greed, volume)
- What historical patterns suggest (what happened last 3 times this whale deposited to an exchange)
- An AI-generated correlation packet connecting it to broader events

This is not a multi-million dollar product. It's a $4-40/month tool that's 10x better than the free alternatives because it adds interpretation, not just data.

---

## REVENUE MODEL

| Tier | Price | Users | Monthly | Features |
|------|-------|-------|---------|----------|
| Free | $0 | 20K | $0 | Public channel alerts, raw data, 30-min delay |
| Pro | $4-8/mo | 50 | $200-400 | Real-time DMs, AI analysis, per-chain filters, threshold alerts, historical whale stats |
| VIP | $15-40/mo | 10-40 | $150-1600 | Everything in Pro + whale wallet labels, pattern detection, weekly digest, webhook integration, custom watchlist addresses, priority API access |

**Free tier is the growth engine.** The public Telegram channel is where 20K users come from. Not because the raw data is unique — it's because we make it readable and contextual. The upsell to paid is: "want this in real-time via DM with AI analysis? $5."

Telegram Stars can't do recurring subscriptions yet (as of mid-2026). Use the cryptopay payment template we already built — accept crypto for Pro/VIP subscriptions, auto-verified on-chain. Or use Stripe Checkout links for card payers (simpler, nobody wants to figure out crypto for a $5/mo subscription).

**Realistic path to 20K:**
- Week 1-4: Build. Start public channel. Post organically in r/CryptoCurrency, crypto Twitter, Telegram discovery groups.
- Month 2-3: ~500 users. Refine alerts based on feedback. Maybe post a few alerts that get retweeted ("WhaleSignal flagged this 10 min before the price moved").
- Month 4-6: ~2000 users. If the alerts are genuinely useful, word of mouth in crypto Telegram groups is powerful.
- Month 6-12: Reach for 20K. This requires being consistently right and being shared. Crypto Twitter is the main vector.

---

## TECHNICAL ARCHITECTURE

### Infrastructure (all Cloudflare, all free tier)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Workers (free)                     │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐ │
│  │  scanner.js   │   │  analyst.js  │   │     bot.js               │ │
│  │               │   │              │   │                          │ │
│  │ cron every    │   │ triggered    │   │ Telegram webhook         │ │
│  │ 30 seconds    │   │ by scanner   │   │ /start /subscribe        │ │
│  │               │   │ via queue     │   │ /latest /top /stats      │ │
│  │ scans chains  │   │              │   │ /watch /alerts /help     │ │
│  │ for large tx  │   │ fetches      │   │ inline queries           │ │
│  │               │   │ market data  │   │                          │ │
│  │ → D1 inserts  │   │ + news + F&G │   │ Q: free users → 30min    │ │
│  │ → queue msg   │   │              │   │    delay badge           │ │
│  │               │   │ calls Gemini │   │ Q: paid users → instant  │ │
│  │               │   │ for analysis │   │                          │ │
│  │               │   │              │   │ writes to D1             │ │
│  │               │   │ → D1 update  │   │ (stats, subs, watchlist) │ │
│  └──────────────┘   └──────────────┘   └──────────────────────────┘ │
│         │                  │                        │                │
│         ▼                  ▼                        ▼                │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │              D1 Database (whalesignal_db)                        │ │
│  │                                                                 │ │
│  │  whales        — detected whale transactions                    │ │
│  │  analysis      — AI analysis for each whale tx                  │ │
│  │  wallets       — labeled wallet addresses (exchange,   )       │ │
│  │  subscribers   — user subscription preferences                   │ │
│  │  watchlist     — user-tracked specific addresses                 │ │
│  │  digest        — weekly digest state                             │ │
│  │  stats_cache   — cached aggregate stats (24h, 7d)               │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │              KV Namespace (whalesignal_kv)                      │ │
│  │  market_cache  — { btc_price, eth_price, fear_greed, sp500 }   │ │
│  │  news_cache    — latest crypto headlines (TTL 1h)               │ │
│  │  rate_limit    — per-user rate limiting                         │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │           Queue (whalesignal_q) — free tier: 10K ops/day       │ │
│  │  scanner → analyst: "analyze this whale tx"                     │ │
│  │  analyst → bot: "send this alert to N subscribers"              │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Why three workers instead of one

A single worker can't do scanning + AI analysis + bot interaction within the 10ms CPU cap (free tier) or even the 30s CPU cap (paid). Splitting them:
- **scanner.js** — pure data fetching, cron-triggered, writes to D1, sends queue messages. No AI, no Telegram.
- **analyst.js** — queue-triggered, does the slow work: fetch market context + call Gemini API. Can take 3-5 seconds.
- **bot.js** — webhook-triggered by Telegram, handles user commands. Reads from D1 (fast), writes subscription data.

Queue is the decoupling layer. Scanner finds a whale → drops a message in the queue. Analyst picks it up → does analysis → writes to D1 → drops another queue message. Bot picks it up → sends DMs to relevant subscribers.

### D1 limits analysis (10K writes/day, 100K reads/day)

**Writes per day:**
- Whale txs detected: ~50-200/day across all chains (we set min $500K threshold)
- Each whale → 1 write (whales table) + 1 write (analysis table) = 2 writes
- 200 whales × 2 = 400 writes
- Subscriber DM tracking: 200 whales × ~50 paid subscribers = 10K messages, but we batch
  - Actually we update a "delivered" flag, not one write per message
  - Per whale: 1 write to mark analysis done + 1 write per subscriber batch (grouped) = ~3 writes
- 200 whales × 3 writes = 600 writes
- Bot interactions: ~5000 active users × 0.2 commands/day = 1000 commands × 2 writes each = 2000 writes
- Watchlist: ~500 watchlist entries × 0.1 changes/day = 50 writes
- **Total: ~3050 writes/day — well within 10K**

**Reads per day:**
- Bot commands: 1000 commands × 5 reads each = 5000 reads
- Analyst: 200 whales × 3 reads (wallet label, recent history, market cache) = 600 reads
- Stats/cache: ~200 reads/day for /stats and /top commands
- **Total: ~5800 reads/day — well within 100K**

### KV limits analysis (1K writes/day, 100K reads/day)

- Market cache refresh: every 5 min = 288 writes/day for price/fear-greed data (but we batch into 1 key updated every 5 min)
  - market_cache: 288 writes
  - news_cache: 24 writes (1 per hour, TTL)
  - **Total: 312 writes — within 1K**

- Reads: every whale alert reads market_cache + news_cache = 200 whales × 2 reads = 400 reads
- Bot /latest /top /stats reads cached data = ~1000 reads
- **Total: 1400 reads — way within 100K**

### Workers requests (100K/day)

- Scanner cron: every 30s = 2880 triggers/day, but each trigger makes 3-5 subrequests (blockchain APIs)
  - 2880 triggers × 1 request each = 2880 requests
- Analyst queue: 200 messages/day × 1 request + 2 subrequests each = 600 requests
- Bot webhook: 1000 commands/day = 1000 requests
- **Total: ~4480 requests/day — way within 100K**

---

## DATA SOURCES (all free, all real-time or near-real-time)

### 1. On-chain whale detection (the core)

We do NOT use Whale Alert API ($29.95/month). We scan blockchains directly.

**How we detect whales without Whale Alert:**

| Chain | Free API | Method | Rate Limit |
|-------|----------|--------|------------|
| BTC | blockchain.com/api | Monitor latest block → filter txs > $500K | No key, unlimited |
| ETH | etherscan.io/api (free key) | Get latest block → filter transfers > $500K | 3/sec, 100K/day |
| BSC | bscscan.com/api (free key) | Same as ETH | 3/sec, 100K/day |
| SOL | rpc.mainnet-beta.solana.com | getSignaturesForAddress on known whale wallets | Free RPC |
| TRX | tronscan.org/api | Monitor large TRC20 USDT transfers | Free, no key |

**The scanning strategy:**

Instead of scanning EVERY transaction (impossible at free tiers), we use a **watchlist + block scan hybrid**:

1. **Known whale wallets** (seed list of ~200 known whale addresses from public sources)
   - Poll each wallet every 30 seconds for new transactions
   - If a new tx > $500K: flag it as a whale move
   - This is ~200 API calls per scan cycle = 200 × 2 scans/min = 400/min
   - TOO MANY for free tiers

2. **Optimized approach: block-level scan**
   - BTC: Fetch latest block → iterate transactions → filter by value > $500K
     - 1 API call per block, ~10 min between blocks
     - Returns up to 200 txs per block
     - We filter in JS, not in the API
   - ETH: Use `eth_getBlockByNumber` → filter transactions where `value` > threshold
     - 1 RPC call, returns all txs in block
     - For ERC20 transfers (USDT, USDC): use `eth_getLogs` with Transfer event topic
   - SOL: `getSignaturesForAddress` for known exchange hot wallets
   - This is 3-5 API calls per scan cycle (one per chain), not 200

3. **The address labeling layer**
   - Maintain a D1 table of known addresses with labels:
     - Exchange deposit addresses ("Binance Hot Wallet", "Coinbase Cold Storage")
     - Known whale wallets (tracked over time, auto-labeled "Whale #1234")
     - Stablecoin contract addresses (USDT, USDC, DAI on each chain)
   - When a whale tx is detected, we check if the from/to address is labeled
   - This is where "exchange inflow = likely sell" comes from
   - Seed the table with ~500 known exchange addresses (publicly available)
   - Auto-discover: if we see a wallet send > $1M to an exchange 3+ times, label it "Frequent Exchange Depositor"

### 2. Market context (fetched once, cached in KV)

| Source | Data | Cache TTL | Rate Limit |
|--------|------|-----------|------------|
| CoinGecko free API | BTC/ETH/SOL prices, 24h change, volume | 5 min | 30 req/min |
| alternative.me/api/fng | Fear & Greed Index (0-100) | 1 hour | No key |
| Binance public API | Real-time last trade price for any crypto pair | 30 sec | 1200 req/min |
| Yahoo Finance (unofficial) | S&P 500 daily change, VIX, Gold, Oil | 15 min | No key |
| CoinGecko global | Total market cap, BTC dominance | 15 min | 30 req/min |

**KV caching strategy:**
```
market_cache (1 KV key, updated every 5 min by scanner):
{
  "btc": { "price": 67000, "change_24h": -2.3, "volume_24h": 28e9 },
  "eth": { "price": 3200, "change_24h": -1.8, "volume_24h": 15e9 },
  "sol": { "price": 145, "change_24h": 3.2, "volume_24h": 3e9 },
  "fear_greed": { "value": 28, "label": "Fear", "timestamp": "2026-07-14T10:00:00Z" },
  "sp500": { "change": -0.8, "timestamp": "2026-07-14T10:00:00Z" },
  "btc_dominance": 52.3,
  "total_market_cap": 2.3e12
}
```

This means every whale alert can reference current market context without making additional API calls. The scanner refreshes it every 5 minutes and stores it in KV. The analyst reads it from KV (1 read).

### 3. News context (the hard part)

| Source | Data | Price | Rate Limit |
|--------|------|-------|------------|
| NewsAPI.org (free) | Crypto headlines, 24h delay | $0 | 100 req/day |
| CryptoPanic API (free) | Crypto news headlines, near-real-time | $0 | Free with token |
| GDELT (free) | Global news events (war, oil, economy) | $0 | Unlimited |

**NewsAPI free tier has 24h delay** — not useful for real-time correlation.

**CryptoPanic** has a free API with auth token, ~30 req/min, returns real-time crypto news with sentiment scores. This is the one we use.

**GDELT** (Google's global news database) has a free API that returns global events in near-real-time. We can filter for economy/conflict categories and correlate with crypto market events. Example: "GDELT shows a spike in 'economic sanctions' mentions — and simultaneously BTC is pumping + whale accumulation detected."

**How news is used:**
- The analyst worker fetches CryptoPanic headlines (top 5, cached for 1 hour in KV)
- When generating AI analysis, the headlines are included as context
- The AI is prompted: "Given these recent crypto news headlines [headlines], this whale move [tx details], and current market data [prices/F&G], write a 2-3 sentence analysis"

### 4. AI analysis layer (Gemini free tier)

**Gemini 2.0 Flash free tier:**
- 15 requests/minute
- 1500 requests/day
- 1M tokens/minute
- No cost

**Behavior:**
- Scanner detects whale → analyst worker queued
- Analyst reads market_cache from KV (1 read)
- Analyst reads news_cache from KV (1 read)
- Analyst reads whale tx from D1 (1 read)
- Analyst constructs prompt and calls Gemini API
- Gemini returns structured JSON: { summary, interpretation, confidence, related_events }
- Analyst writes analysis to D1 (1 write)
- Analyst queues bot to send alerts

**The prompt (this is the product):**

```
You are a crypto whale movement analyst. A whale has made a transaction.

TRANSACTION:
- Blockchain: {chain}
- Amount: {amount} {symbol} (${usd_value})
- From: {from_address} ({from_label or "unknown"})
- To: {to_address} ({to_label or "unknown"})
- Transaction type: {exchange_inflow | exchange_outflow | wallet_to_wallet | stablecoin_mint | stablecoin_burn}

MARKET CONTEXT:
- BTC price: ${btc_price} ({btc_24h}%) | Fear & Greed: {fear_greed} ({fear_greed_label})
- ETH price: ${eth_price} ({eth_24h}%)
- BTC dominance: {dominance}%
- Total market cap: ${market_cap}

RECENT HEADLINES:
- {headline_1}
- {headline_2}
- {headline_3}

WALLET HISTORY (last 3 transactions from this address):
- {tx summaries}

Return JSON:
{
  "headline": "one-line summary of what this whale did",
  "interpretation": "2-3 sentences: what this likely means for the market, 
                      considering the context above",
  "signal": "bullish | bearish | neutral",
  "confidence": 0.0-1.0,
  "related_factor": "the single most relevant context factor 
                      (e.g. 'exchange inflow during market fear' or 
                      'accumulation at support level')"
}
```

**Why this is better than raw alerts:**
A raw bot says: "🐳 500 BTC ($33.5M) moved to Binance"

WhaleSignal says:
```
🐳 500 BTC ($33.5M) → Binance Hot Wallet
Confidence: HIGH (0.82)
Signal: 🐻 BEARISH

A whale just deposited $33.5M in Bitcoin to Binance — likely 
preparing to sell. This comes as BTC is already down 2.3% today 
with Fear & Greed at 28 (Fear). Large exchange inflows during 
fear periods have historically preceded further sell-offs.

Market: BTC $67,000 (-2.3%) | F&G: 28 (Fear) | Dominance: 52.3%
Headline: "SEC announces new crypto regulation review"
Related factor: Exchange inflow during market fear
```

---

## WALLET INTELLIGENCE LAYER

This is what separates WhaleSignal from every free whale bot. We don't just see a transaction — we understand the wallet's behavior over time.

### Wallet labeling system (D1 `wallets` table)

```
wallets table:
  address TEXT PRIMARY KEY
  chain TEXT
  label TEXT          -- "Binance Hot Wallet", "Whale #0042", "Unknown"
  type TEXT            -- "exchange", "whale", "institution", "unknown", "miner"
  first_seen INTEGER
  tx_count INTEGER    -- how many whale txs we've seen from this address
  total_volume REAL    -- total USD value of all whale txs
  last_tx_hash TEXT
  last_seen INTEGER
  pattern TEXT         -- "frequent_exchange_depositor", "accumulator", "dumper"
```

### Pattern detection (runs in analyst.js after each whale tx)

The analyst worker, after writing the AI analysis, runs pattern detection on the wallet:

```javascript
// Dumb rules engine — no AI needed, pure logic
function detectPattern(walletHistory, currentTx) {
  const last30d = walletHistory.filter(tx => tx.timestamp > Date.now() - 30*86400*1000);
  const exchangeOutflows = last30d.filter(tx => tx.to_is_exchange).length;
  const exchangeInflows = last30d.filter(tx => tx.from_is_exchange).length;

  if (exchangeOutflows >= 3 && currentTx.to_is_exchange)
    return { pattern: "frequent_exchange_depositor", signal: "bearish" };
  if (exchangeInflows >= 3)
    return { pattern: "accumulator", signal: "bullish" };
  if (currentTx.to_is_exchange && !currentTx.from_is_exchange)
    return { pattern: "potential_dumper", signal: "bearish" };
  return { pattern: "neutral", signal: "neutral" };
}
```

### "Stealth whale" detection

The user specifically wanted: "detect ones that don't want us to know they are buying."

This is actually possible at a basic level:
1. **Direct DEX routing** — a whale swaps through Uniswap/1inch directly, no exchange intermediary. We detect this by checking if the `to_address` is a known DEX router contract.
2. **Wallet splitting** — a whale distributes funds across multiple fresh wallets before transacting. We detect this by noticing a parent wallet splitting into N child wallets, each receiving similar amounts within a short window. Flag as "stealth accumulation pattern."
3. **Mixing/Tornado** — we can't see through Tornado Cash, but we CAN flag "funds emerged from Tornado and immediately bought into an asset" as suspicious accumulation.
4. **OTC desks** — large wallet-to-wallet transfers that don't touch exchanges. We flag these as "OTC settlement — off-market, no immediate price impact expected."

We don't claim to break privacy. We just flag behavioral patterns. The AI adds: "This whale split 1000 ETH across 5 new wallets this week, each wallet has no prior history — this pattern suggests stealth accumulation to avoid on-chain detection."

### Historical pattern matching

When a whale tx is detected:
1. Fetch the last 5 transactions from this wallet (1 D1 read)
2. Check what happened to the price 1h, 6h, 24h after each of those transactions
3. Build a mini-pattern: "Last 3 times this wallet deposited >$10M to Binance, BTC dropped 1-2% within 4 hours"
4. Include this in the AI prompt as context

This is the genuinely "smart" part — not trick AI, but historical correlation. It's factual: "last 3 times, price dropped." That's useful information, not a prediction.

---

## BOT COMMANDS & USER EXPERIENCE

### Free users

```
/start     → Welcome + inline subscribe button
/latest    → Last 5 whale alerts (30-min delayed)
/top       → Biggest 5 whale moves today
/stats     → 24h whale move stats (total volume, chains, direction)
/help      → Command list + upgrade to Pro button
```

Free users see alerts in the public channel with a 30-minute delay and a "🆓 30min delayed — get real-time with Pro" footer.

### Pro users ($4-8/month)

```
All free commands, plus:
/subscribe     → Choose chains, thresholds (inline keyboard)
/threshold     → Set minimum USD value for alerts
/chains        → Toggle chains on/off
/watch <addr>  → Add address to personal watchlist
/unwatch <addr>→ Remove from watchlist
/watchlist     → List watched addresses
/alerts        → Recent alerts for your settings
/history <addr>→ Transaction history for any address
```

Pro users get real-time DMs for every alert matching their filters (chains, min value, watchlist addresses). Every alert includes the full AI analysis + pattern context.

### VIP users ($15-40/month)

```
All Pro commands, plus:
/webhook <url>  → Set webhook to receive alerts as JSON
/digest         → Weekly digest report (auto-generated)
/pattern <addr> → Full behavioral pattern analysis for a wallet
/stealth        → Show recent stealth-accumulation detections
/export         → Export alert history as CSV
/priority       → Faster AI analysis (Gemini paid tier, higher rate limits)
/apikey         → Get a personal API key for programmatic access
VIP badge in all interactions
```

VIP is for traders who want to pipe whale data into their own systems or get the deepest analysis. The webhook sends the same structured JSON the bot uses internally.

---

## SCANNER DESIGN — How we scan chains for free

### Block-level polling (every 30 seconds)

```javascript
// scanner.js — runs every 30s via cron trigger
async function scanChain(chain) {
  const CHAIN_CONFIG = {
    btc: { api: "https://blockchain.info/latestblock", method: "btc" },
    eth: { api: "https://api.etherscan.io/api", method: "evm", key: ETH_KEY },
    bsc: { api: "https://api.bscscan.com/api", method: "evm", key: BSC_KEY },
  };

  // 1. Get last processed block from D1
  const lastBlock = await DB.prepare("SELECT value FROM scanner_state WHERE chain = ?")
    .bind(chain).first();

  // 2. Get latest block from blockchain
  const latest = await fetchLatestBlock(chain);

  // 3. For each new block, fetch and filter transactions
  for (let blockNum = lastBlock + 1; blockNum <= latest; blockNum++) {
    const txs = await fetchBlockTransactions(chain, blockNum);

    for (const tx of txs) {
      const usdValue = tx.amount * await getPrice(tx.symbol);

      if (usdValue >= MIN_WHALE_THRESHOLD) {
        // 4. Insert into D1
        await DB.prepare("INSERT INTO whales ...").bind(...);

        // 5. Queue for analysis
        await QUEUE.send(JSON.stringify({ whale_id: id, chain, tx }));
      }
    }
  }

  // 6. Update scanner state
  await DB.prepare("UPDATE scanner_state SET value = ? WHERE chain = ?")
    .bind(latest, chain);
}
```

**Per-scan API calls:**
- 1 call to get latest block height per chain (3 chains = 3 calls)
- 1 call per new block to get transactions (usually 1-2 new blocks per 30s per chain = ~6 calls)
- 1 call to refresh market cache (CoinGecko) — only every 5th scan (every 2.5 min)
- **Total per 30s cycle: ~10 API calls**
- **Per hour: 1200 API calls**
- **Per day: 28,800 API calls** — within Etherscan's 100K/day, within Binance's 1200/min

### Enhanced ERC20 detection (USDT, USDC transfers)

The biggest whale moves are often stablecoins, not native tokens. Etherscan's `tx` field only shows ETH transfers — ERC20 token transfers are in the `logs`.

For each new ETH block, we use `eth_getLogs` with the Transfer event topic:
```
topic0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
// Transfer(address,address,uint256)
```

This returns all ERC20 transfers in the block. We filter by:
- Known token contracts (USDT, USDC, DAI, WBTC, LINK)
- Transfer value > $500K

This is 1 extra RPC call per block, returns only Transfer events (efficient).

### The 30-second claim

"Information matters in milliseconds" — you're right, but we can't achieve milliseconds on free tier. Here's what we CAN achieve:

- **BTC blocks**: ~10 min average. Scanning every 30s means we catch new blocks within 30s of them being mined.
- **ETH blocks**: ~12s average. Scanning every 30s means we catch new blocks within 30s.
- **SOL blocks**: ~400ms. We can't scan SOL every 400ms on free tier. But we poll known SOL whale wallets every 30s and check for recent transactions.

Realistic latency from whale action → alert in user DM:
- BTC: 10 min (block time) + 30s (scan) + 3s (AI analysis) + 1s (Telegram) = ~14 min
- ETH: 12s (block time) + 30s (scan) + 3s (AI analysis) + 1s (Telegram) = ~46s
- SOL: 30s (poll) + 3s (AI) + 1s (Telegram) = ~34s

To get to true real-time (single-digit seconds), you'd need:
- WebSocket subscriptions to mempool (mempool.space API for BTC, Helius free tier for SOL)
- Paid Workers (removes 10ms CPU cap, allows long-lived connections)
- That's maybe $5/month in infrastructure — fine when you have 50 paying users

**Phase 1 ships with 30-second polling. Phase 2 adds mempool WebSocket for sub-second detection.**

---

## D1 SCHEMA

```sql
-- Whale transaction records
CREATE TABLE IF NOT EXISTS whales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount REAL NOT NULL,
  symbol TEXT NOT NULL,
  usd_value REAL NOT NULL,
  tx_type TEXT,             -- exchange_inflow, exchange_outflow, wallet_to_wallet, etc.
  block_number INTEGER,
  block_time INTEGER,
  detected_at INTEGER NOT NULL,
  analysis_status TEXT DEFAULT 'pending'  -- pending, done, failed
);

-- AI analysis results
CREATE TABLE IF NOT EXISTS analysis (
  whale_id INTEGER PRIMARY KEY,
  headline TEXT,
  interpretation TEXT,
  signal TEXT,              -- bullish, bearish, neutral
  confidence REAL,
  related_factor TEXT,
  pattern TEXT,
  pattern_signal TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (whale_id) REFERENCES whales(id)
);

-- Known/labeled wallet addresses
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT NOT NULL,
  chain TEXT NOT NULL,
  label TEXT,
  type TEXT,
  pattern TEXT,
  tx_count INTEGER DEFAULT 0,
  total_volume REAL DEFAULT 0,
  first_seen INTEGER,
  last_seen INTEGER,
  last_tx_hash TEXT,
  PRIMARY KEY (address, chain)
);

-- User subscriptions
CREATE TABLE IF NOT EXISTS subscribers (
  user_id INTEGER PRIMARY KEY,
  tier TEXT DEFAULT 'free',  -- free, pro, vip
  tier_expires INTEGER,
  chains TEXT,               -- JSON array of chain IDs
  min_usd REAL DEFAULT 500000,
  stealth_alerts INTEGER DEFAULT 0,
  preferred_lang TEXT,
  joined_at INTEGER NOT NULL
);

-- User watchlist
CREATE TABLE IF NOT EXISTS watchlist (
  user_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  chain TEXT NOT NULL,
  label TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, address, chain)
);

-- Scanner state (last processed block per chain)
CREATE TABLE IF NOT EXISTS scanner_state (
  chain TEXT PRIMARY KEY,
  last_block INTEGER,
  last_scan INTEGER,
  total_whales INTEGER DEFAULT 0
);

-- Alert delivery tracking
CREATE TABLE IF NOT EXISTS alerts_delivered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whale_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL,
  UNIQUE(whale_id, user_id)
);

-- Stats cache
CREATE TABLE IF NOT EXISTS stats_cache (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);

-- Indexes (for fast reads)
CREATE INDEX IF NOT EXISTS idx_whales_chain_time ON whales(chain, detected_at);
CREATE INDEX IF NOT EXISTS idx_whales_usd ON whales(usd_value DESC);
CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user_whale ON alerts_delivered(user_id, whale_id);
```

---

## DEVELOPMENT PHASES

### Phase 1: MVP (2-3 weeks) — "Better than raw alerts"

**Goal:** Public channel with AI-enhanced whale alerts. No subscriptions yet. Prove the concept.

Deliverables:
1. scanner.js — polls BTC + ETH blocks every 30s, detects whale txs > $500K
2. analyst.js — fetches market context from KV, calls Gemini for analysis, writes to D1
3. bot.js — posts formatted alerts to public Telegram channel
4. Config wizard (reuse cryptopay wizard pattern)

What an alert looks like in the channel:
```
🐳 WHALE ALERT — Ethereum
$12.5M USDT transferred to Binance

💰 12,500,000 USDT ($12.5M)
📍 eth → 0x28C6...d3c4 (Binance: Hot Wallet 14)
🕐 Confirmed in block 20,123,456

🧠 AI Analysis:
Likely sell preparation — $12.5M in USDT moved to Binance.
When stablecoins flow into exchanges, it often signals intent 
to sell into other assets or withdraw to fiat. BTC currently 
down 1.8%, market in "Fear" territory (F&G: 28).

📊 Market: BTC $67,000 | F&G: 28 | ETH $3,200
🔮 Signal: Bearish (confidence: 0.71)
📎 Pattern: Exchange inflow during market fear

🔍 View on Etherscan: https://etherscan.io/tx/0x...
```

This alone is 10x better than any free whale bot.

### Phase 2: User growth (2-3 weeks) — "Get people in"

Deliverables:
1. Bot commands: /start, /latest, /top, /stats, /help
2. User onboarding flow
3. Subscription system: free users get 30-min delayed alerts in channel, signup for Pro gets real-time DMs
4. Payment integration (Stripe Checkout links — simplest path for $5/mo subscriptions. People don't want to figure out crypto for a $5 sub.)
5. /subscribe with inline keyboard (choose chains, threshold)
6. Pro DMs: real-time alerts matching user filters

### Phase 3: Intelligence (2-3 weeks) — "Make it actually smart"

Deliverables:
1. Wallet labeling system (seed with ~500 exchange addresses)
2. Pattern detection (accumulator, dumper, frequent depositor)
3. Historical price correlation ("last 3 times this whale deposited, price dropped 2%")
4. Stealth whale detection (wallet splitting, DEX routing, Tornado emergence)
5. Watchlist feature (/watch <address>)
6. /pattern <address> command for VIP

### Phase 4: Expansion (2-3 weeks) — "More chains + more value"

Deliverables:
1. Add SOL, TRX, BSC scanning
2. News integration (CryptoPanic API + GDELT)
3. Weekly digest auto-generation
4. Webhook delivery for VIP
5. Inline queries (type @whalesignalbot in any chat)
6. Stats dashboard improvements (heatmaps, trends)

### Phase 5: Scale (ongoing) — "Grow to 20K"

Deliverables:
1. Mempool WebSocket for sub-second BTC/ETH detection (paid Cloudflare, ~$5/mo)
2. Solana Helius free tier for real-time SOL whale tracking
3. Paid Gemini tier for higher rate limits (when >200 whales/day)
4. SEO: whalesignal.com landing page
5. Twitter account auto-posting notable whale moves with chart screenshots
6. Referral program: invite 3 friends → 1 month Pro free

---

## LIMITS SUMMARY (what can break)

| Resource | Free Limit | Phase 1-2 Usage | Phase 3-4 Usage | Break Point |
|----------|------------|------------------|-----------------|-------------|
| D1 writes | 10K/day | ~600/day | ~3000/day | ~5000 users |
| D1 reads | 100K/day | ~1000/day | ~5800/day | ~25000 users |
| KV writes | 1K/day | ~312/day | ~312/day | Hard limit — KV only for market cache |
| KV reads | 100K/day | ~400/day | ~1400/day | OK forever |
| Worker requests | 100K/day | ~3500/day | ~4480/day | ~50K users |
| Gemini API | 1500/day | ~200/day | ~200/day | OK until we add per-user AI queries |
| Etherscan API | 100K/day | ~5000/day | ~5000/day | OK for ETH + BSC |
| CoinGecko API | 30/min | 1/5min | 1/5min | OK forever |
| Telegram rate | 30 msg/s | Low | ~50 users × 10 alerts | Need batching at scale |

**When to upgrade to paid Cloudflare ($5/mo):**
- 50+ paid users generating $200+/month → re-invest $5/mo in Workers paid
- This removes the 10ms CPU cap (allows longer AI calls)
- Increases D1 to 25M rows, 50M writes/day
- If you have 50 users paying $5, the $5 Cloudflare fee is 2% of revenue

**The KV 1K writes/day limit is the main constraint.**
We use KV ONLY for market_cache (refreshed every 5 min = 288 writes) + news_cache (refreshed hourly = 24 writes). Total: 312 writes. Leaves 688 for rate limiting and misc. If we need more, we could use the D1 stats_cache table instead and let KV only hold categories that truly need global read lateness.

---

## WHAT THIS IS NOT

- It's not a trading bot. It doesn't execute trades. It gives you intelligence.
- It's not DeFi analytics. It doesn't track DEX pools, impermanent loss, or yield.
- It's not Nansen. It doesn't have 100M labeled addresses or institutional data feeds.
- It's not a quant model. The AI doesn't predict prices. It interprets behavior.
- It's not multi-million dollar. It's a $50-200/month side hustle that costs $0 to run.

It's a Telegram bot that tells you what whales are doing and what it probably means — in seconds, with context, in plain language. That's worth $5/month to the right people.

---

## COSTS

| Resource | Free Tier | When to Upgrade |
|----------|-----------|------------------|
| Cloudflare Workers | $0 (free) | $5/mo when 50+ paid users |
| Cloudflare D1 | $0 (free) | included in $5/mo |
| Cloudflare KV | $0 (free) | included in $5/mo |
| Cloudflare Queues | $0 (free, 10K ops/day) | included in $5/mo |
| Etherscan API (5 chains) | $0 (free keys) | $150/mo Pro if >100K calls |
| Binance API | $0 | Never — free |
| CoinGecko API | $0 (30/min) | $129/mo if >30/min needed |
| CryptoPanic API | $0 (free token) | €29/mo for more features |
| GDELT | $0 | Never — Google free |
| Alternative.me F&G | $0 | Never |
| Gemini API (AI) | $0 (1500/day) | Paid tier when >1500 analyses/day |
| Telegram Bot API | $0 | Never |
| Domain (optional) | $10/year | Optional |

**Total operating cost: $0/month at launch, $5/month after 50 paid users.**
Revenue at 50 paid users × $5 = $250/month. Profit: $245/month. That's way more than the $30 target.

---

## FILE STRUCTURE (planned)

```
whalesignal/
  PLAN.md               — this file
  README.md
  .gitignore
  config.example.json   — chain configs, API keys, bot token
  wizard.py             — interactive setup
  generate.py           — stamp workers from config + templates
  deploy_all.py         — wrangler deploy + D1 + queue setup
  schema/
    whalesignal.sql     — D1 schema (all tables above)
  templates/
    scanner.js          — cron-triggered chain scanner, writes to D1+KV, queues to analyst
    analyst.js          — queue-triggered AI analysis worker
    bot.js              — Telegram webhook handler, user commands, alert delivery
  wallet_labels/
    exchanges.json      — seed data: known exchange addresses per chain
    seed.py             — populates D1 wallets table from exchanges.json
```

---

## NEXT STEPS

1. Create whalesignal/ directory and git init
2. Write schema/whalesignal.sql
3. Build scanner.js (BTC + ETH scanning, market cache)
4. Build analyst.js (Gemini AI integration)
5. Build bot.js (public channel posting)
6. Test end-to-end with real data
7. Create public Telegram channel, start posting
8. Build wizard.py + generate.py + deploy_all.py (reuse cryptopay patterns)

**That's Phase 1. Get alerts flowing to a public channel. Everything else builds on that.**
