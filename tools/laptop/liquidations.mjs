#!/usr/bin/env node
// tools/laptop/liquidations.mjs — the laptop's second collector job.
//
// Listens to Bybit's keyless all-liquidation websocket during your session,
// aggregates forced closures into 1-minute buckets (long vs short USD), and
// writes a daily JSONL + prints the top liquidation minutes. Liquidation
// cascades are the market-context signal the confluence model can't get
// from chain data: mass long liquidations explain "why the whale sold".
//
// Usage:  node tools/laptop/liquidations.mjs [hours=4] [symbol=BTCUSDT]
// Output: liquidations_YYYYMMDD.jsonl (one line per minute with flow)
//
// Node >= 22 (global WebSocket). Run for as long as you like; Ctrl-C ends
// the session and flushes.

import { appendFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const HOURS = Number(args[0]) || 4;
const SYMBOL = args[1] || "BTCUSDT";
const OUT = `liquidations_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;
const END = Date.now() + HOURS * 3_600_000;

const buckets = new Map(); // minute → {long_usd, short_usd, events}
let total = 0, totalUsd = 0;

function bucketFor(ts) {
  const minute = Math.floor(ts / 60_000) * 60_000;
  if (!buckets.has(minute)) buckets.set(minute, { long_usd: 0, short_usd: 0, events: 0 });
  return buckets.get(minute);
}

function flush() {
  for (const [minute, b] of buckets) {
    if (b.events === 0) continue;
    appendFileSync(OUT, JSON.stringify({ minute, symbol: SYMBOL, ...b }) + "\n");
    b.events = 0; // flush once
  }
}

const ws = new WebSocket(`wss://stream.bybit.com/v5/public/linear`);
ws.onopen = () => {
  ws.send(JSON.stringify({ op: "subscribe", args: ["allLiquidation." + SYMBOL] }));
  console.error(`[liquidations] streaming ${SYMBOL} for ${HOURS}h → ${OUT}`);
};
ws.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    for (const liq of msg.data || []) {
      const ts = Number(liq.T) || Date.now();
      const side = String(liq.S || "").toUpperCase(); // side of the CLOSED position
      const usd = (Number(liq.Q) || 0) * (Number(liq.P) || 0);
      const b = bucketFor(ts);
      if (side === "SELL") b.long_usd += usd;   // a SELL liquidation = long closed
      else b.short_usd += usd;
      b.events++;
      total++; totalUsd += usd;
    }
  } catch { /* skip malformed frames */ }
};
ws.onclose = () => console.error("[liquidations] stream closed");
ws.onerror = (e) => console.error("[liquidations] ws error:", e.message || e);

const tick = setInterval(() => {
  flush();
  if (Date.now() > END) {
    flush();
    const top = [...buckets.entries()].filter(([, b]) => b.events > 0)
      .sort((a, b) => (b[1].long_usd + b[1].short_usd) - (a[1].long_usd + a[1].short_usd))
      .slice(0, 5);
    console.log(JSON.stringify({
      session_hours: HOURS, events: total, total_usd: Math.round(totalUsd),
      top_minutes: top.map(([minute, b]) => ({ minute: new Date(minute).toISOString(), ...b })),
      next: "publish top minutes → config:liq_events KV for alert context",
    }, null, 2));
    ws.close();
    clearInterval(tick);
    process.exit(0);
  }
}, 30_000);
