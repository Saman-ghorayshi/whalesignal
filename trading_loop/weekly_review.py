#!/usr/bin/env python
"""trading_loop/weekly_review.py — FinCon self-critique loop.

Runs once a week (cron Monday 9am). Reads last 7 days of trades + existing
beliefs + current scores. ONE LLM call produces: new beliefs (NL rules),
updated whale_scores, 5-sentence summary. Writes all three to SQLite.
DMs the summary to Telegram via whalesignal's bot.

Usage:
  python -m trading_loop.weekly_review --db ./trades.db \
    --llm http://localhost:20128/v1/chat/completions \
    --tg-token $WS_BOT_TOKEN --tg-chat-id $YOUR_CHAT_ID

Dry-run (no Telegram, use stub):
  python -m trading_loop.weekly_review --dry-run --db ./trades.db \
    --llm-stub tests/fixture_review_response.json
"""

import argparse
import json
import os
import sys
import time
import sqlite3
import httpx

from trading_loop.llm import call_llm, extract_json

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema.sql")
WEEK_MS = 7 * 86400000


def init_db(db_path: str) -> sqlite3.Connection:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    with open(SCHEMA_PATH) as f:
        db.executescript(f.read())
    return db


# ─── data gathering ──────────────────────────────────────────────────

def gather_week(db: sqlite3.Connection, now_ms: int) -> dict:
    cutoff = now_ms - WEEK_MS
    trades = db.execute(
        "SELECT * FROM paper_trades WHERE closed_at IS NOT NULL AND closed_at >= ? "
        "ORDER BY closed_at",
        (cutoff,),
    ).fetchall()
    trades = [dict(t) for t in trades]

    scores = db.execute(
        "SELECT * FROM whale_scores ORDER BY score DESC"
    ).fetchall()
    scores = [dict(s) for s in scores]

    beliefs = db.execute(
        "SELECT * FROM beliefs ORDER BY created_at"
    ).fetchall()
    beliefs = [dict(b) for b in beliefs]

    return {"trades": trades, "scores": scores, "beliefs": beliefs}


def compute_weekly_stats(trades: list) -> dict:
    total = len(trades)
    wins = [t for t in trades if t["pnl_usd"] > 0]
    losses = [t for t in trades if t["pnl_usd"] <= 0]
    total_pnl = sum(t["pnl_usd"] for t in trades)
    biggest_win = max(trades, key=lambda t: t["pnl_usd"]) if trades else None
    biggest_loss = min(trades, key=lambda t: t["pnl_usd"]) if trades else None

    per_whale = {}
    for t in trades:
        w = t["whale"]
        if w not in per_whale:
            per_whale[w] = {"trades": 0, "wins": 0, "pnl": 0.0}
        per_whale[w]["trades"] += 1
        if t["pnl_usd"] > 0:
            per_whale[w]["wins"] += 1
        per_whale[w]["pnl"] += t["pnl_usd"]

    return {
        "total_trades": total,
        "win_count": len(wins),
        "loss_count": len(losses),
        "win_rate": len(wins) / total if total else 0,
        "total_pnl": round(total_pnl, 2),
        "biggest_win": {"pnl": biggest_win["pnl_usd"], "whale": biggest_win["whale"]} if biggest_win else None,
        "biggest_loss": {"pnl": biggest_loss["pnl_usd"], "whale": biggest_loss["whale"]} if biggest_loss else None,
        "per_whale": per_whale,
    }


# ─── prompt (FinCon pattern — self-critique with beliefs) ────────────

def build_review_prompt(week_data: dict, stats: dict) -> str:
    trades_str = json.dumps(
        [{"whale": t["whale"], "side": t["side"], "coin": t["coin"], "size_usd": t["size_usd"],
          "entry": t["entry_price"], "exit": t["exit_price"], "pnl": t["pnl_usd"],
          "reason": t["close_reason"]} for t in week_data["trades"]],
        indent=2,
    )
    scores_str = json.dumps(
        [{"whale": s["whale"], "score": s["score"], "trades": s["trade_count"],
          "wins": s["win_count"], "pnl": s["total_pnl_usd"]} for s in week_data["scores"]],
        indent=2,
    )
    beliefs_str = "\n".join(
        f"- [{b['scope']}] {b['target'] or 'global'}: {b['belief']}"
        for b in week_data["beliefs"]
    ) or "(none yet — first week)"

    return f"""You are reviewing a paper-trading bot's last 7 days. The bot copies
Hyperliquid testnet trades made by whale wallets when whalesignal's on-chain
alert system flags the same whale moving on L1.

The bot TRADES only when it sees a whale alert AND a matching HL position
opened by the same wallet within 30 minutes. It used the FinCon
self-critique pattern last week and wrote beliefs you'll see below.

## This Week's Trades
{trades_str}

## Weekly Stats
{json.dumps(stats, indent=2)}

## Current Whale Scores
{scores_str}

## Current Beliefs
{beliefs_str}

Critique this week. Output JSON only:
{{
  "new_beliefs": [
    {{"scope": "whale", "target": "0xABC...", "belief": "natural-language rule"}},
    {{"scope": "global", "target": null, "belief": "natural-language rule"}}
  ],
  "updated_scores": [
    {{"whale": "0xABC...", "new_score": 0.62, "reason": "1 sentence"}}
  ],
  "weekly_summary": "5 sentences, plain English, what happened and what you changed"
}}

Constraints:
- new_beliefs: write rules that would have prevented this week's losses OR
  would have amplified this week's wins. Each belief should be a one-sentence
  rule, not a paragraph.
- updated_scores: only change scores for whales with >= 3 trades this week.
  Score changes should reflect actual win rate + PnL, not vibes.
- weekly_summary: write TO Samsha, the human operator. Say "you" not "the bot."
  Tell him what worked, what didn't, and what you changed for next week."""


