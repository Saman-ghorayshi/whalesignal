-- 001: per-trade TP/SL + signal skip reasons
-- Applied on boot by apply_migrations() (trading_loop/memory.py).
-- Re-runs are safe: duplicate-column errors are ignored.

ALTER TABLE paper_trades ADD COLUMN tp_pct REAL;
ALTER TABLE paper_trades ADD COLUMN sl_pct REAL;
ALTER TABLE signals ADD COLUMN skip_reason TEXT;
