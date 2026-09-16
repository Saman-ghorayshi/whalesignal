const fs = require("fs");
let s = fs.readFileSync("src/scanner.js", "utf8");
let ok = (m) => console.log(m);
let fail = (m) => { console.error(m); process.exit(1); };

// ─── 1. replace loadWalletMap with a labels-only cached map ──────────
const oldStart = s.indexOf("// Isolate-level cache: the map changes rarely");
const oldEnd = s.indexOf("// ─── rollup accumulator");
if (oldStart < 0 || oldEnd < 0 || oldEnd < oldStart) fail("loadWalletMap block bounds missing");
const newMap = [
  "// Labels map — the ONLY wallet data the tick loop needs on every row.",
  "// Exchange/treasury/bridge/miner labels drive tx classification; the map is",
  "// tiny (dozens of rows) and cached per isolate. Whale-history attributes",
  "// (tx_count/dormancy) are fetched per-candidate below, not full-table.",
  "let labelMapCache = { map: null, ts: 0 };",
  "const LABEL_MAP_TTL_MS = 60_000;",
  "",
  "async function loadLabelMap(env) {",
  "  if (labelMapCache.map && Date.now() - labelMapCache.ts < LABEL_MAP_TTL_MS) {",
  "    return labelMapCache.map;",
  "  }",
  "  const { results } = await env.DB.prepare(",
  "    \"SELECT address, chain, label, type FROM wallets \" +",
  "    \"WHERE label IS NOT NULL OR type IN ('exchange', 'treasury', 'bridge', 'miner', 'institution')\"",
  "  ).all();",
  "  const m = new Map();",
  "  if (results) {",
  "    for (const r of results) {",
  "      if (!r || !r.address) continue;",
  "      const entry = { label: r.label, type: r.type, chain: r.chain, tx_count: 0, first_seen: null, last_seen: null };",
  "      m.set(String(r.address).toLowerCase(), entry);",
  "      m.set(String(r.address), entry);",
  "    }",
  "  }",
  "  labelMapCache = { map: m, ts: Date.now() };",
  "  return m;",
  "}",
  "",
  "/**",
  " * Per-candidate wallet attributes (tx_count, first/last seen, reputation)",
  " * for the interestingness score + auto-labeling. ONE indexed query over the",
  " * distinct addresses in this tick's batch — replaces the old full-table scan.",
  " * Returns Map keyed by lowercased address.",
  " */",
  "async function fetchWalletInfos(env, addresses, chain) {",
  "  const out = new Map();",
  "  const uniq = [...new Set((addresses || []).filter(Boolean).map((a) => String(a))))];",
  "  for (let i = 0; i < uniq.length; i += 50) {",
  "    const chunk = uniq.slice(i, i + 50);",
  "    try {",
  "      const { results } = await env.DB.prepare(",
  "        \"SELECT address, chain, type, tx_count, first_seen, last_seen FROM wallets \" +",
  "        \"WHERE chain = ? AND lower(address) IN (\" + chunk.map(() => \"lower(?)\").join(\",\") + \")\"",
  "      ).bind(chain, ...chunk).all();",
  "      for (const r of results || []) out.set(String(r.address).toLowerCase(), r);",
  "    } catch (e) {",
  "      console.warn(\"wallet infos chunk failed (scoring degrades gracefully):\", e.message);",
  "    }",
  "  }",
  "  return out;",
  "}",
  "",
  "",
].join("\n");
s = s.slice(0, oldStart) + newMap + s.slice(oldEnd);
ok("1. label map + per-candidate infos");

// ─── 2. scanChain: use label map + collect candidate infos ───────────
s = s.replace(
  "  const walletMap = await loadWalletMap(env);\n  const acc = newRollupAcc(Math.floor(Date.now() / 3600000) * 3600000);",
  "  const walletMap = await loadLabelMap(env);\n  const acc = newRollupAcc(Math.floor(Date.now() / 3600000) * 3600000);"
);
ok("2a. label map swapped");

// after dropPlumbing: fetch infos for the tick's addresses
const dropAnchor = "      whales = dropPlumbing(whales, internalFloor);";
const dropNew = dropAnchor + `

      // wallet attributes only for THIS tick's candidates (indexed IN query)
      const candAddrs = whales.flatMap((w) => [w.from_address, w.to_address]).filter(Boolean);
      const walletInfos = await fetchWalletInfos(env, candAddrs, chain);`;
if (!s.includes(dropAnchor)) fail("drop anchor missing");
s = s.replace(dropAnchor, dropNew);
ok("2b. candidate infos fetched");

// per-whale: walletInfo from walletInfos first
s = s.replace(
  "          const fromKey = String(w.from_address).toLowerCase();\n          const walletInfo = walletMap.get(fromKey) ?? null;",
  "          const fromKey = String(w.from_address).toLowerCase();\n          const walletInfo = walletInfos.get(fromKey) ?? walletMap.get(fromKey) ?? null;"
);
ok("2c. walletInfo source swapped");

// exchange label lookup for rollups: walletMap covers labels
ok("2d. label lookups unchanged (walletMap still labels)");

// autoLabelWallets: info lookup via walletInfos
s = s.replace(
  "    // Auto-label: if a wallet crosses 3 txs, label it as 'whale'.\n    // dormancy reactivate: previously dormant wallet waking up.\n    await autoLabelWallets(env, targets, wh.chain, walletMap, walletInfo);",
  "    // Auto-label: if a wallet crosses 3 txs, label it as 'whale'.\n    // dormancy reactivate: previously dormant wallet waking up.\n    await autoLabelWallets(env, targets, wh.chain, walletMap, walletInfo);"
);

// ─── 3. rows_read instrumentation on the tick summary ────────────────
s = s.replace(
  "  // one batch of UPSERTs per tick — dashboards read these instead of raw scans\n  await flushRollups(env, acc);\n  return { chain, processed, newWhales: newlyCounted, primed: false };",
  "  // one batch of UPSERTS per tick — dashboards read these instead of raw scans\n  await flushRollups(env, acc);\n  return { chain, processed, newWhales: newlyCounted, primed: false, walletInfos: walletInfos.size };"
);
ok("3. tick summary instrumented");

fs.writeFileSync("src/scanner.js", s);
console.log("ALL OK");
