-- Migration 001 — whales: composite uniqueness + new columns
--
-- WHEN: run ONCE, in order, AFTER schema/whalesignal.sql, on databases
-- created from the PRE-fix schema (commit e47383f and earlier).
-- Fresh databases should use the updated schema/whalesignal.sql directly
-- (its CREATE TABLE already has this shape) and SKIP this file.
--
-- WHAT:
--   1. UNIQUE(tx_hash)  →  UNIQUE(chain, tx_hash, symbol)
--      One Ethereum tx can move native ETH *and* ERC20s; each deserves its
--      own whale row. The old constraint silently discarded the ERC20 leg.
--   2. ADD is_self_transfer INTEGER NOT NULL DEFAULT 0
--   3. ADD contract_address TEXT
--
-- ASSUMES the old table already has the Sprint 1/3 columns
-- (interesting_score, price_at_detect) — i.e. the old schema file was
-- applied through the deploy wrapper. The deploy wrapper must guard
-- re-runs (e.g. skip when PRAGMA table_info(whales) already contains
-- is_self_transfer); this file is NOT safely re-runnable raw.
--
-- Old rows are unique by tx_hash alone, so they satisfy the new composite
-- key by construction — the copy cannot violate it.

PRAGMA foreign_keys=off;

ALTER TABLE whales RENAME TO whales_legacy;

CREATE TABLE whales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chain         TEXT    NOT NULL,
  tx_hash       TEXT    NOT NULL,
  from_address  TEXT    NOT NULL,
  to_address    TEXT    NOT NULL,
  amount        REAL    NOT NULL,
  symbol        TEXT    NOT NULL,
  usd_value     REAL    NOT NULL,
  tx_type       TEXT,
  block_number  INTEGER,
  block_time    INTEGER,
  detected_at   INTEGER NOT NULL,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  interesting_score INTEGER NOT NULL DEFAULT 0,
  price_at_detect REAL,
  is_self_transfer INTEGER NOT NULL DEFAULT 0,
  contract_address TEXT,
  UNIQUE (chain, tx_hash, symbol)
);

INSERT INTO whales
  (id, chain, tx_hash, from_address, to_address, amount, symbol, usd_value,
   tx_type, block_number, block_time, detected_at, analysis_status,
   interesting_score, price_at_detect, is_self_transfer, contract_address)
SELECT
  id, chain, tx_hash, from_address, to_address, amount, symbol, usd_value,
  tx_type, block_number, block_time, detected_at, analysis_status,
  interesting_score, price_at_detect, 0, NULL
FROM whales_legacy;

DROP TABLE whales_legacy;

CREATE INDEX IF NOT EXISTS idx_whales_chain_time  ON whales(chain, detected_at);
CREATE INDEX IF NOT EXISTS idx_whales_usd         ON whales(usd_value DESC);
CREATE INDEX IF NOT EXISTS idx_whales_status      ON whales(analysis_status) WHERE analysis_status != 'done';
CREATE INDEX IF NOT EXISTS idx_whales_score       ON whales(interesting_score DESC);

PRAGMA foreign_keys=on;
