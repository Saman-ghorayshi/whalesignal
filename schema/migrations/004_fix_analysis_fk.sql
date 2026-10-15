-- 004_fix_analysis_fk.sql
-- The live D1's analysis table was created with
--   FOREIGN KEY (whale_id) REFERENCES "whales_legacy"(id)
-- but the whales table is named `whales` (whales_legacy was only a transient
-- name inside migration 001 and was dropped). SQLite allows creating an FK
-- against a nonexistent table, but D1 enforces FKs on INSERT, so every new
-- analysis fails with "no such table: main.whales_legacy". SQLite cannot
-- ALTER a foreign key, so recreate the table with the correct reference.
-- (schema/whalesignal.sql already documents the correct REFERENCES whales(id).)

CREATE TABLE analysis_new (
  whale_id        INTEGER PRIMARY KEY,
  headline        TEXT,
  interpretation  TEXT,
  signal          TEXT,
  confidence      REAL,
  related_factor  TEXT,
  created_at      INTEGER NOT NULL,
  prediction_outcome TEXT,
  price_at_eval REAL,
  evaluated_at INTEGER,
  ai_provider TEXT,
  ai_model TEXT,
  FOREIGN KEY (whale_id) REFERENCES whales(id) ON DELETE CASCADE
);

INSERT INTO analysis_new
  (whale_id, headline, interpretation, signal, confidence, related_factor,
   created_at, prediction_outcome, price_at_eval, evaluated_at, ai_provider, ai_model)
SELECT
  whale_id, headline, interpretation, signal, confidence, related_factor,
  created_at, prediction_outcome, price_at_eval, evaluated_at, ai_provider, ai_model
FROM analysis;

DROP TABLE analysis;
ALTER TABLE analysis_new RENAME TO analysis;
