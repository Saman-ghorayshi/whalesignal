-- 009_eval_horizons.sql
-- Multi-horizon prediction scoring: 1h / 6h / 24h outcomes per call.
-- The evaluator worker fills these; the leaderboard reads them.

ALTER TABLE predictions ADD COLUMN horizon_1h_price  REAL;
ALTER TABLE predictions ADD COLUMN horizon_1h_return REAL;
ALTER TABLE predictions ADD COLUMN outcome_1h  TEXT;      -- hit | miss | flat
ALTER TABLE predictions ADD COLUMN horizon_6h_price  REAL;
ALTER TABLE predictions ADD COLUMN horizon_6h_return REAL;
ALTER TABLE predictions ADD COLUMN outcome_6h  TEXT;
