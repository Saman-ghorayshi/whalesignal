#!/usr/bin/env python3
"""tools/daily_report.py — daily intelligence report for WhaleSignal.

Reads the /stats endpoint from the deployed Worker, writes a JSON file
to docs/data/daily/YYYY-MM-DD.json, and posts a summary to Telegram
via the bot's channel.

Runs via .github/workflows/daily.yml on a cron schedule.

Usage:
    python tools/daily_report.py --api https://whalesignal-bot.sthidontknow.workers.dev \
        --tg-token $BOT_TOKEN --chat-id $PUBLIC_CHANNEL --output docs/data/daily/

Ponytail: one script, one fetch, one file write, one TG message.
Add multi-day rollups or HTML rendering when the JSON stops being enough.
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
    """Fetch JSON from a URL, return parsed dict."""
    req = Request(url, headers={"User-Agent": "whalesignal-daily-report/1.0"})
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def fmt_usd(n) -> str:
    if n is None:
        return "—"
    n = float(n)
    if abs(n) >= 1e9:
        return f"${n/1e9:.1f}B"
    if abs(n) >= 1e6:
        return f"${n/1e6:.1f}M"
    if abs(n) >= 1e3:
        return f"${n/1e3:.1f}K"
    return f"${n:.0f}"


def build_summary(data: dict, date_str: str) -> str:
    """Build the Telegram message text for the daily summary."""
    lines = [
        f"📊 WhaleSignal Daily Report — {date_str}",
        "",
        f"🐋 Total whales detected: {data.get('total_whales', 0)}",
        f"💰 Total volume: {fmt_usd(data.get('total_volume'))}",
        f"📈 24h count: {data.get('count_24h', 0)}",
        f"📅 7d count: {data.get('count_7d', 0)}",
        f"🏆 Largest transfer: {fmt_usd(data.get('largest_transfer'))}",
        "",
    ]
    sigs = data.get("signals", {})
    if sigs:
        lines.append(f"🟢 Bullish: {sigs.get('bullish', 0)}")
        lines.append(f"🔴 Bearish: {sigs.get('bearish', 0)}")
        lines.append(f"⚪ Neutral: {sigs.get('neutral', 0)}")
        lines.append("")

    acc = data.get("accuracy")
    if acc:
        lines.append(f"🎯 AI Accuracy: {acc.get('correct', 0)}/{acc.get('evaluated', 0)} "
                      f"({acc.get('rate', 0)}%)")
        lines.append("")

    syms = data.get("top_symbols", [])
    if syms:
        lines.append("🏆 Top symbols:")
        for s in syms[:3]:
            lines.append(f"  {s['symbol']}: {s['count']} whales, {fmt_usd(s['volume'])}")
        lines.append("")

    mkt = data.get("market") or {}
    if mkt:
        btc = mkt.get("btc_price")
        eth = mkt.get("eth_price")
        fg = mkt.get("fear_greed")
        lines.append(f"📊 Market: BTC ${btc:,.0f}" if btc else "📊 Market: BTC —")
        if eth:
            lines[-1] += f" | ETH ${eth:,.0f}"
        if fg is not None:
            lines[-1] += f" | F&G {fg}"
        lines.append("")

    lines.append("Full stats: https://whalesignal.samsha.dev/stats.html")
    return "\n".join(lines)


def send_telegram(token: str, chat_id: str, text: str) -> bool:
    """Send a message to a Telegram chat. Returns True on success."""
    if not token or not chat_id:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": ""}).encode()
    req = Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except (URLError, OSError) as e:
        print(f"telegram send failed: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="WhaleSignal daily report")
    parser.add_argument("--api", default=os.environ.get("WS_API", "https://whalesignal-bot.sthidontknow.workers.dev"),
                        help="Worker API base URL")
    parser.add_argument("--tg-token", default=os.environ.get("BOT_TOKEN", ""),
                        help="Telegram bot token")
    parser.add_argument("--chat-id", default=os.environ.get("PUBLIC_CHANNEL", ""),
                        help="Telegram chat ID for the public channel")
    parser.add_argument("--output", default="docs/data/daily",
                        help="Output directory for the JSON report")
    args = parser.parse_args()

    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"[daily_report] fetching stats from {args.api}/stats for {date_str}")

    data = fetch_json(f"{args.api}/stats")

    # Write JSON report
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{date_str}.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump({"date": date_str, "generated_at": datetime.now(timezone.utc).isoformat(), "data": data}, f, indent=2)
    print(f"[daily_report] wrote {out_file}")

    # Build summary and post to Telegram
    summary = build_summary(data, date_str)
    print(f"[daily_report] summary:\n{summary}")

    if send_telegram(args.tg_token, args.chat_id, summary):
        print("[daily_report] posted to Telegram")
    else:
        print("[daily_report] Telegram not sent (no token or send failed)")

    print("[daily_report] done")


if __name__ == "__main__":
    main()
