#!/usr/bin/env python
"""trading_loop/main.py — the trading loop.

Polls R2 NDJSON alerts, runs bull/bear debate (1 LLM call), checks risk guards,
executes paper orders on HL testnet, records to SQLite.

Usage:
  python trading_loop/main.py --db ./trades.db --alerts-url https://...alerts.ndjson

Dry-run (no testnet, no live LLM):
  python trading_loop/main.py --dry-run --alerts-file tests/fixture_alerts.ndjson --llm-stub tests/fixture_llm_responses.json
"""

import argparse
import json
import os
import sys
import time
import sqlite3

from trading_loop.memory import (
    recent_trades_for_whale, whale_beliefs, global_beliefs, whale_score,
    new_signals, mark_processed, record_trade, record_skip, open_trades,
    close_trade, apply_migrations,
)
from trading_loop.risk_manager import (
    check as risk_check, Decision as RiskDecision, RiskState,
    compute_daily_pnl, compute_open_exposure,
)
from trading_loop.llm import call_llm, extract_json

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema.sql")
MIGRATIONS_DIR = os.path.join(os.path.dirname(__file__), "migrations")

# Only these L1 chains map 1:1 onto a Hyperliquid perp. Anything else
# (SOL, ARB, ...) would silently trade the wrong coin — skip instead.
SUPPORTED_COINS = ("BTC", "ETH")


# ─── init ─────────────────────────────────────────────────────────────

def init_db(db_path: str) -> sqlite3.Connection:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    with open(SCHEMA_PATH) as f:
        db.executescript(f.read())
    apply_migrations(db, MIGRATIONS_DIR)
    db.commit()
    return db


# ─── HL response parsing ──────────────────────────────────────────────

def extract_order_id(resp: dict) -> str:
    """Best-effort order id from the hyperliquid-python-sdk response.

    Wire shape: {"response": {"type": "order", "data": {"statuses": [
        {"resting": {"oid": N}} | {"filled": {"oid": N, "avgPx": "..."}}]}}}
    """
    try:
        statuses = (resp or {}).get("response", {}).get("data", {}).get("statuses", [])
        for st in statuses:
            if not isinstance(st, dict):
                continue
            for key in ("filled", "resting"):
                inner = st.get(key)
                if isinstance(inner, dict) and "oid" in inner:
                    return str(inner["oid"])
        return str(statuses[0]) if statuses else "unknown"
    except Exception:
        return "unknown"


def extract_fill_price(resp: dict):
    """Best-effort average fill price from a market_open response.

    Returns float or None. Prefer the exchange-reported fill over a
    post-order mid — the mid can move between order and query.
    """
    try:
        statuses = (resp or {}).get("response", {}).get("data", {}).get("statuses", [])
        for st in statuses:
            if not isinstance(st, dict):
                continue
            filled = st.get("filled")
            if isinstance(filled, dict) and filled.get("avgPx") not in (None, ""):
                return float(filled["avgPx"])
    except Exception:
        pass
    return None


# ─── prompt building (Paper 1: bull/bear debate in ONE call) ─────────

def build_trade_prompt(alert: dict, whale_fills: list, whale_belief_list: list,
                       global_belief_list: list, score: float = None) -> str:
    fills_str = json.dumps(whale_fills[:5], default=str) if whale_fills else "[]"
    beliefs_str = "\n".join(f"- {b}" for b in whale_belief_list) or "(none yet)"
    global_str = "\n".join(f"- {b}" for b in global_belief_list) or "(none yet)"
    score_str = f"{score:.2f}" if score is not None else "0.50 (new whale)"

    return f"""You are deciding whether to paper-copy this whale trade on Hyperliquid testnet.

Whale alert (from whalesignal):
{json.dumps(alert, default=str)}

Whale's recent HL fills:
{fills_str}

Beliefs about this whale:
{beliefs_str}

Current global regime beliefs:
{global_str}

Current whale score (0-1): {score_str}

Bearish case (3 sentences max): ...
Bullish case (3 sentences max): ...
Decision: COPY or SKIP
If COPY: side (long/short), size_pct (0-100), TP_pct, SL_pct, leverage (1-10)
Confidence: 0.0-1.0
Return JSON only. The bearish case must come BEFORE the bullish case."""


# ─── alert fetching ───────────────────────────────────────────────────

