"""tests/test_loop_fixes.py — regression tests for the trading-loop P0 fixes.

Covers (review IDs in parentheses):
  - T1:  USD→coin-unit conversion + szDecimals rounding (+ $10 minimum)
  - T14: order-id / fill-price extraction from HL responses
  - T15: close_market called with no sz (whole position)
  - T4:  TP/SL round-trip — stored per trade, honored at close
  - T11: side validation — garbage never silently shorts
  - T10: poison signals dead-letter instead of retrying forever
  - T19: live mode without HL client aborts instead of recording price-0 trades
  - T16: exposure cap + confidence gate in risk_manager
  - T18: seed_week refuses to delete without --force
  - migrations: 001 applies on old DBs, re-runs are no-ops

Pure logic only — no network. The HL client is stubbed; the SDK is only
imported for its real usd_to_sz math.
"""

import json
import os
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from trading_loop.main import (
    init_db, decide_and_trade, check_and_close_trades,
    extract_order_id, extract_fill_price, SUPPORTED_COINS,
)
from trading_loop.hl_client import HLClient, MIN_ORDER_NOTIONAL_USD
from trading_loop.memory import (
    new_signals, record_trade, open_trades, mark_processed, record_skip,
    apply_migrations,
)
from trading_loop.risk_manager import (
    Decision, RiskState, check as risk_check,
    MIN_CONFIDENCE, MAX_TOTAL_EXPOSURE_PCT,
)
from trading_loop import seed_week


# ─── helpers ──────────────────────────────────────────────────────────

def _stub_llm_file(tmp_path, decision, key="default"):
    p = tmp_path / "stub.json"
    p.write_text(json.dumps({key: decision}))
    return str(p)


def _insert_signal(db, sid=1, whale="0xTEST", chain="BTC", signal="bullish",
                   raw_json=None):
    alert = {"id": sid, "whale": whale, "chain": chain, "signal": signal,
             "market": {"btc_price": 63000, "eth_price": 1800}}
    raw = raw_json if raw_json is not None else json.dumps(alert)
    db.execute(
        "INSERT INTO signals (id, whale, chain, signal, raw_json, processed) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        (sid, whale, chain, signal, raw),
    )
    db.commit()
    row = db.execute("SELECT * FROM signals WHERE id = ?", (sid,)).fetchone()
    return dict(row)


COPY_DECISION = {
    "decision": "COPY", "side": "long", "size_pct": 8,
    "TP_pct": 5, "SL_pct": 3, "leverage": 2, "confidence": 0.72,
    "bearish_case": "bear", "bullish_case": "bull",
}


class FakeHL:
    """Offline stand-in for HLClient: real usd_to_sz math, fake network."""

    def __init__(self, mid_override=None):
        self.opens = []
        self.closes = []
        self.mid_override = mid_override or {}

    def whale_fills(self, whale):
        return []

    def mid_price(self, coin):
        if coin in self.mid_override:
            return self.mid_override[coin]
        return {"BTC": 63000.0, "ETH": 1800.0}[coin]

    def sz_decimals(self, coin):
        return {"BTC": 5, "ETH": 4}[coin]

    def usd_to_sz(self, coin, size_usd, mid):
        # exercise the REAL conversion logic, minus the meta() network call
        return HLClient.usd_to_sz(self, coin, size_usd, mid)

    def open_market(self, coin, is_buy, sz):
        self.opens.append({"coin": coin, "is_buy": is_buy, "sz": sz})
        return {"response": {"type": "order", "data": {"statuses": [
            {"filled": {"oid": 123456, "avgPx": "63100.5",
                        "totalSz": str(sz)}}]}}}

    def close_market(self, coin, sz=None):
        self.closes.append({"coin": coin, "sz": sz})
        return {}


# ─── T1: USD → coin units ─────────────────────────────────────────────

