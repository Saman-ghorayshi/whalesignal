-- 010_perf_indexes.sql
-- Missing indexes were causing full table scans on every whale insert
-- (recentWhalesFromWallet) and every analysis (getWalletHistory).
-- D1 counts rows READ, not rows returned — unindexed WHERE clauses
-- burn through the 5M/day free tier fast.

CREATE INDEX IF NOT EXISTS idx_whales_from ON whales(from_address, chain);
CREATE INDEX IF NOT EXISTS idx_whales_to ON whales(to_address, chain);
CREATE INDEX IF NOT EXISTS idx_news_url ON news(url);
CREATE INDEX IF NOT EXISTS idx_prices_sym_time ON prices(symbol, timeframe, t DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_detected ON predictions(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_created ON news(created_at DESC);