# ─── write back ──────────────────────────────────────────────────────

def apply_review(db: sqlite3.Connection, review: dict, now_ms: int):
    week_id = now_ms

    # insert new beliefs (append-only — FinCon pattern, old beliefs stay)
    for nb in review.get("new_beliefs", []):
        db.execute(
            "INSERT INTO beliefs (scope, target, belief, created_at, source) "
            "VALUES (?, ?, ?, ?, 'weekly_review')",
            (nb["scope"], nb.get("target"), nb["belief"], now_ms),
        )

    # update whale_scores (only for whales with 3+ trades)
    week_trades = db.execute(
        "SELECT whale, count(*) as cnt FROM paper_trades "
        "WHERE closed_at IS NOT NULL AND closed_at >= ? GROUP BY whale",
        (now_ms - WEEK_MS,),
    ).fetchall()
    trade_counts = {r["whale"]: r["cnt"] for r in week_trades}

    for us in review.get("updated_scores", []):
        whale = us["whale"]
        if trade_counts.get(whale, 0) < 3:
            continue  # skip: not enough trades this week
        new_score = float(us["new_score"])
        db.execute(
            "UPDATE whale_scores SET score = ?, last_updated = ? WHERE whale = ?",
            (new_score, now_ms, whale),
        )

    # insert weekly_review row (audit trail)
    db.execute(
        "INSERT INTO weekly_review (week_id, review_text, score_deltas, belief_changes, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (
            week_id,
            review.get("weekly_summary", ""),
            json.dumps(review.get("updated_scores", [])),
            json.dumps(review.get("new_beliefs", [])),
            now_ms,
        ),
    )

    db.commit()


# ─── Telegram ────────────────────────────────────────────────────────

def send_telegram(token: str, chat_id: str, text: str):
    resp = httpx.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text},
        timeout=10,
    )
    resp.raise_for_status()


# ─── main ────────────────────────────────────────────────────────────

def run(args):
    db = init_db(args.db)
    now_ms = int(time.time() * 1000)

    week_data = gather_week(db, now_ms)
    stats = compute_weekly_stats(week_data["trades"])

    print(f"[review] {len(week_data['trades'])} trades, "
          f"{stats['win_count']} wins, {stats['loss_count']} losses, "
          f"PnL ${stats['total_pnl']}")

    if not week_data["trades"]:
        print("[review] no trades this week — nothing to review")
        return

    prompt = build_review_prompt(week_data, stats)

    if args.dry_run and args.llm_stub:
        with open(args.llm_stub) as f:
            review = json.load(f)
    else:
        review = call_llm(prompt, base_url=args.llm, gemini_key=args.gemini_key,
                         model="nvidia/deepseek-ai/deepseek-v4-pro")

    print("[review] LLM response:")
    print(json.dumps(review, indent=2))

    apply_review(db, review, now_ms)
    print("[review] beliefs + scores + audit written to DB")

    summary = review.get("weekly_summary", "(no summary)")
    print(f"\n[review] Weekly Summary:\n{summary}")

    if args.tg_token and args.tg_chat_id and not args.dry_run:
        send_telegram(args.tg_token, args.tg_chat_id, summary)
        print("[review] sent to Telegram")
    elif not args.dry_run:
        print("[review] Telegram not configured — skipping DM (set --tg-token + --tg-chat-id)")

    # verify writes
    beliefs_count = db.execute("SELECT count(*) FROM beliefs").fetchone()[0]
    reviews_count = db.execute("SELECT count(*) FROM weekly_review").fetchone()[0]
    print(f"[review] verify: {beliefs_count} beliefs in table, {reviews_count} review rows")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="./trades.db")
    p.add_argument("--llm", default="http://localhost:20128/v1/chat/completions")
    p.add_argument("--gemini-key", default=os.environ.get("GEMINI_KEY"),
                   help="Google AI Studio API key (bypasses 9Router, calls Gemini direct)")
    p.add_argument("--tg-token", default=os.environ.get("WS_BOT_TOKEN"))
    p.add_argument("--tg-chat-id", default=os.environ.get("WS_CHAT_ID"))
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--llm-stub", default=None)
    args = p.parse_args()

    run(args)


if __name__ == "__main__":
    main()
