const fs = require("fs");
let b = fs.readFileSync("src/bot.js", "utf8");
let fail = (m) => { console.error(m); process.exit(1); };
const anchor = '  // ─── public GET /news?limit=20';
if (!b.includes(anchor)) fail("news anchor missing");

const rssText = [
  '  // ─── public GET /feed.xml — RSS 2.0 of the latest directional alerts ─',
  '  // Free distribution surface: feed readers, IFTTT/Zapier triggers,',
  '  // embeds. Directional calls only (neutral plumbing stays on the API).',
  '  if (request.method === "GET" && path === "/feed.xml") {',
  "    try {",
  '      const payload = await cachedPayload(env, "feed:v1", async () => {',
  "        const { results } = await env.DB.prepare(",
  "          `SELECT w.id, w.chain, w.symbol, w.usd_value, w.detected_at, a.headline, a.signal, a.confidence, a.interpretation, w.tx_hash",
  "           FROM whales w LEFT JOIN analysis a ON a.whale_id = w.id",
  "           WHERE w.analysis_status = 'done' AND a.signal IN ('bullish','bearish')",
  "           ORDER BY w.detected_at DESC LIMIT 30`",
  "        ).all();",
  "        return (results || []).map((r) => ({",
  "          id: r.id, chain: r.chain, symbol: r.symbol, usd_value: r.usd_value,",
  "          detected_at: r.detected_at, headline: r.headline || \"\", signal: r.signal || \"\",",
  '          interpretation: r.interpretation || "", tx_hash: r.tx_hash,',
  "        }));",
  "      });",
  '      const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");',
  "      const items = payload.map((a) => {",
  '        const link = (a.chain === "BTC" ? "https://blockchain.com/tx/" : "https://etherscan.io/tx/") + (a.tx_hash || "");',
  "        return `  <item><title>${esc(a.signal.toUpperCase())}: ${esc(a.headline || a.usd_value + \" \" + a.symbol)}</title><link>${esc(link)}</link><guid>whale-${a.id}</guid><pubDate>${new Date(a.detected_at).toUTCString()}</pubDate><description>${esc(a.interpretation)}</description></item>`;",
  "      }).join(\"\\n\");",
  '      const xml = `<?xml version="1.0" encoding="UTF-8"?>\\n<rss version="2.0"><channel><title>WhaleSignal — directional whale calls</title><link>https://saman-ghorayshi.github.io/whalesignal/</link><description>Graded whale-flow alerts (directional only)</description>\\n${items}\\n</channel></rss>`;',
  '      return new Response(xml, { status: 200, headers: { "Content-Type": "application/rss+xml", "Cache-Control": "public, max-age=300" } });',
  "    } catch (e) {",
  '      return jsonResponse({ ok: false, reason: "db_error", error: e.message }, 500);',
  "    }",
  "  }",
  "",
].join("\n");
b = b.replace(anchor, rssText.join("\n"));
fs.writeFileSync("src/bot.js", b);
console.log("feed.xml route added");
