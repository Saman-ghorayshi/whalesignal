#!/usr/bin/env node
// tools/backtest_strategies.mjs — the strategy tournament's backtest leg.
// Pulls the real hourly price history from prod D1 and runs every strategy
// walk-forward (no lookahead), plus the buy-and-hold benchmark. This is the
// "which approach actually earns" evidence — before a month of live paper
// trading accumulates.
//
// Usage: node tools/backtest_strategies.mjs   (needs CF_ID in .env)
import { readFileSync } from "node:fs";
import { backtest, buyHold, momentumBreakout, meanReversion } from "../src/strategies.js";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const acct = (await (await fetch("https://api.cloudflare.com/client/v4/accounts", {
  headers: { Authorization: "Bearer " + env.CF_ID },
})).json()).result[0].id;

async function query(sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/c8e9d8a9-fc2f-4fce-98d4-86f5ab99100a/query`,
    {
      method: "POST",
      headers: { Authorization: "Bearer " + env.CF_ID, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    }
  );
  const j = await res.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.result[0].results;
}

const rows = await query(
  "SELECT hour_bucket AS ts, price FROM price_history WHERE coin = 'btc' ORDER BY hour_bucket ASC"
);
const prices = rows.map((r) => ({ ts: r.ts, price: r.price }));
console.log(`history: ${prices.length} hourly BTC closes (${new Date(prices[0].ts).toISOString().slice(0, 10)} → ${new Date(prices[prices.length - 1].ts).toISOString().slice(0, 10)})`);

const league = [];
for (const [name, fn] of [
  ["momentum", momentumBreakout],
  ["meanrev", meanReversion],
]) {
  const r = backtest(prices, fn);
  league.push({ name, trades: r.trades, ...r });
}
const bh = buyHold(prices);
league.push({ name: "buy_hold", trades: bh.trades, ...bh });
league.sort((a, b) => b.finalEquity - a.finalEquity);

console.log("\n=== LEAGUE TABLE — 1000 USD start, walk-forward, 0.1% fee per change ===");
console.log("strategy      final      return    Sharpe    maxDD    trades");
for (const s of league) {
  console.log(
    String(s.name).padEnd(13) +
    String(s.finalEquity.toFixed(2)).padEnd(11) +
    String((s.total >= 0 ? "+" : "") + s.total.toFixed(2) + "%").padEnd(10) +
    String(s.sharpe.toFixed(2)).padEnd(10) +
    String(s.maxDD.toFixed(1) + "%").padEnd(9) +
    s.trades
  );
}
const bhRow = league.find((l) => l.name === "buy_hold");
const beaters = league.filter((l) => l.name !== "buy_hold" && l.finalEquity > bhRow.finalEquity);
console.log(`\nverdict: ${beaters.length ? beaters.map((b) => b.name).join(", ") : "NO strategy"} beat buy-and-hold over this window.`);
console.log("caveat: one 94-day window is one sample — the live tournament accumulates forward results daily.");
