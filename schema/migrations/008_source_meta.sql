-- 008_source_meta.sql
-- Adaptive news polling: per-source state for ETags, poll intervals, and
-- failure backoff. One batched write per tick (D1 writes are cheap; KV
-- writes are budgeted at 1k/day on the free tier).

CREATE TABLE IF NOT EXISTS source_meta (
  name          TEXT PRIMARY KEY,
  last_fetch    INTEGER,              -- epoch ms of last attempt
  last_ok       INTEGER,              -- epoch ms of last successful fetch
  etag          TEXT,
  last_modified TEXT,
  failures      INTEGER DEFAULT 0,    -- consecutive failures
  interval_min  INTEGER DEFAULT 5,    -- adaptive poll interval
  items_seen    INTEGER DEFAULT 0     -- items fetched last success (for tuning)
);
