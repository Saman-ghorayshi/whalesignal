-- 005_news_predictions.sql
-- Whale intelligence layer: news gathering + prediction tracking.
-- 1. news: aggregated crypto headlines for catalyst matching.
--    symbols stored padded (',BTC,ETH,') so D1 can LIKE '%,BTC,%'.
-- 2. predictions: every AI call recorded with price_at_detect so a later
--    evaluator can score +24h outcomes and calibrate the motive engine.
-- 3. analysis: new columns for the intelligence fields the analyst now emits.

CREATE TABLE IF NOT EXISTS news (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  source       TEXT NOT NULL,
  published_at INTEGER,          -- epoch ms (null when the feed omits it)
  symbols      TEXT NOT NULL DEFAULT ',',  -- padded symbol list
  sentiment    REAL NOT NULL DEFAULT 0,     -- -1 (bearish) .. +1 (bullish)
  importance   REAL NOT NULL DEFAULT 0,     -- 0..1 ranking score
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_importance ON news(importance DESC);

CREATE TABLE IF NOT EXISTS predictions (
  whale_id        INTEGER PRIMARY KEY REFERENCES whales(id) ON DELETE CASCADE,
  signal          TEXT NOT NULL,             -- bullish | bearish | neutral
  confidence      REAL NOT NULL,
  motive          TEXT,                      -- classifier / LLM motive label
  price_at_detect REAL,
  detected_at     INTEGER NOT NULL,
  -- filled by the evaluator (24h horizon)
  horizon_24h_price  REAL,
  horizon_24h_return REAL,
  outcome          TEXT,                     -- hit | miss | flat
  evaluated_at     INTEGER
);

-- Intelligence fields on the analysis row (nullable: old rows stay valid).
ALTER TABLE analysis ADD COLUMN motive TEXT;
ALTER TABLE analysis ADD COLUMN motive_confidence REAL;
ALTER TABLE analysis ADD COLUMN catalyst_title TEXT;
ALTER TABLE analysis ADD COLUMN catalyst_url TEXT;
ALTER TABLE analysis ADD COLUMN ta_summary TEXT;
