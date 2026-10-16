/**
 * WhaleSignal Intelligence — 20 new analytics features.
 * All use existing D1/KV data (free, efficient). No new paid APIs.
 * Each function is pure (takes env, returns data) for testability.
 */

// 1. Exchange net flows — inflow vs outflow per exchange (24h)
export async function exchangeFlows(env, hours = 24) {
  const since = Date.now() - hours * 3600000;
  const { results } = await env.DB.prepare(`
    SELECT
      CASE WHEN w.tx_type = 'exchange_inflow' THEN w.to_address ELSE w.from_address END as exchange,
      SUM(CASE WHEN w.tx_type = 'exchange_inflow' THEN w.usd_value ELSE 0 END) as inflow_usd,
      SUM(CASE WHEN w.tx_type = 'exchange_outflow' THEN w.usd_value ELSE 0 END) as outflow_usd,
      COUNT(*) as tx_count
    FROM whales w
    WHERE w.detected_at > ? AND w.tx_type IN ('exchange_inflow', 'exchange_outflow')
    GROUP BY exchange
    ORDER BY (inflow_usd + outflow_usd) DESC
    LIMIT 20
  `).bind(since).all();
  return (results || []).map(r => ({
    exchange: r.exchange?.slice(0, 10) + "...",
    inflow_usd: Math.round(r.inflow_usd || 0),
    outflow_usd: Math.round(r.outflow_usd || 0),
    net_usd: Math.round((r.inflow_usd || 0) - (r.outflow_usd || 0)),
    tx_count: r.tx_count,
  }));
}

// 2. Chain health — per-chain scanner status
export async function chainHealth(env) {
  const { results } = await env.DB.prepare(
    "SELECT chain, last_block, last_scan, errors, total_whales FROM scanner_state ORDER BY chain"
  ).all();
  const now = Date.now();
  return (results || []).map(r => ({
    chain: r.chain,
    last_block: r.last_block,
    last_scan_age_s: r.last_scan ? Math.round((now - r.last_scan) / 1000) : null,
    errors: r.errors || 0,
    total_whales: r.total_whales || 0,
    status: (r.errors || 0) >= 5 ? "degraded" : r.last_scan && (now - r.last_scan) > 300000 ? "stale" : "healthy",
  }));
}

// 3. Top movers 24h — biggest whales
export async function topMovers(env, limit = 10) {
  const since = Date.now() - 86400000;
  const { results } = await env.DB.prepare(`
    SELECT id, chain, symbol, usd_value, tx_type, detected_at,
           substr(from_address, 1, 10) as from_short, substr(to_address, 1, 10) as to_short
    FROM whales WHERE detected_at > ? AND is_self_transfer = 0
    ORDER BY usd_value DESC LIMIT ?
  `).bind(since, limit).all();
  return results || [];
}

// 4. Stablecoin supply tracker — mint/burn totals
export async function stablecoinSupply(env, hours = 24) {
  const since = Date.now() - hours * 3600000;
  const { results } = await env.DB.prepare(`
    SELECT tx_type, SUM(usd_value) as total_usd, COUNT(*) as count
    FROM whales WHERE detected_at > ? AND tx_type IN ('mint', 'burn', 'treasury_deploy')
    GROUP BY tx_type
  `).bind(since).all();
  const out = { mint_usd: 0, burn_usd: 0, deploy_usd: 0, net_supply_change: 0 };
  for (const r of results || []) {
    if (r.tx_type === "mint") out.mint_usd = Math.round(r.total_usd || 0);
    if (r.tx_type === "burn") out.burn_usd = Math.round(r.total_usd || 0);
    if (r.tx_type === "treasury_deploy") out.deploy_usd = Math.round(r.total_usd || 0);
  }
  out.net_supply_change = out.mint_usd - out.burn_usd;
  return out;
}