class TestUsdToSz:
    def test_btc_conversion_and_rounding(self):
        # 80 USD @ 63000, BTC szDecimals=5 → 0.00127
        sz = HLClient.usd_to_sz(FakeHL(), "BTC", 80.0, 63000.0)
        assert sz == 0.00127
        assert sz * 63000.0 >= MIN_ORDER_NOTIONAL_USD

    def test_eth_uses_4_decimals(self):
        sz = HLClient.usd_to_sz(FakeHL(), "ETH", 36.0, 1800.0)
        assert sz == 0.02

    def test_below_minimum_raises(self):
        # $8 notional can never be a valid HL order — must raise so the
        # caller skips with a reason instead of sending a doomed order.
        with pytest.raises(ValueError, match="below"):
            HLClient.usd_to_sz(FakeHL(), "BTC", 8.0, 63000.0)

    def test_no_mid_price_raises(self):
        with pytest.raises(ValueError, match="no mid price"):
            HLClient.usd_to_sz(FakeHL(), "BTC", 80.0, 0)

    def test_non_positive_size_raises(self):
        with pytest.raises(ValueError):
            HLClient.usd_to_sz(FakeHL(), "BTC", -5.0, 63000.0)


# ─── T14: order id / fill price ───────────────────────────────────────

class TestExtractOrderId:
    def test_filled(self):
        resp = {"response": {"data": {"statuses": [
            {"filled": {"oid": 999, "avgPx": "1.5"}}]}}}
        assert extract_order_id(resp) == "999"
        assert extract_fill_price(resp) == 1.5

    def test_resting(self):
        resp = {"response": {"data": {"statuses": [{"resting": {"oid": 7}}]}}}
        assert extract_order_id(resp) == "7"
        assert extract_fill_price(resp) is None

    def test_garbage(self):
        assert extract_order_id(None) == "unknown"
        assert extract_order_id({}) == "unknown"
        assert extract_fill_price(None) is None


# ─── T1 end-to-end: live path opens in coin units ─────────────────────

class TestLiveExecutionUnits:
    def test_open_market_receives_coin_units(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=11)
        hl = FakeHL()
        with patch("trading_loop.main.call_llm", return_value=dict(COPY_DECISION)):
            decide_and_trade(db, sig, hl, "http://x", 1000.0, dry_run=False)
        assert len(hl.opens) == 1
        o = hl.opens[0]
        # 8% of 1000 = $80 → 0.00127 BTC, NOT 80.0 (the old USD bug)
        assert o["sz"] == 0.00127
        assert o["is_buy"] is True
        trade = db.execute("SELECT * FROM paper_trades").fetchone()
        assert trade["entry_price"] == 63100.5  # exchange fill, not post-order mid
        assert trade["hl_order_id"] == "123456"
        db.close()

    def test_below_minimum_dead_letters(self, tmp_path):
        # $8 notional (the old fixture size) can't be an HL order.
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=12)
        hl = FakeHL()
        with patch("trading_loop.main.call_llm", return_value=dict(COPY_DECISION)):
            decide_and_trade(db, sig, hl, "http://x", 100.0, dry_run=False)
        assert hl.opens == []
        assert db.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0] == 0
        row = db.execute("SELECT processed, skip_reason FROM signals WHERE id=12").fetchone()
        assert row["processed"] == 1
        assert "minimum" in row["skip_reason"]
        db.close()


# ─── T15: whole-position close ────────────────────────────────────────

