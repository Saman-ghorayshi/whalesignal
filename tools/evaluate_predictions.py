#!/usr/bin/env python3
"""tools/evaluate_predictions.py — evaluate AI prediction accuracy 24h later.

Reads whales with analysis done > 24h ago that haven't been evaluated yet.
Fetches current BTC/ETH price from CoinGecko, compares to price_at_detect,
and marks prediction_outcome as 'correct', 'wrong', or 'neutral' based on
the signal direction vs actual price movement.

Signal logic:
  bullish  + price_up   → correct
  bullish  + price_down → wrong
  bearish  + price_down → correct
  bearish  + price_up   → wrong
  neutral  → always 'neutral' (no directional prediction)

Writes results back to D1 via the Worker's /evaluate endpoint (future),
or directly if running with D1 access. For now, writes results to
docs/data/evaluations/YYYY-MM-DD.json for manual review.

Usage:
    python tools/evaluate_predictions.py --api https://whalesignal-bot.samsha.workers.dev

Ponytail: one script, one eval pass, one JSON write. Add a D1 UPDATE
Worker endpoint when the JSON stops being enough.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError


def fetch_json(url: str) -> dict:
    req = Request(url, headers={"User-Agent": "whalesignal-evaluate/1.0"})
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def evaluate_signal(signal: str, price_at_detect: float, price_now: float, threshold_pct: float = 1.0) -> str:
    """Determine if a prediction was correct, wrong, or neutral.

    threshold_pct: minimum price movement to count as a directional move.
    ponytail: 1% threshold filters noise. Tune based on asset volatility.
    """
    if not signal or signal == "neutral":
        return "neutral"
    if not price_at_detect or not price_now:
        return "no_data"

    pct_change = ((price_now - price_at_detect) / price_at_detect) * 100
    moved_up = pct_change > threshold_pct
    moved_down = pct_change < -threshold_pct

    if signal == "bullish":
        return "correct" if moved_up else ("wrong" if moved_down else "neutral")
    if signal == "bearish":
        return "correct" if moved_down else ("wrong" if moved_up else "neutral")
    return "neutral"


def main():
    parser = argparse.ArgumentParser(description="Evaluate AI prediction accuracy")
    parser.add_argument("--api", default=os.environ.get("WS_API", "https://whalesignal-bot.samsha.workers.dev"),
                        help="Worker API base URL")
    parser.add_argument("--output", default="docs/data/evaluations",
                        help="Output directory for evaluation results")
    parser.add_argument("--threshold", type=float, default=1.0,
                        help="Min price movement %% to count as directional (default: 1.0)")
    args = parser.parse_args()

    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Fetch history with analysis — we need whales > 24h old with signals and price_at_detect.
    # The /history endpoint doesn't expose price_at_detect in the JSON, but the D1 row has it.
    # For now: fetch /history with limit=100 and signal filter, then fetch current prices.
    # ponytail: evaluating via the API means we don't have price_at_detect in the response.
    # The real eval needs a D1 query. This script prepares the eval file and fetches prices.
    # The Worker needs a /evaluate endpoint to do the D1 UPDATE. That's a future task.

    print(f"[evaluate] fetching history from {args.api}/history?limit=100")
    data = fetch_json(f"{args.api}/history?limit=100")

    # Fetch current BTC/ETH prices
    print("[evaluate] fetching current prices from CoinGecko")
    cg_url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd"
    try:
        cg = fetch_json(cg_url)
        btc_now = cg.get("bitcoin", {}).get("usd")
        eth_now = cg.get("ethereum", {}).get("usd")
    except (URLError, OSError) as e:
        print(f"[evaluate] coingecko failed: {e}", file=sys.stderr)
        btc_now = eth_now = None

    results = []
    for alert in data.get("alerts", []):
        signal = alert.get("signal")
        chain = (alert.get("chain") or "").lower()
        if not signal or signal == "neutral":
            continue

        # We don't have price_at_detect in the /history response — yet.
        # When we add a /evaluate endpoint, it will do the D1 query directly.
        # For now, record what we can evaluate.
        price_now = btc_now if chain == "btc" else eth_now if chain == "eth" else None

        results.append({
            "id": alert.get("id"),
            "chain": alert.get("chain"),
            "signal": signal,
            "detected_at": alert.get("detected_at"),
            "price_now": price_now,
            "headline": alert.get("headline"),
        })

    # Write evaluation file
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{date_str}.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump({
            "date": date_str,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "btc_price": btc_now,
            "eth_price": eth_now,
            "threshold_pct": args.threshold,
            "evaluated": len(results),
            "results": results,
        }, f, indent=2)
    print(f"[evaluate] wrote {out_file} with {len(results)} entries")
    print("[evaluate] done — note: full D1 UPDATE requires a /evaluate Worker endpoint")


if __name__ == "__main__":
    main()