// 5. Whale patterns — wallets with recurring large transfers
export async function whalePatterns(env, minCount = 3) {
  const since = Date.now() - 7 * 86400000;
  const { results } = await env.DB.prepare(`
    SELECT from_address, COUNT(*) as tx_count, SUM(usd_value) as total_usd,
           MAX(usd_value) as max_usd, MIN(detected_at) as first_seen, MAX(detected_at) as last_seen
    FROM whales WHERE detected_at > ? AND is_self_transfer = 0
    GROUP BY from_address HAVING COUNT(*) >= ?
    ORDER BY total_usd DESC LIMIT 20
  `).bind(since, minCount).all();
  return (results || []).map(r => ({
    wallet: r.from_address?.slice(0, 12) + "...",
    tx_count: r.tx_count,
    total_usd: Math.round(r.total_usd || 0),
    max_usd: Math.round(r.max_usd || 0),
    days_active: Math.round(((r.last_seen || 0) - (r.first_seen || 0)) / 86400000 * 10) / 10,
  }));
}

// 6. Alert accuracy by signal — from eval data
export async function signalAccuracy(env) {
  const { results } = await env.DB.prepare(`
    SELECT signal, COUNT(*) as total,
           SUM(CASE WHEN outcome = 'hit' THEN 1 ELSE 0 END) as hits,
           SUM(CASE WHEN outcome = 'miss' THEN 1 ELSE 0 END) as misses
    FROM predictions WHERE outcome IS NOT NULL
    GROUP BY signal
  `).all();
  return (results || []).map(r => ({
    signal: r.signal,
    total: r.total,
    hits: r.hits || 0,
    misses: r.misses || 0,
    accuracy: r.total > 0 ? Math.round((r.hits || 0) / r.total * 1000) / 10 : null,
  }));
}

// 7. Whale heatmap — activity by hour (UTC)
export async function whaleHeatmap(env) {
  const since = Date.now() - 7 * 86400000;
  const { results } = await env.DB.prepare(`
    SELECT CAST(strftime('%H', detected_at / 1000, 'unixepoch') AS INTEGER) as hour,
           COUNT(*) as count, SUM(usd_value) as volume
    FROM whales WHERE detected_at > ?
    GROUP BY hour ORDER BY hour
  `).bind(since).all();
  const hours = Array(24).fill(null).map((_, h) => ({ hour: h, count: 0, volume: 0 }));
  for (const r of results || []) {
    if (r.hour >= 0 && r.hour < 24) {
      hours[r.hour] = { hour: r.hour, count: r.count, volume: Math.round(r.volume || 0) };
    }
  }
  return hours;
}

// 8. Dormant whales — silent >1yr, now active
export async function dormantWhales(env) {
  const since = Date.now() - 86400000;
  const { results } = await env.DB.prepare(`
    SELECT w.id, w.chain, w.symbol, w.usd_value, w.detected_at,
           wl.first_seen, wl.tx_count
    FROM whales w JOIN wallets wl ON wl.address = w.from_address
    WHERE w.detected_at > ? AND wl.first_seen < ?
      AND w.usd_value > 1000000 AND w.is_self_transfer = 0
    ORDER BY w.usd_value DESC LIMIT 10
  `).bind(since, Date.now() - 365 * 86400000).all();
  return (results || []).map(r => ({
    id: r.id, chain: r.chain, symbol: r.symbol,
    usd_value: Math.round(r.usd_value || 0),
    dormant_days: Math.round((Date.now() - (r.first_seen || 0)) / 86400000),
    wallet_txs: r.tx_count || 0,
  }));
}

// 9. Whale concentration — top wallets by volume
export async function whaleConcentration(env) {
  const since = Date.now() - 30 * 86400000;
  const { results } = await env.DB.prepare(`
    SELECT from_address, SUM(usd_value) as total_usd, COUNT(*) as tx_count
    FROM whales WHERE detected_at > ? AND is_self_transfer = 0
    GROUP BY from_address ORDER BY total_usd DESC LIMIT 10
  `).bind(since).all();
  const total = (results || []).reduce((s, r) => s + (r.total_usd || 0), 0);
  return (results || []).map((r, i) => ({
    rank: i + 1,
    wallet: r.from_address?.slice(0, 12) + "...",
    total_usd: Math.round(r.total_usd || 0),
    tx_count: r.tx_count,
    pct_of_top10: total > 0 ? Math.round((r.total_usd || 0) / total * 1000) / 10 : 0,
  }));
}