class TestWholePositionClose:
    def test_close_called_without_sz(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        now_ms = int(__import__("time").time() * 1000)
        record_trade(db, {
            "signal_id": 1, "whale": "0xT", "side": "long", "size_usd": 80.0,
            "entry_price": 63000.0, "coin": "BTC", "leverage": 1,
            "tp_pct": 0.5, "sl_pct": 5.0, "opened_at": now_ms,
            "bear_case": "", "bullish_case": "", "llm_confidence": 0.7,
            "hl_order_id": "123",
        })
        db.commit()
        # Live mode: mid 64000 vs entry 63000 → +1.6% ≥ tp_pct 0.5 → close.
        hl = FakeHL(mid_override={"BTC": 64000.0})
        check_and_close_trades(db, hl, dry_run=False)
        assert len(hl.closes) == 1
        assert hl.closes[0] == {"coin": "BTC", "sz": None}  # whole position
        db.close()


# ─── T4: TP/SL round-trip ─────────────────────────────────────────────

class TestTpSlRoundTrip:
    def test_llm_tpsl_persisted_at_record(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=21)
        stub = _stub_llm_file(tmp_path, COPY_DECISION)
        decide_and_trade(db, sig, hl=None, llm_base_url="http://x",
                         starting_balance=100.0, dry_run=True, llm_stub=stub)
        trade = db.execute("SELECT tp_pct, sl_pct FROM paper_trades").fetchone()
        assert trade["tp_pct"] == 5.0   # the LLM's TP_pct, not hardcoded 3.0
        assert trade["sl_pct"] == 3.0   # the LLM's SL_pct
        db.close()

    def test_missing_sl_gets_mandatory_default(self, tmp_path):
        d = dict(COPY_DECISION)
        d.pop("SL_pct")
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=22)
        stub = _stub_llm_file(tmp_path, d)
        decide_and_trade(db, sig, hl=None, llm_base_url="http://x",
                         starting_balance=100.0, dry_run=True, llm_stub=stub)
        trade = db.execute("SELECT sl_pct FROM paper_trades").fetchone()
        assert trade["sl_pct"] == 5.0  # risk_manager mandatory default
        db.close()

    def test_per_trade_tp_honored_at_close(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        now_ms = int(__import__("time").time() * 1000)
        # tp 0.5% < dry-run drift (+1%) → closes on tp
        record_trade(db, {
            "signal_id": 1, "whale": "0xT", "side": "long", "size_usd": 10.0,
            "entry_price": 100.0, "coin": "BTC", "leverage": 1,
            "tp_pct": 0.5, "sl_pct": 5.0, "opened_at": now_ms,
            "bear_case": "", "bullish_case": "", "llm_confidence": 0.7,
            "hl_order_id": "dry-run",
        })
        db.commit()
        check_and_close_trades(db, hl=None, dry_run=True)
        assert len(open_trades(db)) == 0
        row = db.execute("SELECT close_reason FROM paper_trades").fetchone()
        assert row["close_reason"] == "tp"
        db.close()

    def test_per_trade_tp_above_drift_stays_open(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        now_ms = int(__import__("time").time() * 1000)
        record_trade(db, {
            "signal_id": 1, "whale": "0xT", "side": "long", "size_usd": 10.0,
            "entry_price": 100.0, "coin": "BTC", "leverage": 1,
            "tp_pct": 5.0, "sl_pct": 5.0, "opened_at": now_ms,
            "bear_case": "", "bullish_case": "", "llm_confidence": 0.7,
            "hl_order_id": "dry-run",
        })
        db.commit()
        check_and_close_trades(db, hl=None, dry_run=True)
        assert len(open_trades(db)) == 1  # 1% drift < 5% tp/sl
        db.close()


# ─── T11: side validation ─────────────────────────────────────────────

class TestSideValidation:
    def test_garbage_side_skips_never_shorts(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=31)
        d = dict(COPY_DECISION)
        d["side"] = "buy"  # the old code treated anything != "long" as SHORT
        stub = _stub_llm_file(tmp_path, d)
        decide_and_trade(db, sig, hl=None, llm_base_url="http://x",
                         starting_balance=100.0, dry_run=True, llm_stub=stub)
        assert db.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0] == 0
        row = db.execute("SELECT processed, skip_reason FROM signals WHERE id=31").fetchone()
        assert row["processed"] == 1
        assert "invalid side" in row["skip_reason"]
        db.close()

    def test_uppercase_side_normalized(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=32)
        d = dict(COPY_DECISION)
        d["side"] = "SHORT"
        stub = _stub_llm_file(tmp_path, d)
        decide_and_trade(db, sig, hl=None, llm_base_url="http://x",
                         starting_balance=100.0, dry_run=True, llm_stub=stub)
        trade = db.execute("SELECT side FROM paper_trades").fetchone()
        assert trade["side"] == "short"
        db.close()


# ─── T10: poison signals ──────────────────────────────────────────────

class TestPoisonSignals:
    def test_garbage_size_pct_dead_letters(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=41)
        d = dict(COPY_DECISION)
        d["size_pct"] = "8%"  # float("8%") raises — old code retried forever
        stub = _stub_llm_file(tmp_path, d)
        decide_and_trade(db, sig, hl=None, llm_base_url="http://x",
                         starting_balance=100.0, dry_run=True, llm_stub=stub)
        assert db.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0] == 0
        row = db.execute("SELECT processed, skip_reason FROM signals WHERE id=41").fetchone()
        assert row["processed"] == 1 and row["skip_reason"]
        assert len(new_signals(db)) == 0  # never retried
        db.close()

    def test_corrupt_raw_json_dead_letters(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=42, raw_json="{not json")
        decide_and_trade(db, sig, hl=None, llm_base_url="http://x",
                         starting_balance=100.0, dry_run=True,
                         llm_stub=_stub_llm_file(tmp_path, COPY_DECISION))
        row = db.execute("SELECT processed, skip_reason FROM signals WHERE id=42").fetchone()
        assert row["processed"] == 1 and "corrupt raw_json" in row["skip_reason"]
        db.close()

    def test_non_dict_decision_dead_letters(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=43)
        stub = _stub_llm_file(tmp_path, ["not", "a", "dict"])
        decide_and_trade(db, sig, hl=None, llm_base_url="http://x",
                         starting_balance=100.0, dry_run=True, llm_stub=stub)
        row = db.execute("SELECT processed, skip_reason FROM signals WHERE id=43").fetchone()
        assert row["processed"] == 1 and row["skip_reason"]
        db.close()

    def test_record_skip_helper(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        _insert_signal(db, sid=44)
        record_skip(db, 44, "test reason")
        db.commit()
        row = db.execute("SELECT processed, skip_reason FROM signals WHERE id=44").fetchone()
        assert row["processed"] == 1 and row["skip_reason"] == "test reason"
        db.close()


# ─── T19: live mode without HL client ─────────────────────────────────

class TestLiveWithoutClient:
    def test_aborts_instead_of_price_zero_trade(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        sig = _insert_signal(db, sid=51)
        with patch("trading_loop.main.call_llm") as m:
            decide_and_trade(db, sig, hl=None, llm_base_url="http://x",
                             starting_balance=100.0, dry_run=False)
            m.assert_not_called()  # dead-lettered before spending an LLM call
        assert db.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0] == 0
        row = db.execute("SELECT processed, skip_reason FROM signals WHERE id=51").fetchone()
        assert row["processed"] == 1 and "HL client" in row["skip_reason"]
        db.close()


# ─── T16: risk_manager exposure + confidence ──────────────────────────

class TestRiskGuards:
    def _state(self, **kw):
        base = dict(starting_balance=100.0, current_balance=100.0)
        base.update(kw)
        return RiskState(**base)

    def test_exposure_cap_rejects(self, tmp_path):
        d = Decision(side="long", size_pct=5, tp_pct=5, sl_pct=3, leverage=2,
                     confidence=0.8)
        s = self._state(open_exposure=50.0)  # 50% of starting = at cap
        r = risk_check(d, s)
        assert not r.ok and "exposure" in r.reason

    def test_exposure_below_cap_passes(self, tmp_path):
        d = Decision(side="long", size_pct=5, tp_pct=5, sl_pct=3, leverage=2,
                     confidence=0.8)
        s = self._state(open_exposure=10.0)
        assert risk_check(d, s).ok

    def test_low_confidence_rejects(self):
        d = Decision(side="long", size_pct=5, tp_pct=5, sl_pct=3, leverage=2,
                     confidence=0.2)
        r = risk_check(d, self._state())
        assert not r.ok and "confidence" in r.reason

    def test_unstated_confidence_skips_gate(self):
        d = Decision(side="long", size_pct=5, tp_pct=5, sl_pct=3, leverage=2,
                     confidence=None)
        assert risk_check(d, self._state()).ok

    def test_confidence_at_threshold_passes(self):
        d = Decision(side="long", size_pct=5, tp_pct=5, sl_pct=3, leverage=2,
                     confidence=MIN_CONFIDENCE)
        assert risk_check(d, self._state()).ok

    def test_leverage_floored(self):
        d = Decision(side="long", size_pct=5, tp_pct=5, sl_pct=3, leverage=0,
                     confidence=0.8)
        r = risk_check(d, self._state())
        assert r.ok and r.adjusted["leverage"] == 1

    def test_nonsense_tp_defaulted(self):
        d = Decision(side="long", size_pct=5, tp_pct=-2, sl_pct=3, leverage=2,
                     confidence=0.8)
        r = risk_check(d, self._state())
        assert r.ok and r.adjusted["tp_pct"] == 3.0


# ─── T18: seed_week safety ────────────────────────────────────────────

class TestSeedWeekSafety:
    def test_refuses_without_force(self, tmp_path):
        target = tmp_path / "existing.db"
        target.write_text("precious data")
        with pytest.raises(SystemExit):
            with patch("sys.argv", ["seed_week", "--db", str(target)]):
                seed_week.main()
        assert target.read_text() == "precious data"

    def test_force_overwrites(self, tmp_path):
        target = tmp_path / "existing.db"
        target.write_text("old")
        with patch("sys.argv", ["seed_week", "--db", str(target), "--force"]):
            seed_week.main()
        con = sqlite3.connect(str(target))
        tables = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")]
        assert "paper_trades" in tables
        con.close()

    def test_default_is_temp_not_repo_root(self, tmp_path, capsys):
        with patch("sys.argv", ["seed_week"]):
            seed_week.main()
        out = capsys.readouterr().out
        assert "trades.db" not in out.split("seeded ")[1].split(" with")[0] or \
            str(tmp_path) in out or "/tmp" in out


# ─── migrations ───────────────────────────────────────────────────────

class TestMigrations:
    def test_fresh_db_has_new_columns(self, tmp_path):
        db = init_db(str(tmp_path / "t.db"))
        cols = {r["name"] for r in db.execute("PRAGMA table_info(paper_trades)")}
        assert {"tp_pct", "sl_pct"} <= cols
        scols = {r["name"] for r in db.execute("PRAGMA table_info(signals)")}
        assert "skip_reason" in scols
        db.close()

    def test_migration_upgrades_old_db(self, tmp_path):
        # Simulate a pre-fix trades.db: old schema, no new columns.
        p = tmp_path / "old.db"
        db = sqlite3.connect(str(p))
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE signals (id INTEGER PRIMARY KEY, processed INTEGER DEFAULT 0)")
        db.execute("CREATE TABLE paper_trades (id INTEGER PRIMARY KEY, closed_at INTEGER)")
        db.commit()
        db.close()
        db = init_db(str(p))  # must add the missing columns, not crash
        cols = {r["name"] for r in db.execute("PRAGMA table_info(paper_trades)")}
        assert {"tp_pct", "sl_pct"} <= cols
        # and re-running is a no-op
        db2 = init_db(str(p))
        db2.close()
        db.close()

    def test_supported_coins(self):
        assert set(SUPPORTED_COINS) == {"BTC", "ETH"}
