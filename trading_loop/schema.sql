-- trading_loop/schema.sql
-- 5 tables. No migration framework — run CREATE IF NOT EXISTS on boot.

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  whale TEXT, chain TEXT, signal TEXT, from_label TEXT, to_label TEXT,
  usd_value REAL, detected_at INTEGER, raw_json TEXT,
  processed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY,
  signal_id INTEGER, whale TEXT, side TEXT, size_usd REAL, entry_price REAL,
  coin TEXT, leverage INTEGER,
  opened_at INTEGER, closed_at INTEGER, exit_price REAL, pnl_usd REAL,
  close_reason TEXT,
  bear_case TEXT,
  bullish_case TEXT,
  llm_confidence REAL,
  hl_order_id TEXT
);

CREATE TABLE IF NOT EXISTS whale_scores (
  whale TEXT PRIMARY KEY,
  trade_count INTEGER DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  total_pnl_usd REAL DEFAULT 0,
  score REAL DEFAULT 0.5,
  last_updated INTEGER
);

CREATE TABLE IF NOT EXISTS beliefs (
  id INTEGER PRIMARY KEY,
  scope TEXT,
  target TEXT,
  belief TEXT,
  created_at INTEGER,
  source TEXT
);

CREATE TABLE IF NOT EXISTS weekly_review (
  week_id INTEGER PRIMARY KEY,
  review_text TEXT,
  score_deltas TEXT,
  belief_changes TEXT,
  created_at INTEGER
);
