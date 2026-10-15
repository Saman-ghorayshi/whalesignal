-- 007_causal.sql
-- Causal-chain support: store the evidence chain (news → sentiment → whale →
-- market) computed at analysis time so the bot can render it and later jobs
-- can extend it with what happened next.

ALTER TABLE analysis ADD COLUMN causal_chain TEXT;   -- JSON array of chain links
ALTER TABLE analysis ADD COLUMN regime TEXT;         -- market regime label at detect time
