const fs = require("fs");
let b = fs.readFileSync("src/bot.js", "utf8");
let s = fs.readFileSync("src/scanner.js", "utf8");

// ─── 2. /alerts/export (news already handled): cache + since_id ──────────────────────────────
const oldExport = `  if (request.method === "GET" && path === "/alerts/export") {
    try {
      const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get("limit")) || 200)));
      const rows = await env.DB.prepare(
        \`SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol,
                w.usd_value, w.tx_type, w.detected_at,
                a.headline, a.interpretation, a.signal, a.confidence,
                wf.label AS from_label, wt.label AS to_label
         FROM whales w
         LEFT JOIN analysis a ON a.whale_id = w.id
         LEFT JOIN wallets wf ON wf.address = w.from_address AND wf.chain = w.chain
         LEFT JOIN wallets wt ON wt.address = w.to_address AND wt.chain = w.chain
         WHERE w.analysis_status = 'done'
         ORDER BY w.detected_at DESC LIMIT ?\`
      ).bind(limit).all();`;
const newExport = `  if (request.method === "GET" && path === "/alerts/export") {
    try {
      const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get("limit")) || 200)));
      // since_id lets the trading loop poll cheaply (only rows newer than the
      // last one it processed); without it the latest window is cached 60s.
      const sinceId = Math.max(0, Math.trunc(Number(url.searchParams.get("since_id")) || 0));
      const cacheKey = sinceId > 0 ? null : \`alerts-export:v1:\${limit}\`;
      const payload = await (cacheKey
        ? cachedPayload(env, cacheKey, () => exportRows(env, { limit, sinceId }))
        : exportRows(env, { limit, sinceId }));
      const lines = payload.map((row) => JSON.stringify(row));`;
if (!b.includes(oldExport)) { console.error("export anchor missing"); process.exit(1); }
b = b.replace(oldExport, newExport);

// replace the old query+lines tail with the helper-based body
const oldExportTail = `      let market = null;
      try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
      const lines = (rows?.results || []).map((w) =>
        JSON.stringify(buildAlertJSON(w, market))
      );`;
const newExportTail = `      const lines = payload.map((row) => JSON.stringify(row));`;
if (!b.includes(oldExportTail)) { console.error("export tail missing"); process.exit(1); }
b = b.replace(oldExportTail, newExportTail);

// add the exportRows helper right after the /alerts/export route's closing
// (anchor: the expected-path line)
const anchor = `  const expected = \`/tg/\${env.BOT_TOKEN || ""}\`;`;
const helper = `  const expected = \`/tg/\${env.BOT_TOKEN || ""}\`;`;
const helperFn = `// alert-export query shared by the route (cached or since_id polled)
async function exportRows(env, { limit, sinceId }) {
  const rows = await env.DB.prepare(
    \`SELECT w.id, w.chain, w.tx_hash, w.from_address, w.to_address, w.amount, w.symbol,
            w.usd_value, w.tx_type, w.detected_at,
            a.headline, a.interpretation, a.signal, a.confidence,
            wf.label AS from_label, wt.label AS to_label
     FROM whales w
     LEFT JOIN analysis a ON a.whale_id = w.id
     LEFT JOIN wallets wf ON wf.address = w.from_address AND wf.chain = w.chain
     LEFT JOIN wallets wt ON wt.address = w.to_address AND wt.chain = w.chain
     WHERE w.analysis_status = 'done' AND w.id > ?
     ORDER BY w.detected_at DESC LIMIT ?\`
  ).bind(sinceId, limit).all();
  let market = null;
  try { market = JSON.parse(await env.KV.get("market_cache") || "null"); } catch {}
  return (rows?.results || []).map((w) => buildAlertJSON(w, market)).filter(Boolean);
}

`;
if (!b.includes(anchor)) { console.error("expected anchor missing"); process.exit(1); }
b = b.replace(anchor, helperFn + anchor);

fs.writeFileSync("src/bot.js", b);

// ─── 3. scanner: two more price sources + two more news feeds ─────────
s = s.replace(
  '    name: "okx",',
  '    name: "coinpaprika",\n    url: (c) => "https://api.coinpaprika.com/v1/tickers/" + (c === "btc" ? "btc-bitcoin" : "eth-ethereum"),\n    parse: (j) => { const n = parseFloat(j?.quotes?.USD?.price); return Number.isFinite(n) ? n : null; },\n  },\n  {\n    name: "binance",\n    url: (c) => "https://api.binance.com/api/v3/ticker/price?symbol=" + c.toUpperCase() + "USDT",\n    parse: (j) => { const n = parseFloat(j?.price); return Number.isFinite(n) ? n : null; },\n  },\n  {\n    name: "okx",'
);
s = s.replace(
  '  "https://cryptoslate.com/feed/",',
  '  "https://cryptoslate.com/feed/",\n  "https://bitcoinmagazine.com/feed",\n  "https://www.theblock.co/rss.xml",'
);
// blockstream as 4th BTC source (after mempool)
s = s.replace(
  '        const hash = (await fetchText(`https://mempool.space/api/block-height/${blockNum}`, { timeoutMs: 8000 })).trim();\n        const txs = await fetchJSON(`https://mempool.space/api/block/${hash}/txs`, { maxBytes: 3_000_000 });\n        return normalizeMempoolBlock(blockNum, txs);',
  '        const hash = (await fetchText(`https://mempool.space/api/block-height/${blockNum}`, { timeoutMs: 8000 })).trim();\n        const txs = await fetchJSON(`https://mempool.space/api/block/${hash}/txs`, { maxBytes: 3_000_000 });\n        return normalizeMempoolBlock(blockNum, txs);\n      } catch (e3) {\n        console.warn(`btc block ${blockNum} via mempool.space failed, falling back to blockstream:`, e3.message);\n        const blk = await fetchJSON(`https://blockstream.info/api/block-height/${blockNum}`, { timeoutMs: 8000 }).then(async (hashJson) => {\n          const hash = typeof hashJson === "string" ? hashJson : String(hashJson);\n          return await fetchJSON(`https://blockstream.info/api/block/${hash}/txs`, { maxBytes: 3_000_000 });\n        });\n        return normalizeMempoolBlock(blockNum, blk);'
);
fs.writeFileSync("src/scanner.js", s);
console.log("round applied");
