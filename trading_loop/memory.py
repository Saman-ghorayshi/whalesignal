"""trading_loop/memory.py — FinMem L2/L3 read helpers.

Pure read-only SQLite queries. No LLM, no side effects.
The agent reads BOTH layers before each trade decision (FinMem pattern).
"""

import sqlite3
from typing import Optional


def recent_trades_for_whale(db: sqlite3.Connection, whale: str, limit: int = 5):
    """FinMem Layer 2: last N trades for THIS whale."""
    rows = db.execute(
        "SELECT * FROM paper_trades WHERE whale = ? ORDER BY opened_at DESC LIMIT ?",
        (whale, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def whale_beliefs(db: sqlite3.Connection, whale: str):
    """FinMem Layer 3: per-whale NL beliefs (append-only log, read ALL)."""
    rows = db.execute(
        "SELECT belief FROM beliefs WHERE scope = 'whale' AND target = ? ORDER BY created_at",
        (whale,),
    ).fetchall()
    return [r["belief"] for r in rows]


def global_beliefs(db: sqlite3.Connection):
    """FinMem Layer 3: global regime beliefs."""
    rows = db.execute(
        "SELECT belief FROM beliefs WHERE scope = 'global' ORDER BY created_at"
    ).fetchall()
    return [r["belief"] for r in rows]


def whale_score(db: sqlite3.Connection, whale: str) -> Optional[float]:
    row = db.execute(
        "SELECT score FROM whale_scores WHERE whale = ?", (whale,)
    ).fetchone()
    return row["score"] if row else None


def new_signals(db: sqlite3.Connection, limit: int = 100):
    """Fetch unprocessed signals (processed=0)."""
    rows = db.execute(
        "SELECT * FROM signals WHERE processed = 0 ORDER BY detected_at LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def mark_processed(db: sqlite3.Connection, signal_id: int):
    db.execute("UPDATE signals SET processed = 1 WHERE id = ?", (signal_id,))


def record_trade(db: sqlite3.Connection, trade: dict):
    cols = ", ".join(trade.keys())
    placeholders = ", ".join(["?"] * len(trade))
    db.execute(
        f"INSERT INTO paper_trades ({cols}) VALUES ({placeholders})",
        tuple(trade.values()),
    )


def open_trades(db: sqlite3.Connection):
    """All trades not yet closed (closed_at IS NULL)."""
    rows = db.execute(
        "SELECT * FROM paper_trades WHERE closed_at IS NULL ORDER BY opened_at"
    ).fetchall()
    return [dict(r) for r in rows]


def close_trade(db: sqlite3.Connection, trade_id: int, exit_price: float,
                pnl_usd: float, close_reason: str, now: int):
    db.execute(
        "UPDATE paper_trades SET closed_at = ?, exit_price = ?, pnl_usd = ?, "
        "close_reason = ? WHERE id = ?",
        (now, exit_price, pnl_usd, close_reason, trade_id),
    )
