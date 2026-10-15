-- 012_treasuries.sql
-- Stablecoin mint radar: treasury wallets that signal new supply.
-- When these send large USDT/USDC, it's a MINT event (new buying power).

INSERT OR IGNORE INTO wallets (address, label, type) VALUES
  -- Tether Treasury (ETH) — verified via Etherscan
  ('0xc6cde7c39eb2f0f0095f41570af89efc2c1ea828', 'Tether Treasury', 'treasury'),
  -- Tether Treasury (TRON) — verified via TronGrid, received 2B USDT mint
  ('TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs', 'Tether Treasury', 'treasury');
