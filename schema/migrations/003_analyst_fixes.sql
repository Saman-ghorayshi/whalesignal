-- WhaleSignal migration 003 — analyst P0 fixes (2026-10-15)
--
-- Additive ALTERs only; safe to run on every deploy (D1 ignores duplicate
-- columns only via the pragma guard in deploy_all.py — see schema header).
--
-- 1. whales.alert_queued_at — claim flag for the at-least-once alert queue
--    (analyst D1/D4 fix). Set when the analyst claims the right to BOTQ.send;
--    cleared if the send throws. A redelivery that sees a fresh claim skips
--    the re-send instead of double-queueing; a stale claim (>10 min, still
--    'analyzed') may be re-claimed.
ALTER TABLE whales ADD COLUMN alert_queued_at INTEGER;
--
-- 2. analysis.ai_provider / ai_model — provenance for every AI analysis
--    (analyst A5 fix). Lets us audit which engine/model produced what and
--    debug provider-specific slop.
ALTER TABLE analysis ADD COLUMN ai_provider TEXT;
ALTER TABLE analysis ADD COLUMN ai_model TEXT;
