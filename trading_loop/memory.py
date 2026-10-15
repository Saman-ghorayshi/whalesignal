"""trading_loop/memory.py — FinMem L2/L3 read helpers + trade/signal writes.

Reads are pure SQLite queries. Writes (record_trade, mark_processed,
close_trade, apply_migrations) are the loop's only persistence path.
"""

import os
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


def mark_processed(db: sqlite3.Connection, signal_id: int, skip_reason: str = None):
    """Mark a signal processed. skip_reason is informational only (see record_skip)."""
    db.execute("UPDATE signals SET processed = 1 WHERE id = ?", (signal_id,))


def record_skip(db: sqlite3.Connection, signal_id: int, reason: str):
    """Dead-letter a signal: processed=1 with a human-readable skip_reason.

    Used for poison signals (corrupt JSON, LLM garbage, invalid side, ...)
    that must NOT be retried on every future run.
    """
    db.execute(
        "UPDATE signals SET processed = 1, skip_reason = ? WHERE id = ?",
        (reason, signal_id),
    )


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


def apply_migrations(db: sqlite3.Connection, migrations_dir: str):
    """Apply pending *.sql migrations in filename order.

    Re-runs are safe: 'duplicate column' errors are swallowed, anything
    else raises. Keeps long-lived trades.db files (GH Actions) in sync
    with schema.sql without a migration framework.
    """
    if not os.path.isdir(migrations_dir):
        return
    for fname in sorted(os.listdir(migrations_dir)):
        if not fname.endswith(".sql"):
            continue
        with open(os.path.join(migrations_dir, fname)) as f:
            sql = f.read()
        for chunk in sql.split(";"):
            lines = [ln for ln in chunk.splitlines()
                     if not ln.strip().startswith("--")]
            stmt = "\n".join(lines).strip()
            if not stmt:
                continue
            try:
                db.execute(stmt)
            except sqlite3.OperationalError as e:
                if "duplicate column" in str(e).lower():
                    continue  # already applied
                raise
    db.commit()
