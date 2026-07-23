"""tests/test_main.py — tests for the trading loop main.py.

Tests the dry-run path end-to-end (no live LLM, no real HL testnet).
Uses the existing fixture_alerts.ndjson + fixture_llm_responses.json.
"""

import json
import os
import sys
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from trading_loop.main import (
    init_db, fetch_alerts, insert_signals_from_alerts,
    decide_and_trade, build_trade_prompt, run_loop,
)
from trading_loop.memory import new_signals, record_trade, open_trades
from trading_loop.risk_manager import Decision, RiskState, check as risk_check


FIXTURE_DIR = Path(__file__).parent
FIXTURE_ALERTS = FIXTURE_DIR / "fixture_alerts.ndjson"
FIXTURE_LLM = FIXTURE_DIR / "fixture_llm_responses.json"


# ─── init_db ──────────────────────────────────────────────────────────

class TestInitDb:
    def test_creates_all_tables(self, tmp_path):
        db_path = tmp_path / "test.db"
        db = init_db(str(db_path))
        tables = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        table_names = [t["name"] for t in tables]
        assert "signals" in table_names
        assert "paper_trades" in table_names
        assert "whale_scores" in table_names
        assert "beliefs" in table_names
        assert "weekly_review" in table_names

    def test_idempotent(self, tmp_path):
        db_path = tmp_path / "test.db"
        db = init_db(str(db_path))
        # calling again should not crash
        db2 = init_db(str(db_path))
        db2.close()


# ─── fetch_alerts ────────────────────────────────────────────────────

class TestFetchAlerts:
    def test_fetch_from_file(self):
        alerts = fetch_alerts(alerts_file=str(FIXTURE_ALERTS))
        assert len(alerts) == 3
        assert alerts[0]["whale"] == "0xAAA111"
        assert alerts[1]["chain"] == "BTC"
        assert alerts[2]["signal"] == "neutral"

    def test_fetch_empty_when_no_args(self):
        alerts = fetch_alerts()
        assert alerts == []


# ─── insert_signals_from_alerts ──────────────────────────────────────

class TestInsertSignals:
    def test_insert_dedupes(self, tmp_path):
        db = init_db(str(tmp_path / "test.db"))
        alerts = fetch_alerts(alerts_file=str(FIXTURE_ALERTS))
        insert_signals_from_alerts(db, alerts)
        assert len(new_signals(db)) == 3
        # insert again — should be deduped
        insert_signals_from_alerts(db, alerts)
        assert len(new_signals(db)) == 3
        db.close()


# ─── build_trade_prompt ──────────────────────────────────────────────

class TestBuildTradePrompt:
    def test_contains_decision_copy_or_skip(self):
        alert = {"id": 1, "chain": "ETH", "whale": "0xAAA"}
        prompt = build_trade_prompt(alert, [], [], [], None)
        assert "COPY or SKIP" in prompt
        assert "decision" in prompt.lower()

    def test_contains_whale_score(self):
        alert = {"id": 1, "chain": "BTC", "whale": "0xBBB"}
        prompt = build_trade_prompt(alert, [], [], [], 0.75)
        assert "0.75" in prompt

    def test_default_score_for_new_whale(self):
        alert = {"id": 1, "chain": "ETH", "whale": "0xCCC"}
        prompt = build_trade_prompt(alert, [], [], [], None)
        assert "0.50" in prompt


# ─── full dry-run path ───────────────────────────────────────────────

class TestDryRunPath:
    def test_full_dry_run_with_stubs(self, tmp_path):
        """Run the full trade loop in dry-run mode using fixture alerts + stub LLM."""
        db_path = tmp_path / "trades.db"
        db = init_db(str(db_path))

        alerts = fetch_alerts(alerts_file=str(FIXTURE_ALERTS))
        insert_signals_from_alerts(db, alerts)
        sigs = new_signals(db)
        assert len(sigs) == 3

        # Process each signal with stub LLM (no real network call)
        for s in sigs:
            decide_and_trade(db, s, hl=None, llm_base_url="http://localhost:20128",
                             starting_balance=100.0, dry_run=True,
                             llm_stub=str(FIXTURE_LLM))

        db.commit()

        # Check: 2 signals should have been COPYed (ids 1 and 2), 1 SKIPped (id 3)
        trades = db.execute("SELECT * FROM paper_trades").fetchall()
        assert len(trades) == 2  # signals 1 and 2 were COPY, 3 was SKIP

        # Check: all signals marked processed
        unprocessed = new_signals(db)
        assert len(unprocessed) == 0

        # Check: trade sides
        for t in trades:
            assert t["side"] in ("long", "short")
            assert t["size_usd"] > 0
            assert t["entry_price"] > 0

        db.close()


# ─── risk_manager integration ─────────────────────────────────────────

class TestRiskManagerIntegration:
    def test_size_pct_under_cap_passes_through(self, tmp_path):
        """LLM said size_pct=8 — that's under the 10% cap, so risk_manager lets it through.
        8% of 100 starting balance = $8."""
        db = init_db(str(tmp_path / "test.db"))
        alerts = fetch_alerts(alerts_file=str(FIXTURE_ALERTS))
        insert_signals_from_alerts(db, alerts)
        sigs = new_signals(db)

        # Process alert 1 (LLM says size_pct=8, leverage=2)
        s1 = [s for s in sigs if s["id"] == 1][0]
        decide_and_trade(db, s1, hl=None, llm_base_url="http://localhost:20128",
                         starting_balance=100.0, dry_run=True,
                         llm_stub=str(FIXTURE_LLM))

        trade = db.execute("SELECT * FROM paper_trades WHERE signal_id = 1").fetchone()
        # 8% of 100 = $8 — under the 10% cap, passes through
        assert trade["size_usd"] == 8.0
        # leverage from the fixture is 2, under the 10x cap
        assert trade["leverage"] == 2
        db.close()

    def test_size_pct_above_cap_clamped(self, tmp_path):
        """Manually test that risk_manager clamps size_pct > 10% down to 10%."""
        db = init_db(str(tmp_path / "test.db"))

        # Create a decision with 30% size
        decision = Decision(side="long", size_pct=30, tp_pct=5, sl_pct=3, leverage=2)
        state = RiskState(starting_balance=100.0, current_balance=100.0)
        result = risk_check(decision, state)

        assert result.ok
        # 30% should be clamped to 10% = $10
        assert result.adjusted["size_pct"] == 10.0
        assert result.adjusted["size_usd"] == 10.0
        db.close()
