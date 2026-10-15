-- Migration 002 — scanner_state.tx_offset (BTC pagination resume point)
--
-- WHEN: run ONCE, in order, AFTER schema/whalesignal.sql (and after 001),
-- on databases created from the PRE-fix schema. Fresh databases should use
-- the updated schema/whalesignal.sql directly and SKIP this file.
--
-- WHAT: ADD tx_offset INTEGER NOT NULL DEFAULT 0
-- The scanner paginates BTC blocks past blockstream's 25-tx page size. A
-- block whose tx set doesn't fit in one tick's subrequest budget is resumed
-- next tick from tx_offset instead of restarting at page 0.
--
-- The deploy wrapper must guard re-runs (e.g. skip when
-- PRAGMA table_info(scanner_state) already contains tx_offset); this
-- statement is NOT safely re-runnable raw (duplicate column name).

ALTER TABLE scanner_state ADD COLUMN tx_offset INTEGER NOT NULL DEFAULT 0;
