const fs = require("fs");
let b = fs.readFileSync("src/bot.js", "utf8");
let fail = (m) => { console.error(m); process.exit(1); };

// vol-adaptive threshold helper (pure)
const volHelper = [
  "/**",
  " * Pure: vol-adaptive grading threshold. A flat 1% is a huge move in quiet",
  " * markets and noise in violent ones — grade each call against its asset's",
  " * own recent volatility instead (7d of hourly closes → dailyized stdev,",
  " * threshold = max(1%, half the daily vol)).",
  " */",
  "export function volThreshold(hourlyPrices) {",
  "  const prices = (hourlyPrices || []).map((p) => (typeof p === \"object\" ? p.price : p)).filter((p) => p > 0);",
  "  if (prices.length < 24) return 1.0;",
  "  const rets = [];",
  "  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));",
  "  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;",
  "  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);",
  "  const dailyPct = Math.sqrt(24) * sd * 100;",
  "  return Math.round(Math.max(1.0, 0.5 * dailyPct) * 100) / 100;",
  "}",
  "",
  "export function gradeWindowCheck(detectedAt, now, minHours = 24, maxHours = 36) {",
].join("\n");
const gwAnchor = "export function gradeWindowCheck(detectedAt, now, minHours = 24, maxHours = 36) {";
if (!b.includes(gwAnchor)) fail("gradeWindow anchor missing");
b = b.replace(gwAnchor, volHelper);

const gpOld = [
  "  ).bind(now0, now0 - maxAgeHours * 3_600_000).run();",
  "  const { results } = await env.DB.prepare(",
  "    `SELECT w.id, w.chain, w.symbol, w.usd_value, w.detected_at, w.price_at_detect, w.from_address,",
  "            a.signal, a.confidence",
  "     FROM whales w JOIN analysis a ON a.whale_id = w.id",
  "     WHERE a.signal IN ('bullish','bearish') AND a.prediction_outcome IS NULL",
  "       AND w.detected_at < ?`",
  "  ).bind(now - minAgeMs).all();",
].join("\n");
const gpNew = [
  "  ).bind(now0, now0 - maxAgeHours * 3_600_000).run();",
  "  // per-asset vol-adaptive thresholds (BTC/ETH), computed once per run",
  "  const thresholds = {};",
  "  for (const coin of [\"btc\", \"eth\"]) {",
  "    try {",
  "      const { results: ph } = await env.DB.prepare(",
  "        \"SELECT price FROM price_history WHERE coin = ? ORDER BY hour_bucket DESC LIMIT 168\"",
  "      ).bind(coin).all();",
  "      thresholds[coin] = volThreshold(ph || []);",
  "    } catch { thresholds[coin] = 1.0; }",
  "  }",
  "  const { results } = await env.DB.prepare(",
  "    `SELECT w.id, w.chain, w.symbol, w.usd_value, w.detected_at, w.price_at_detect, w.from_address,",
  "            a.signal, a.confidence",
  "     FROM whales w JOIN analysis a ON a.whale_id = w.id",
  "     WHERE a.signal IN ('bullish','bearish') AND a.prediction_outcome IS NULL",
  "       AND w.detected_at < ?`",
  "  ).bind(now - minAgeMs).all();",
].join("\n");
if (!b.includes(gpOld)) fail("gp query anchor missing");
b = b.replace(gpOld, gpNew);

const gradeOld = "    const outcome = gradeSignal(row.signal, row.price_at_detect, priceNow);";
const gradeNew = "    const outcome = gradeSignal(row.signal, row.price_at_detect, priceNow, thresholds[String(row.chain).toLowerCase()] || 1.0);";
if (!b.includes(gradeOld)) fail("grade call anchor missing");
b = b.replace(gradeOld, gradeNew);

fs.writeFileSync("src/bot.js", b);
console.log("vol-adaptive grading done");
