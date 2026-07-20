"""trading_loop/risk_manager.py — safety guards before HL testnet order.

Borrowed from sanketagarwal/hyperliquid-trading-agent src/risk_manager.py.
Pure functions, no LLM. The LLM says "COPY with size_pct=80" — these guards
clamp it down before the signed message leaves the process.

6 guards:
  1. Max position size: <= 10% of starting balance per trade
  2. Daily circuit breaker: if daily PnL <= -10% of starting, stop new trades
  3. Max concurrent positions: <= 10
  4. Balance reserve: don't trade below 20% of starting
  5. Max leverage: 10x
  6. Mandatory SL: if LLM doesn't specify, default 5%
"""

import sqlite3
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RiskState:
    starting_balance: float
    current_balance: float
    daily_pnl: float = 0.0          # sum of pnl_usd for trades closed today
    open_position_count: int = 0
    open_exposure: float = 0.0      # sum of size_usd across open trades


@dataclass
class Decision:
    side: str                       # "long" or "short"
    size_pct: float                 # 0-100, LLM's request
    tp_pct: float                   # take profit %
    sl_pct: Optional[float]         # stop loss % (None = not set)
    leverage: int = 1
    confidence: float = 0.0


@dataclass
class CheckResult:
    ok: bool
    reason: str = ""
    adjusted: dict = field(default_factory=dict)


MAX_POS_PCT = 10.0      # 10% of starting balance per trade
MAX_LEVERAGE = 10
MAX_OPEN_POSITIONS = 10
DAILY_LOSS_LIMIT_PCT = 10.0   # -10% of starting → circuit breaker
MIN_BALANCE_PCT = 20.0       # don't trade below 20% of starting
DEFAULT_SL_PCT = 5.0         # mandatory SL if LLM forgot


def check(decision: Decision, state: RiskState) -> CheckResult:
    """Validate an LLM COPY decision against guards. Returns adjusted or rejected."""

    # Guard 4: balance reserve
    if state.current_balance < state.starting_balance * (MIN_BALANCE_PCT / 100):
        return CheckResult(False, "balance below 20% reserve — stopping new trades")

    # Guard 2: daily circuit breaker
    if state.daily_pnl <= -(state.starting_balance * (DAILY_LOSS_LIMIT_PCT / 100)):
        return CheckResult(False, "daily circuit breaker tripped — down >10% today")

    # Guard 3: max concurrent positions
    if state.open_position_count >= MAX_OPEN_POSITIONS:
        return CheckResult(False, f"max {MAX_OPEN_POSITIONS} concurrent positions reached")

    # Guard 1: position size — clamp to 10%
    max_size_usd = state.starting_balance * (MAX_POS_PCT / 100)
    requested_size = state.starting_balance * (decision.size_pct / 100)
    if requested_size > max_size_usd:
        decision.size_pct = MAX_POS_PCT
        requested_size = max_size_usd

    # Guard 5: leverage cap
    if decision.leverage > MAX_LEVERAGE:
        decision.leverage = MAX_LEVERAGE

    # Guard 6: mandatory SL
    if decision.sl_pct is None or decision.sl_pct <= 0:
        decision.sl_pct = DEFAULT_SL_PCT

    return CheckResult(True, adjusted={
        "size_pct": decision.size_pct,
        "leverage": decision.leverage,
        "sl_pct": decision.sl_pct,
        "size_usd": requested_size,
    })


def compute_daily_pnl(db: sqlite3.Connection, starting_balance: float, now_ms: int) -> float:
    """Sum pnl_usd for trades CLOSED today (last 24h)."""
    cutoff = now_ms - 86400000
    row = db.execute(
        "SELECT COALESCE(SUM(pnl_usd), 0) as total FROM paper_trades "
        "WHERE closed_at IS NOT NULL AND closed_at >= ?",
        (cutoff,),
    ).fetchone()
    return row["total"] if row else 0.0


def compute_open_exposure(db: sqlite3.Connection) -> tuple[float, int]:
    """Return (total_exposure_usd, count) of open trades."""
    row = db.execute(
        "SELECT COALESCE(SUM(size_usd), 0) as total, COUNT(*) as cnt "
        "FROM paper_trades WHERE closed_at IS NULL"
    ).fetchone()
    if row:
        return row["total"], row["cnt"]
    return 0.0, 0