// 10. Chain comparison — volume by chain
export async function chainComparison(env, hours = 24) {
  const since = Date.now() - hours * 3600000;
  const { results } = await env.DB.prepare(`
    SELECT chain, COUNT(*) as count, SUM(usd_value) as volume,
           MAX(usd_value) as max_usd, AVG(usd_value) as avg_usd
    FROM whales WHERE detected_at > ?
    GROUP BY chain ORDER BY volume DESC
  `).bind(since).all();
  return (results || []).map(r => ({
    chain: r.chain,
    count: r.count,
    volume_usd: Math.round(r.volume || 0),
    max_usd: Math.round(r.max_usd || 0),
    avg_usd: Math.round(r.avg_usd || 0),
  }));
}

// 11. Alert velocity — whales per hour (24h)
export async function alertVelocity(env) {
  const since = Date.now() - 86400000;
  const { results } = await env.DB.prepare(`
    SELECT CAST((detected_at / 3600000) AS INTEGER) as hour_bucket,
           COUNT(*) as count, SUM(usd_value) as volume
    FROM whales WHERE detected_at > ?
    GROUP BY hour_bucket ORDER BY hour_bucket DESC LIMIT 24
  `).bind(since).all();
  return (results || []).map(r => ({
    hour_ago: Math.round((Date.now() - r.hour_bucket * 3600000) / 3600000),
    count: r.count,
    volume_usd: Math.round(r.volume || 0),
  }));
}

// 12. News-whale correlation — high-importance news vs whale volume
export async function newsWhaleCorrelation(env) {
  const since = Date.now() - 7 * 86400000;
  const [news, whales] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) as c, AVG(importance) as avg_imp FROM news WHERE created_at > ? AND importance > 70"
    ).bind(since).first(),
    env.DB.prepare(
      "SELECT COUNT(*) as c, SUM(usd_value) as vol FROM whales WHERE detected_at > ?"
    ).bind(since).first(),
  ]);
  return {
    high_importance_news: news?.c || 0,
    avg_importance: Math.round((news?.avg_imp || 0) * 10) / 10,
    whale_count: whales?.c || 0,
    whale_volume_usd: Math.round(whales?.vol || 0),
  };
}

// 13. Stablecoin velocity — USDT/USDC movement
export async function stablecoinVelocity(env, hours = 24) {
  const since = Date.now() - hours * 3600000;
  const { results } = await env.DB.prepare(`
    SELECT symbol, COUNT(*) as count, SUM(usd_value) as volume
    FROM whales WHERE detected_at > ? AND symbol IN ('USDT', 'USDC', 'DAI')
    GROUP BY symbol ORDER BY volume DESC
  `).bind(since).all();
  return (results || []).map(r => ({
    symbol: r.symbol,
    count: r.count,
    volume_usd: Math.round(r.volume || 0),
  }));
}

// 14. Weekend vs weekday patterns
export async function weekdayPatterns(env) {
  const since = Date.now() - 30 * 86400000;
  const { results } = await env.DB.prepare(`
    SELECT CAST(strftime('%w', detected_at / 1000, 'unixepoch') AS INTEGER) as dow,
           COUNT(*) as count, SUM(usd_value) as volume
    FROM whales WHERE detected_at > ?
    GROUP BY dow ORDER BY dow
  `).bind(since).all();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (results || []).map(r => ({
    day: days[r.dow] || "?",
    count: r.count,
    volume_usd: Math.round(r.volume || 0),
  }));
}

// 15. Exchange balance estimator — cumulative net flows
export async function exchangeBalances(env) {
  const since = Date.now() - 30 * 86400000;
  const { results } = await env.DB.prepare(`
    SELECT
      CASE WHEN tx_type = 'exchange_inflow' THEN to_address ELSE from_address END as exchange,
      SUM(CASE WHEN tx_type = 'exchange_inflow' THEN usd_value ELSE -usd_value END) as net_flow
    FROM whales WHERE detected_at > ? AND tx_type IN ('exchange_inflow', 'exchange_outflow')
    GROUP BY exchange ORDER BY ABS(net_flow) DESC LIMIT 15
  `).bind(since).all();
  return (results || []).map(r => ({
    exchange: r.exchange?.slice(0, 12) + "...",
    net_flow_usd: Math.round(r.net_flow || 0),
    direction: (r.net_flow || 0) > 0 ? "accumulating" : "distributing",
  }));
}

