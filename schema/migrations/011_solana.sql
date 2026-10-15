-- 011_solana.sql
-- Solana wallet-watch: curated high-signal wallets, not global scanning.
-- Solana does 400ms blocks (~216k/day) — block scanning is infeasible.
-- Instead we poll getSignaturesForAddress on known wallets (exchanges,
-- treasuries, whales) and parse new transactions for large SOL/USDC moves.

CREATE TABLE IF NOT EXISTS sol_wallets (
  address      TEXT PRIMARY KEY,
  label        TEXT,                       -- "Binance Hot", "Unknown Whale #3"
  type         TEXT DEFAULT 'unknown',     -- exchange | defi | whale | unknown
  added_at     INTEGER NOT NULL,
  last_sig     TEXT,                       -- last processed signature (watermark)
  last_check   INTEGER,                    -- last poll timestamp
  active       INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sol_wallets_active ON sol_wallets(active, last_check);
