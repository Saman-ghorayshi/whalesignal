#!/usr/bin/env python3
"""tools/evaluate_predictions.py — print the WhaleSignal prediction leaderboard.

The whalesignal-eval worker scores every prediction at 1h/6h/24h horizons
and maintains the leaderboard in KV. This script fetches it and prints a
human-readable accuracy report.

Usage:
    python tools/evaluate_predictions.py
    python tools/evaluate_predictions.py --api https://whalesignal-eval.<acct>.workers.dev
"""
import argparse
import json
import os
import sys
from urllib.request import Request, urlopen


def fetch_json(url: str) -> dict:
    req = Request(url, headers={"User-Agent": "whalesignal-evaluate/1.0"})
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def pct(n, hits):
    return f"{100.0 * hits / n:.1f}%" if n else "n/a"


def main():
    parser = argparse.ArgumentParser(description="WhaleSignal prediction leaderboard")
    parser.add_argument("--api", default=os.environ.get(
        "WS_EVAL_API", "https://whalesignal-eval.mv3sxp7x4fkv-6d9.workers.dev"),
        help="Eval worker base URL")
    args = parser.parse_args()

    try:
        board = fetch_json(f"{args.api}/leaderboard")
    except OSError as e:
        print(f"[evaluate] failed to reach {args.api}/leaderboard: {e}", file=sys.stderr)
        sys.exit(1)

    if not board.get("total"):
        print("No scored predictions yet — the evaluator runs hourly.")
        return

    print(f"=== WhaleSignal prediction leaderboard ({board['total']} scored calls) ===")
    for h, s in (board.get("by_horizon") or {}).items():
        print(f"  {h:>4}: {s['hits']}/{s['n']} hits ({pct(s['n'], s['hits'])})")
    print("\nBy motive:")
    for m, s in sorted((board.get("by_motive") or {}).items(), key=lambda kv: -kv[1]["n"]):
        print(f"  {m:<15}: {s['hits']}/{s['n']} ({pct(s['n'], s['hits'])})")
    print("\nBy confidence:")
    for b, s in (board.get("by_confidence") or {}).items():
        print(f"  {b:<5}: {s['hits']}/{s['n']} ({pct(s['n'], s['hits'])})")
    recent = board.get("recent") or []
    if recent:
        print(f"\nLast {len(recent)} (24h): " + " ".join(
            "✅" if r["o"] == "hit" else "❌" if r["o"] == "miss" else "➖"
            for r in recent))


if __name__ == "__main__":
    main()