def fetch_alerts(alerts_url: str = None, alerts_file: str = None) -> list:
    """Fetch NDJSON alerts or JSON alerts from URL or local fixture file."""
    if alerts_file:
        with open(alerts_file) as f:
            text = f.read()
    elif alerts_url:
        import httpx
        resp = httpx.get(alerts_url, timeout=15, headers={"User-Agent": "whalesignal-trader/1.0"})
        resp.raise_for_status()
        text = resp.text
    else:
        return []

    alerts = []
    text = text.strip()
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict) and "alerts" in parsed:
                return parsed["alerts"]
        except Exception:
            pass

    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            alerts.append(json.loads(line))
        except Exception:
            continue
    return alerts


# ─── signal insertion ─────────────────────────────────────────────────

def insert_signals_from_alerts(db: sqlite3.Connection, alerts: list):
    """Insert alerts into signals table (dedupe by id)."""
    for a in alerts:
        alert_id = a.get("id")
        if alert_id is None:
            continue
        existing = db.execute("SELECT 1 FROM signals WHERE id = ?", (alert_id,)).fetchone()
        if existing:
            continue
        db.execute(
            "INSERT OR IGNORE INTO signals "
            "(id, whale, chain, signal, from_label, to_label, usd_value, detected_at, raw_json, processed) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
            (
                alert_id,
                a.get("whale"),
                a.get("chain"),
                a.get("signal"),
                a.get("from_label"),
                a.get("to_label"),
                a.get("usd_value"),
                a.get("detected_at"),
                json.dumps(a),
            ),
        )
    db.commit()


# ─── the decision (one LLM call) ──────────────────────────────────────

