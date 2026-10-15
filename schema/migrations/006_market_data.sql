-- 006_market_data.sql
-- Full market-intelligence backing: dedicated price history, detected market
-- events, sentiment snapshots, and richer news metadata (topics + dedupe).

-- OHLCV candles (1h timeframe; 7-day rolling window maintained by price worker)
CREATE TABLE IF NOT EXISTS prices (
  symbol    TEXT NOT NULL,
  timeframe TEXT NOT NULL,              -- '1h'
  t         INTEGER NOT NULL,           -- candle open, epoch ms
  o REAL, h REAL, l REAL, c REAL, v REAL,
  PRIMARY KEY (symbol, timeframe, t)
);

-- Market events detected by the price worker (pumps, RSI extremes, BB breaks…)
CREATE TABLE IF NOT EXISTS market_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  type        TEXT NOT NULL,            -- pump | dump | rsi_extreme | bb_break | volume_spike
  detected_at INTEGER NOT NULL,
  details     TEXT,                     -- JSON blob
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_symbol_time ON market_events(symbol, detected_at DESC);

-- Periodic sentiment snapshots (fear/greed + funding + news composite)
CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  t              INTEGER PRIMARY KEY,  -- epoch ms
  fear_greed     INTEGER,
  fear_greed_label TEXT,
  funding_btc    REAL,
  funding_eth    REAL,
  news_sentiment REAL,                 -- avg D1 news sentiment, 24h
  composite      REAL,                 -- -1..1
  label          TEXT                   -- extreme_fear..extreme_greed
);

-- News: topic tags + dedupe cluster id
ALTER TABLE news ADD COLUMN topics TEXT;      -- padded ',etf,regulation,'
ALTER TABLE news ADD COLUMN cluster_id TEXT;  -- normalized-title hash
CREATE INDEX IF NOT EXISTS idx_news_cluster ON news(cluster_id);
