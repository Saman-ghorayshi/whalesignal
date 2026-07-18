# Alert Export Schema — R2 NDJSON

**File:** `alerts.ndjson` in the `whalesignal-alerts` R2 bucket.
**Written by:** `src/bot.js` → `postAlertToR2()` after each alert posts to Telegram.
**Read by:** `trading_loop/main.py` every 60s (pull-based).

One NDJSON line per alert (newline-delimited JSON). Append-only.

## Shape (one line)

```json
{
  "id": 123,
  "whale": "0xABC...",
  "chain": "ETH",
  "signal": "bullish",
  "from_label": "Unknown",
  "to_label": "Binance Hot Wallet",
  "tx_type": "exchange_inflow",
  "usd_value": 5200000,
  "amount": 1500,
  "symbol": "ETH",
  "detected_at": 1721280000000,
  "market": {
    "btc_price": 61200,
    "eth_price": 3100,
    "fear_greed": 22
  },
  "analyst_interpretation": "Whale moved 1500 ETH to Binance during fear regime...",
  "headline": "Whale moved 1500 ETH to Binance",
  "confidence": 0.71
}
```

## Fields

| field | type | required | notes |
|---|---|---|---|
| `id` | int | yes | whalesignal whale row id; dedupe key in Python |
| `whale` | string | yes | `from_address` on L1 — the whale's wallet |
| `chain` | string | yes | "ETH" or "BTC" (uppercased) |
| `signal` | string | yes | "bullish" / "bearish" / "neutral" from analyst.js |
| `from_label` | string\|null | no | wallet label if known |
| `to_label` | string\|null | no | wallet label if known |
| `tx_type` | string | yes | exchange_inflow, exchange_outflow, exchange_internal, wallet_to_wallet, unknown |
| `usd_value` | float | yes | USD value of the move at detection time |
| `amount` | float | yes | raw amount of the token moved |
| `symbol` | string | yes | "ETH", "WBTC", "BTC" |
| `detected_at` | int | yes | ms epoch when whalesignal scanned it |
| `market.btc_price` | float\|null | no | Coingecko price at alert time |
| `market.eth_price` | float\|null | no | Coingecko price at alert time |
| `market.fear_greed` | int\|null | no | alternative.me Fear & Greed index (0-100) |
| `analyst_interpretation` | string | yes | Gemini's 2-3 sentence reading of the move |
| `headline` | string | yes | Gemini's one-line headline |
| `confidence` | float\|null | yes | analyst confidence 0.0-1.0 |

## Python parsing

```python
import json, httpx
resp = httpx.get(r2_url)  # the public R2 URL or wrangler dev URL
for line in resp.text.strip().splitlines():
    alert = json.loads(line)
    # dedupe by alert["id"]
```