def decide_and_trade(db, signal, hl, llm_base_url, starting_balance, dry_run=False, llm_stub=None, gemini_key=None):
    """Process one signal: LLM debate → risk check → execute → record."""

    whale = signal["whale"]

    # T10: a corrupt raw_json must dead-letter, not poison the loop forever.
    try:
        alert = json.loads(signal["raw_json"]) if signal["raw_json"] else signal
    except (json.JSONDecodeError, TypeError) as e:
        print(f"  signal {signal['id']}: corrupt raw_json ({e}) — dead-lettering",
              file=sys.stderr)
        record_skip(db, signal["id"], f"corrupt raw_json: {e}")
        db.commit()
        return

    # T19: live mode with no HL client would record entry_price=0.0 zombie
    # trades. Dead-letter before spending an LLM call.
    if not dry_run and hl is None:
        print(f"  signal {signal['id']}: live mode but no HL client "
              f"(missing --testnet-key) — skipping", file=sys.stderr)
        record_skip(db, signal["id"], "live mode without HL client")
        db.commit()
        return

    # Read memory (FinMem L2 + L3)
    recent = recent_trades_for_whale(db, whale)
    wb = whale_beliefs(db, whale)
    gb = global_beliefs(db)
    score = whale_score(db, whale)

    # Fetch whale's HL position (step a — Info API, no key)
    whale_fills = []
    if hl:
        try:
            whale_fills = hl.whale_fills(whale)
        except Exception as e:
            print(f"  [warn] whale_fills failed for {whale}: {e}", file=sys.stderr)

    # ONE LLM call (bull/bear debate)
    prompt = build_trade_prompt(alert, whale_fills, wb, gb, score)
    if dry_run and llm_stub:
        with open(llm_stub) as f:
            stubs = json.load(f)
        # pick response by signal id or signal type
        decision = stubs.get(str(signal["id"])) or stubs.get(signal["signal"]) or stubs.get("default")
        if isinstance(decision, str):
            decision = extract_json(decision)
    else:
        decision = call_llm(prompt, base_url=llm_base_url, gemini_key=gemini_key)

    # Parse decision — every field is LLM output, so every field is suspect.
    # T10: garbage here dead-letters the signal instead of retrying forever.
    if not isinstance(decision, dict):
        print(f"  signal {signal['id']}: LLM returned non-dict "
              f"({type(decision).__name__}) — dead-lettering", file=sys.stderr)
        record_skip(db, signal["id"], f"LLM returned {type(decision).__name__}")
        db.commit()
        return

    verdict = str(decision.get("decision", "SKIP")).upper().strip()

    if verdict == "SKIP":
        print(f"  signal {signal['id']}: SKIP")
        mark_processed(db, signal["id"])
        db.commit()
        return

    # COPY — validate the decision fields before touching money.
    try:
        side_raw = decision.get("side", "long")
        side = str(side_raw).lower().strip()
        size_pct = float(decision.get("size_pct", 5))
        tp_pct = float(decision.get("TP_pct", decision.get("tp_pct", 3)))
        sl_raw = decision.get("SL_pct", decision.get("sl_pct"))
        sl_pct = float(sl_raw) if sl_raw is not None else None
        leverage = int(decision.get("leverage", 1))
        conf_raw = decision.get("confidence")
        confidence = float(conf_raw) if conf_raw is not None else None
    except (ValueError, TypeError) as e:
        print(f"  signal {signal['id']}: unparseable decision field ({e}) — "
              f"dead-lettering", file=sys.stderr)
        record_skip(db, signal["id"], f"bad decision field: {e}")
        db.commit()
        return

    # T11: NEVER silently default to SHORT on an LLM typo ("buy", "long-ish",
    # "l0ng"...). Anything not exactly long/short skips loudly.
    if side not in ("long", "short"):
        print(f"  signal {signal['id']}: invalid side {side_raw!r} — skipping",
              file=sys.stderr)
        record_skip(db, signal["id"], f"invalid side: {side_raw!r}")
        db.commit()
        return

    rd = RiskDecision(
        side=side, size_pct=size_pct, tp_pct=tp_pct, sl_pct=sl_pct, leverage=leverage,
        confidence=confidence,
    )

    now_ms = int(time.time() * 1000)
    daily_pnl = compute_daily_pnl(db, starting_balance, now_ms)
    exposure, open_count = compute_open_exposure(db)
    current_balance = starting_balance + daily_pnl  # simple, can refine later

    rs = RiskState(
        starting_balance=starting_balance,
        current_balance=current_balance,
        daily_pnl=daily_pnl,
        open_position_count=open_count,
        open_exposure=exposure,
    )

    check_result = risk_check(rd, rs)
    if not check_result.ok:
        print(f"  signal {signal['id']}: COPY rejected by risk_manager — {check_result.reason}")
        mark_processed(db, signal["id"])
        db.commit()
        return

    # Execute on HL testnet
    coin = str(alert.get("chain", "BTC")).upper()
    if coin not in SUPPORTED_COINS:
        print(f"  signal {signal['id']}: unsupported coin {coin!r} — skipping",
              file=sys.stderr)
        record_skip(db, signal["id"], f"unsupported coin: {coin!r}")
        db.commit()
        return

    size_usd = check_result.adjusted["size_usd"]

    hl_order_id = "dry-run"
    entry_price = 0.0
    if hl and not dry_run:
        try:
            is_buy = (side == "long")
            entry_price = hl.mid_price(coin)
            # T1: Hyperliquid wants COIN units — convert, don't pass USD.
            sz = hl.usd_to_sz(coin, size_usd, entry_price)
            resp = hl.open_market(coin, is_buy, sz)
            hl_order_id = extract_order_id(resp)          # T14
            fill_price = extract_fill_price(resp)         # T14
            if fill_price:
                entry_price = fill_price  # exchange truth beats post-order mid
            print(f"  signal {signal['id']}: COPY {side} {sz} {coin} "
                  f"(~${size_usd:.2f}) @ ~{entry_price} (oid={hl_order_id})")
        except Exception as e:
            # Covers order failure AND below-$10-minimum (usd_to_sz raises).
            print(f"  signal {signal['id']}: HL order failed — {e}", file=sys.stderr)
            record_skip(db, signal["id"], f"HL order failed: {e}")
            db.commit()
            return
    elif dry_run:
        entry_price = alert.get("market", {}).get(f"{coin.lower()}_price") or 0
        if entry_price == 0:
            entry_price = 63000  # snapshot for dry run (testnet hedge value)
        print(f"  signal {signal['id']}: COPY (dry-run) {side} ~${size_usd:.2f} {coin} @ ~{entry_price}")

    # Record trade — in EVERY mode (live trades used to vanish: the old
    # record sat where only dry-run could reach it).
    record_trade(db, {
        "signal_id": signal["id"],
        "whale": whale,
        "side": side,
        "size_usd": size_usd,
        "entry_price": entry_price,
        "coin": coin,
        "leverage": check_result.adjusted["leverage"],
        # T4: persist the risk-adjusted TP/SL so closes honor the debate,
        # not hardcoded 3%/5%.
        "tp_pct": check_result.adjusted["tp_pct"],
        "sl_pct": check_result.adjusted["sl_pct"],
        "opened_at": now_ms,
        "bear_case": decision.get("bearish_case", ""),
        "bullish_case": decision.get("bullish_case", ""),
        "llm_confidence": confidence,
        "hl_order_id": hl_order_id,
    })
    mark_processed(db, signal["id"])
    db.commit()


# ─── close expired trades (TP/SL/time) ───────────────────────────────