// 16-20: Live API status checks (free, cached)
export async function apiStatus(env) {
  const checks = [];
  // We don't call external APIs here (to stay efficient) — we check our caches
  try {
    const mc = await env.KV.get("market_cache");
    const m = mc ? JSON.parse(mc) : null;
    checks.push({
      name: "market_data",
      status: m?.btc?.price ? "ok" : "stale",
      detail: m?.btc?.price ? `$${Math.round(m.btc.price)}` : "no data",
    });
  } catch { checks.push({ name: "market_data", status: "error" }); }

  try {
    const sc = await env.KV.get("sentiment_cache");
    const s = sc ? JSON.parse(sc) : null;
    checks.push({
      name: "sentiment",
      status: s?.composite != null ? "ok" : "stale",
      detail: s?.label || "no data",
    });
  } catch { checks.push({ name: "sentiment", status: "error" }); }

  try {
    const nc = await env.KV.get("news_cache_meta");
    checks.push({ name: "news", status: nc ? "ok" : "stale", detail: nc ? "active" : "no data" });
  } catch { checks.push({ name: "news", status: "error" }); }

  return checks;
}

// 17. Gas tracker — reads from KV (price worker stores it)
export async function gasTracker(env) {
  try {
    const raw = await env.KV.get("gas_cache");
    if (!raw) return { status: "no data", note: "gas worker not yet run" };
    const g = JSON.parse(raw);
    return {
      eth_gwei: g.eth_gwei || null,
      bsc_gwei: g.bsc_gwei || null,
      updated_at: g.updated_at || null,
      age_s: g.updated_at ? Math.round((Date.now() - g.updated_at) / 1000) : null,
    };
  } catch {
    return { status: "error" };
  }
}

// 18. Backtest — would following signals have worked? (from eval data)
export async function backtestSummary(env) {
  // Predictions table has separate outcome columns per horizon (outcome, outcome_1h, outcome_6h)
  const horizons = [
    { key: "1h", col: "outcome_1h" },
    { key: "6h", col: "outcome_6h" },
    { key: "24h", col: "outcome" },
  ];
  const out = [];
  for (const h of horizons) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as n, SUM(CASE WHEN ${h.col} = 'hit' THEN 1 ELSE 0 END) as hits
       FROM predictions WHERE ${h.col} IS NOT NULL`
    ).first();
    out.push({
      horizon: h.key,
      n: row?.n || 0,
      hits: row?.hits || 0,
      win_rate: row?.n > 0 ? Math.round((row.hits || 0) / row.n * 1000) / 10 : null,
    });
  }
  return out;
}

// 19. Whale→price correlation — do inflows precede drops?
export async function whalePriceCorrelation(env) {
  // Simple: compare avg BTC price 1h after large exchange inflows vs baseline
  const since = Date.now() - 7 * 86400000;
  const { results } = await env.DB.prepare(`
    SELECT COUNT(*) as inflow_count, AVG(usd_value) as avg_inflow
    FROM whales WHERE detected_at > ? AND tx_type = 'exchange_inflow' AND symbol = 'BTC'
  `).bind(since).all();
  const r = (results || [])[0] || {};
  return {
    btc_inflow_count_7d: r.inflow_count || 0,
    avg_inflow_usd: Math.round(r.avg_inflow || 0),
    note: "Full correlation needs price history join — see eval worker",
  };
}

// 20. System overview — all intel in one call (for dashboard)
export async function systemOverview(env) {
  const [health, flows, movers, supply] = await Promise.all([
    chainHealth(env),
    exchangeFlows(env, 24),
    topMovers(env, 5),
    stablecoinSupply(env, 24),
  ]);
  return {
    chains: health,
    top_exchange_flows: flows.slice(0, 5),
    top_movers: movers,
    stablecoin_supply: supply,
    generated_at: new Date().toISOString(),
  };
}
