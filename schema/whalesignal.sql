-- WhaleSignal D1 schema — Phase 1 (MVP)
--
-- Scope: enough to run scanner → analyst → bot for BTC + ETH and post
-- AI-enhanced alerts to a public Telegram channel. Phase 3+ tables
-- (price_history, watchlist, subscribers, alerts_delivered, stats_cache)
-- are intentionally OMITTED here so we don't ship empty tables pretending
-- to be features. They get added in their own phase.
--
-- Idempotent: safe to run on every deploy.

-- ─────────────────────────────────────────────────────────────────────
-- whales — detected whale transactions
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chain         TEXT    NOT NULL,                  -- 'btc' | 'eth'
  tx_hash       TEXT    NOT NULL,
  from_address  TEXT    NOT NULL,
  to_address    TEXT    NOT NULL,
  amount        REAL    NOT NULL,                  -- raw token amount
  symbol        TEXT    NOT NULL,                  -- 'BTC' | 'ETH' | 'USDT' ...
  usd_value     REAL    NOT NULL,                  -- amount * price at detect time
  tx_type       TEXT,                              -- exchange_inflow | exchange_outflow | wallet_to_wallet | exchange_internal | unknown
  block_number  INTEGER,
  block_time    INTEGER,                           -- on-chain block timestamp (epoch ms)
  detected_at   INTEGER NOT NULL,                  -- our detect time (epoch ms)
  analysis_status TEXT NOT NULL DEFAULT 'pending', -- pending | analyzed | done | failed | skipped
  interesting_score INTEGER NOT NULL DEFAULT 0,    -- 0-100 rule-based score (gates AI)
  price_at_detect REAL,                            -- price snapshot for AI accuracy eval
  is_self_transfer INTEGER NOT NULL DEFAULT 0,     -- 1 = consolidation/self-move (all change or from==to)
  contract_address TEXT,                           -- ERC20 contract for token transfers, else NULL
  alert_queued_at INTEGER,                         -- analyst claim flag for at-least-once BOTQ send
  -- One tx can move native ETH *and* ERC20s: each is its own whale row.
  UNIQUE (chain, tx_hash, symbol)
);

-- ─────────────────────────────────────────────────────────────────────
-- analysis — AI interpretation per whale tx (1:1 to whales)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis (
  whale_id        INTEGER PRIMARY KEY,
  headline        TEXT,
  interpretation  TEXT,
  signal          TEXT,                            -- bullish | bearish | neutral
  confidence      REAL,                            -- 0.0 - 1.0
  related_factor  TEXT,
  created_at      INTEGER NOT NULL,
  ai_provider     TEXT,                            -- which engine produced this analysis
  ai_model        TEXT,                            -- which model produced this analysis
  FOREIGN KEY (whale_id) REFERENCES whales(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────
-- wallets — labeled/known addresses (seeded from wallet_labels/exchanges.json)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  address      TEXT    NOT NULL,
  chain        TEXT    NOT NULL,
  label        TEXT,                               -- "Binance Hot Wallet 14"
  type         TEXT,                               -- exchange | whale | institution | unknown | miner
  pattern      TEXT,                               -- frequent_exchange_depositor | accumulator | ... (Phase 3)
  tx_count     INTEGER NOT NULL DEFAULT 0,
  total_volume REAL    NOT NULL DEFAULT 0,
  first_seen   INTEGER,
  last_seen    INTEGER,
  last_tx_hash TEXT,
  PRIMARY KEY (address, chain)
);

-- ─────────────────────────────────────────────────────────────────────
-- scanner_state — last-processed block per chain + run-counters
-- Single row per chain. Updated ONLY after a batch finishes successfully
-- so a crashed scan doesn't mark blocks as processed that it never saw.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scanner_state (
  chain         TEXT PRIMARY KEY,
  last_block    INTEGER,                           -- last block fully processed
  last_scan     INTEGER,                           -- epoch ms of last successful scan
  total_whales  INTEGER NOT NULL DEFAULT 0,        -- lifetime count
  errors        INTEGER NOT NULL DEFAULT 0,        -- consecutive error count (for alerting later)
  tx_offset     INTEGER NOT NULL DEFAULT 0        -- BTC pagination resume point into (last_block+1)
);

-- ─────────────────────────────────────────────────────────────────────
-- delivered — per-channel/per-chat delivery tracking (dedupes reposts)
-- Phase 1 only tracks the public channel. Phase 2 expands to per-user.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivered (
  whale_id    INTEGER NOT NULL,
  chat_id     TEXT   NOT NULL,                     -- telegram chat id as string (channels are negative)
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (whale_id, chat_id)
);

-- ─────────────────────────────────────────────────────────────────────
-- Additive ALTERs for columns NOT folded into the CREATE TABLEs above.
-- ─────────────────────────────────────────────────────────────────────
-- SQLite ALTER TABLE ADD COLUMN ignores a missing IF NOT EXISTS,
-- and D1 doesn't support it either. We guard with a pragma check in
-- deploy_all.py instead. The statements below are idempotent *only* when
-- run through the wrapper. If you run this file raw in a sqlite shell
-- after already adding the columns, you get "duplicate column name" —
-- which is harmless noise, not data loss.
--
-- (whales.interesting_score and whales.price_at_detect used to live here;
-- they are now in the CREATE TABLE above. Databases created from the old
-- schema must run schema/migrations/001_whales_composite_unique.sql.)
ALTER TABLE wallets ADD COLUMN reputation TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- Sprint 3 additions — AI accuracy evaluation columns.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE analysis ADD COLUMN prediction_outcome TEXT;
ALTER TABLE analysis ADD COLUMN price_at_eval REAL;
ALTER TABLE analysis ADD COLUMN evaluated_at INTEGER;

-- ─────────────────────────────────────────────────────────────────────
-- Indexes — reads dominate the budget (100K/day), so these matter.
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_whales_chain_time  ON whales(chain, detected_at);
CREATE INDEX IF NOT EXISTS idx_whales_usd         ON whales(usd_value DESC);
CREATE INDEX IF NOT EXISTS idx_whales_status      ON whales(analysis_status) WHERE analysis_status != 'done';
CREATE INDEX IF NOT EXISTS idx_whales_score       ON whales(interesting_score DESC);
CREATE INDEX IF NOT EXISTS idx_wallets_address    ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_analysis_whale     ON analysis(whale_id);

-- ─────────────────────────────────────────────────────────────────────
-- seed scanner_state rows so the scanner has a starting point.
-- INSERT OR IGNORE so re-running won't overwrite last_block mid-operation.
-- ─────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO scanner_state (chain, last_block, last_scan, total_whales, errors)
VALUES ('btc', NULL, 0, 0, 0);
INSERT OR IGNORE INTO scanner_state (chain, last_block, last_scan, total_whales, errors)
VALUES ('eth', NULL, 0, 0, 0);
