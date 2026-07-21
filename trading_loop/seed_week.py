#!/usr/bin/env python
"""trading_loop/seed_week.py — seed a test DB with one week of trades.

Creates trades.db with 7 days of paper trades for 3 whales, plus
existing beliefs and whale_scores so weekly_review has something
to critique. Run once before testing weekly_review.py.
"""

import sqlite3, json, time, os

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "trades.db")
SCHEMA = os.path.join(os.path.dirname(__file__), "schema.sql")

NOW = int(time.time() * 1000)
DAY_MS = 86400000

def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    with open(SCHEMA) as f:
        db.executescript(f.read())

    whales = [
        # (address, score, trades, wins, pnl)
        ("0xAAA111", 0.55, 5, 3, 12.50),   # decent whale, slight positive
        ("0xBBB222", 0.60, 4, 1, -8.20),   # was trusted, had bad week
        ("0xCCC333", 0.50, 3, 1, -2.10),    # new whale, mediocre
    ]

    for addr, score, trades, wins, pnl in whales:
        db.execute(
            "INSERT INTO whale_scores (whale, trade_count, win_count, total_pnl_usd, score, last_updated) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (addr, trades, wins, pnl, score, NOW - DAY_MS * 7),
        )

    # seed some existing beliefs (from previous week's review)
    db.execute(
        "INSERT INTO beliefs (scope, target, belief, created_at, source) "
        "VALUES ('whale', '0xAAA111', 'bullish signals from this wallet during fear regimes tend to win', ?, 'weekly_review')",
        (NOW - DAY_MS * 7,),
    )
    db.execute(
        "INSERT INTO beliefs (scope, target, belief, created_at, source) "
        "VALUES ('global', NULL, 'avoid opening shorts on Sundays — low volume leads to fakeouts', ?, 'weekly_review')",
        (NOW - DAY_MS * 7,),
    )

    # seed trades: mix of wins and losses across the week
    trades_data = [
        # (id, signal_id, whale, side, size_usd, entry, coin, lev, opened_ago_h, closed_ago_h, exit, pnl, reason)
        (1,  101, "0xAAA111", "long",  8, 1800, "ETH", 2,  168,  120, 1860,  2.67, "tp"),
        (2,  102, "0xAAA111", "long",  6, 1810, "ETH", 2,  144,   96, 1820,  0.33, "tp"),
        (3,  103, "0xAAA111", "short", 5, 63000,"BTC", 3,  120,   72, 61500, 11.90, "tp"),
        (4,  104, "0xAAA111", "long",  7, 1825, "ETH", 2,   96,   48, 1800, -0.96, "sl"),
        (5,  105, "0xAAA111", "long",  4, 1815, "ETH", 2,   72,   24, 1830,  0.33, "tp"),

        (6,  201, "0xBBB222", "short", 6, 63000,"BTC", 3,  156,  132, 64000, -0.95, "sl"),
        (7,  202, "0xBBB222", "short", 5, 63500,"BTC", 3,  120,   96, 64200, -0.55, "sl"),
        (8,  203, "0xBBB222", "short", 6, 63200,"BTC", 3,   96,   72, 62000, 11.36, "tp"),
        (9,  204, "0xBBB222", "short", 7, 63800,"BTC", 3,   48,   24, 64500, -0.77, "sl"),

        (10, 301, "0xCCC333", "long",  4, 1820, "ETH", 2,  100,   76, 1810, -0.22, "sl"),
        (11, 302, "0xCCC333", "long",  5, 1815, "ETH", 2,   72,   48, 1830,  0.41, "tp"),
        (12, 303, "0xCCC333", "long",  4, 1820, "ETH", 2,   48,   24, 1810, -0.22, "sl"),
    ]

    for t in trades_data:
        tid, sid, whale, side, sz, entry, coin, lev, opened_h, closed_h, exit_px, pnl, reason = t
        db.execute(
            "INSERT INTO paper_trades "
            "(id, signal_id, whale, side, size_usd, entry_price, coin, leverage, "
            "opened_at, closed_at, exit_price, pnl_usd, close_reason, bear_case, bullish_case, llm_confidence) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (tid, sid, whale, side, sz, entry, coin, lev,
             NOW - opened_h * 3600000,
             NOW - closed_h * 3600000,
             exit_px, pnl, reason, "bearish case stub", "bullish case stub", 0.6),
        )

    db.commit()
    db.close()
    print(f"seeded {DB_PATH} with 3 whales, 12 trades, 2 existing beliefs")

if __name__ == "__main__":
    main()