def check_and_close_trades(db, hl, dry_run=False):
    """Check open trades: if price crossed TP/SL, or >24h, close."""
    opens = open_trades(db)
    now = int(time.time() * 1000)
    for t in opens:
        coin = t["coin"]
        entry = t["entry_price"]
        side = t["side"]

        current_price = 0
        if hl and not dry_run:
            try:
                current_price = hl.mid_price(coin)
            except Exception:
                continue
        else:
            # dry-run: simulate price drift (entry +- 1%)
            current_price = entry * 1.01 if side == "long" else entry * 0.99

        if current_price == 0:
            continue

        # calculate pnl_pct
        if side == "long":
            pnl_pct = (current_price - entry) / entry * 100
        else:
            pnl_pct = (entry - current_price) / entry * 100

        # check TP/SL/time — T4: honor the per-trade TP/SL persisted at open
        # (falls back to the old 3%/5% defaults for pre-migration trades).
        tp = t.get("tp_pct") or 3.0
        sl = t.get("sl_pct") or 5.0
        close_reason = None

        if pnl_pct >= tp:
            close_reason = "tp"
        elif pnl_pct <= -sl:
            close_reason = "sl"
        elif (now - t["opened_at"]) > 86400000:
            close_reason = "time"

        if close_reason:
            pnl_usd = t["size_usd"] * pnl_pct / 100
            if hl and not dry_run:
                try:
                    # T15: no sz → SDK closes the ENTIRE position for the coin.
                    hl.close_market(coin)
                except Exception as e:
                    print(f"  close failed for trade {t['id']}: {e}", file=sys.stderr)
                    continue
            close_trade(db, t["id"], current_price, pnl_usd, close_reason, now)
            db.commit()
            print(f"  trade {t['id']}: closed ({close_reason}) pnl={pnl_usd:+.2f}")


# ─── main loop ────────────────────────────────────────────────────────

def run_loop(args):
    db = init_db(args.db)

    hl = None
    if not args.dry_run and args.testnet_key:
        from trading_loop.hl_client import HLClient
        hl = HLClient(args.testnet_key, testnet=True)

    alerts_url = args.alerts_url
    alerts_file = args.alerts_file
    gemini_key = args.gemini_key or os.environ.get("GEMINI_KEY")

    print(f"[loop] starting — db={args.db} dry_run={args.dry_run} gemini={'yes' if gemini_key else 'no'}")

    if args.dry_run or getattr(args, "once", False):
        # single pass — fetch alerts, process each, close trades, exit
        alerts = fetch_alerts(alerts_url=alerts_url, alerts_file=alerts_file)
        # insert each alert as a signal so the loop sees it
        if alerts:
            insert_signals_from_alerts(db, alerts)
        # re-read from DB so dedupe is clean
        sigs = new_signals(db)
        print(f"[loop] processing {len(sigs)} signal(s)")
        for s in sigs:
            try:
                decide_and_trade(db, s, hl, args.llm, args.starting_balance,
                                 dry_run=args.dry_run, llm_stub=args.llm_stub,
                                 gemini_key=gemini_key)
            except Exception as e:
                print(f"  [error] signal {s['id']}: {e}", file=sys.stderr)
        check_and_close_trades(db, hl, dry_run=args.dry_run)
        print(f"[loop] pass done — exiting ({'dry-run' if args.dry_run else 'once'} mode)")
        return

    # Live mode: loop forever, 60s interval
    while True:
        try:
            alerts = fetch_alerts(alerts_url=alerts_url, alerts_file=alerts_file)
            if alerts:
                insert_signals_from_alerts(db, alerts)

            sigs = new_signals(db)
            for s in sigs:
                try:
                    decide_and_trade(db, s, hl, args.llm, args.starting_balance,
                                     gemini_key=gemini_key)
                except Exception as e:
                    print(f"  [error] signal {s['id']}: {e}", file=sys.stderr)

            check_and_close_trades(db, hl)
        except Exception as e:
            print(f"[loop] error: {e}", file=sys.stderr)

        time.sleep(60)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="./trades.db")
    p.add_argument("--alerts-url", default=None, help="R2 NDJSON or Worker /history URL")
    p.add_argument("--alerts-file", default=None, help="local NDJSON file (for dry-run)")
    p.add_argument("--testnet-wallet", default=None)
    p.add_argument("--testnet-key", default=None)
    p.add_argument("--starting-balance", type=float, default=100.0)
    p.add_argument("--llm", default="http://localhost:20128/v1/chat/completions")
    p.add_argument("--gemini-key", default=None, help="Google AI Studio API key (bypasses 9Router, calls Gemini direct)")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--once", action="store_true", help="run a single pass and exit (for cron/GH Actions)")
    p.add_argument("--llm-stub", default=None, help="stub JSON file for LLM responses (dry-run)")
    args = p.parse_args()

    run_loop(args)


if __name__ == "__main__":
    main()
