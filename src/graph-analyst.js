// src/graph-analyst.js
// Forensic Wallet Graph & Deception / Laundering Pattern Detection Engine.
// Analyzes money flow graphs, identifies counterparty networks, and detects
// deceptive behavior (wash trading, peeling chains, smurfing, panic selling, smart accumulation, news reactions).
//
// TAXONOMY PRECEDENCE (E2): this module owns *deception* detection (wash
// loops, peeling chains, structuring). Direction calls ("is this wallet
// accumulating or distributing?") belong to walletBehavior() in analyst.js,
// which is the single canonical behavior classifier fed to the LLM. The
// behavioral_profile computed here is kept for the graph/dashboard endpoints
// but is intentionally NOT emitted into the analyst prompt alongside it.

import { shortAddr, fmtUSD } from "./worker-utils.js";

const NEWS_CATALYST_KEYWORDS = [
  "sec", "etf", "fed", "rate cut", "interest rate", "inflation", "cpi",
  "hack", "exploit", "insolvent", "liquidation", "ban", "crackdown",
  "lawsuit", "approval", "treasury", "binance", "tether", "doj"
];

/**
 * Pure function: Detect fraud, wash trading, peeling chains, structuring,
 * and behavioral profiles from a wallet's transaction history.
 *
 * @param {Array<object>} txs — transactions involving this wallet
 * @param {string} targetAddress — the wallet address under inspection
 * @param {object|null} market — cached market context (fear & greed, prices)
 * @param {Array<object>|object|null} news — cached news headlines
 * @returns {object} forensic analysis and deception metrics
 */
export function analyzeWalletPatterns(txs, targetAddress, market = null, news = null) {
  // Addresses are stored consistently per chain (EVM lowercase, Solana case-preserved).
  // Do NOT lowercase here — breaks Solana base58.
  const target = String(targetAddress || "");
  const allTxs = Array.isArray(txs) ? txs : [];

  let totalInflowUSD = 0;
  let totalOutflowUSD = 0;
  let exchangeInflowUSD = 0;
  let exchangeOutflowUSD = 0;
  let walletToWalletUSD = 0;

  const counterparties = new Map();
  const washLoops = [];
  const outflows = [];
  const flags = [];
  const deceptionReasons = [];

  // 1. Process flows and counterparties
  for (const t of allTxs) {
    const from = String(t.from_address || "");
    const to = String(t.to_address || "");
    const usd = Number(t.usd_value) || 0;
    const isSender = from === target;
    const otherAddr = isSender ? to : from;

    if (isSender) {
      totalOutflowUSD += usd;
      outflows.push(t);
      if (t.tx_type === "exchange_inflow") exchangeInflowUSD += usd;
      else if (t.tx_type === "wallet_to_wallet") walletToWalletUSD += usd;
    } else {
      totalInflowUSD += usd;
      if (t.tx_type === "exchange_outflow") exchangeOutflowUSD += usd;
      else if (t.tx_type === "wallet_to_wallet") walletToWalletUSD += usd;
    }

    if (otherAddr) {
      if (!counterparties.has(otherAddr)) {
        counterparties.set(otherAddr, {
          address: otherAddr,
          sent_usd: 0,
          received_usd: 0,
          tx_count: 0,
          tx_types: new Set(),
        });
      }
      const cp = counterparties.get(otherAddr);
      cp.tx_count++;
      if (isSender) cp.sent_usd += usd;
      else cp.received_usd += usd;
      if (t.tx_type) cp.tx_types.add(t.tx_type);
    }
  }

  // 2. Detect Wash Trading (Round-trip flows A -> B -> A with similar amounts)
  for (const [cpAddr, cp] of counterparties.entries()) {
    if (cp.sent_usd > 0 && cp.received_usd > 0) {
      const minVal = Math.min(cp.sent_usd, cp.received_usd);
      const maxVal = Math.max(cp.sent_usd, cp.received_usd);
      const ratio = minVal / maxVal;
      // If returning over 70% of funds between same two wallets ($500k+)
      if (ratio >= 0.70 && minVal >= 500_000) {
        washLoops.push({
          counterparty: cpAddr,
          sent_to_cp_usd: cp.sent_usd,
          received_from_cp_usd: cp.received_usd,
          match_ratio: Math.round(ratio * 100) / 100,
        });
      }
    }
  }

  // 3. Detect Peeling Chains / Layering (Multiple outflows to fresh single-use addresses)
  let singleTxCounterparties = 0;
  for (const cp of counterparties.values()) {
    if (cp.tx_count === 1 && cp.sent_usd > 0) {
      singleTxCounterparties++;
    }
  }
  const isPeelingChain = singleTxCounterparties >= 4 && (singleTxCounterparties / Math.max(1, counterparties.size)) > 0.6;

  // 4. Detect Structuring / Intent Camouflage (Rapid split transfers of similar sizes)
  let isStructuring = false;
  if (outflows.length >= 3) {
    // Check if 3+ outflows occurred within a 2-hour window with similar USD values (within 30%)
    const sortedOut = [...outflows].sort((a, b) => (a.detected_at || 0) - (b.detected_at || 0));
    for (let i = 0; i <= sortedOut.length - 3; i++) {
      const windowStart = sortedOut[i].detected_at || 0;
      const windowEnd = sortedOut[i + 2].detected_at || 0;
      const timeDiff = Math.abs(windowEnd - windowStart);
      if (timeDiff <= 2 * 3600 * 1000) { // within 2 hours
        const v0 = Number(sortedOut[i].usd_value) || 0;
        const v1 = Number(sortedOut[i + 1].usd_value) || 0;
        const v2 = Number(sortedOut[i + 2].usd_value) || 0;
        const minV = Math.min(v0, v1, v2);
        const maxV = Math.max(v0, v1, v2);
        if (minV > 500_000 && minV / maxV >= 0.65) {
          isStructuring = true;
          break;
        }
      }
    }
  }

  // 5. News Catalyst Correlation — word boundaries so "ban" doesn't match
  // "urban" and "tether" doesn't match "tethered". Time-window filtering is
  // the caller's job (headlines are pre-filtered upstream).
  const headlines = Array.isArray(news) ? news : Array.isArray(news?.headlines) ? news.headlines : [];
  const matchedCatalysts = [];
  const kwPatterns = NEWS_CATALYST_KEYWORDS.map((kw) => ({
    kw,
    re: new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  }));
  for (const h of headlines) {
    const title = String(h?.title || "");
    for (const { kw, re } of kwPatterns) {
      if (re.test(title)) {
        matchedCatalysts.push({ keyword: kw, title: h.title });
        break;
      }
    }
  }

  // 6. Behavioral Profiling (Panic Seller vs Smart Accumulator vs News Chaser)
  const fg = market?.fear_greed != null ? Number(market.fear_greed) : 50;
  let behavioralProfile = "neutral_trader";

  if (exchangeOutflowUSD > exchangeInflowUSD * 2 && exchangeOutflowUSD >= 1_000_000) {
    if (fg <= 30) {
      behavioralProfile = "smart_accumulator";
      flags.push("ACCUMULATION_DURING_EXTREME_FEAR");
    } else {
      behavioralProfile = "exchange_withdrawer";
      flags.push("COLD_STORAGE_OUTFLOW");
    }
  } else if (exchangeInflowUSD > exchangeOutflowUSD * 2 && exchangeInflowUSD >= 1_000_000) {
    if (fg <= 30) {
      behavioralProfile = "panic_seller";
      flags.push("PANIC_DEPOSIT_DURING_FEAR");
    } else if (fg >= 70) {
      behavioralProfile = "top_distributor";
      flags.push("PROFIT_TAKING_DURING_GREED");
    } else {
      behavioralProfile = "active_distributor";
      flags.push("EXCHANGE_DEPOSITOR");
    }
  } else if (walletToWalletUSD > (exchangeInflowUSD + exchangeOutflowUSD) * 3) {
    behavioralProfile = "otc_custodian";
    flags.push("PRIVATE_TRANSFER_CLUSTER");
  }

  if (matchedCatalysts.length > 0 && allTxs.length > 0) {
    flags.push(`NEWS_CATALYST_ALIGNMENT (${matchedCatalysts[0].keyword})`);
  }

  // 7. Deception Score Calculation (0 to 100)
  let deceptionScore = 0;
  if (washLoops.length > 0) {
    const washImpact = Math.min(60, washLoops.length * 30);
    deceptionScore += washImpact;
    flags.push("SUSPECTED_WASH_TRADING");
    deceptionReasons.push(`Round-trip volume loops detected with ${washLoops.length} counterparty wallet(s)`);
  }
  if (isPeelingChain) {
    deceptionScore += 25;
    flags.push("PEELING_CHAIN_LAYERING");
    deceptionReasons.push(`Funds distributed across ${singleTxCounterparties} single-use intermediary addresses`);
  }
  if (isStructuring) {
    deceptionScore += 15;
    flags.push("RAPID_STRUCTURING_SPLIT");
    deceptionReasons.push("Multiple similar-sized transfers dispatched rapidly to conceal total volume");
  }

  deceptionScore = Math.min(100, deceptionScore);

  // Forensic honesty: a 0/100 from a handful of transactions is absence of
  // data, not a clean bill of health. Positive detections are still reported
  // on small windows; only the "all clear" claim requires enough history.
  const lowData = allTxs.length < 10;
  const hasDetections = deceptionScore > 0;

  let deceptionRisk;
  if (hasDetections) {
    deceptionRisk = deceptionScore >= 50 ? "high" : deceptionScore >= 25 ? "medium" : "low";
  } else {
    deceptionRisk = lowData ? "unknown" : "low";
  }

  if (deceptionScore > 65) {
    flags.push("HIGH_DECEPTION_RISK");
  } else if (deceptionScore === 0 && !lowData) {
    flags.push("ORGANIC_ONCHAIN_FLOW");
  }
  if (lowData && !hasDetections) {
    flags.push("INSUFFICIENT_HISTORY");
  }

  // Summary human explanation
  let intentSummary = lowData && !hasDetections
    ? "Insufficient transaction history to assess deception patterns."
    : "Standard on-chain activity without deception markers.";
  if (washLoops.length > 0) {
    intentSummary = `High deception: Wallet exhibits wash trading behavior, circulating funds with ${washLoops[0].counterparty} to create artificial volume.`;
  } else if (isPeelingChain) {
    intentSummary = "Layering detected: Funds are being peeled across single-use addresses, consistent with money laundering or privacy obfuscation.";
  } else if (behavioralProfile === "smart_accumulator") {
    intentSummary = "Smart Money: Aggressively withdrawing liquidity from exchanges into self-custody while market sentiment is in Extreme Fear.";
  } else if (behavioralProfile === "panic_seller") {
    intentSummary = "Fear capitulation: Depositing large sums into exchanges for liquidation during a market panic selloff.";
  } else if (behavioralProfile === "top_distributor") {
    intentSummary = "Profit taking: Whales offloading assets to exchanges during Extreme Greed peaks.";
  }

  return {
    address: target,
    metrics: {
      total_inflow_usd: totalInflowUSD,
      total_outflow_usd: totalOutflowUSD,
      net_flow_usd: totalInflowUSD - totalOutflowUSD,
      unique_counterparties: counterparties.size,
      wash_loops_detected: washLoops.length,
      single_use_destinations: singleTxCounterparties,
    },
    behavioral_profile: behavioralProfile,
    deception_score: deceptionScore,
    deception_risk: deceptionRisk,
    wash_loops: washLoops,
    is_peeling_chain: isPeelingChain,
    is_structuring: isStructuring,
    news_catalysts: matchedCatalysts.slice(0, 3),
    flags,
    deception_reasons: deceptionReasons,
    intent_summary: intentSummary,
  };
}

/**
 * Build graph nodes and links for an address from the D1 database.
 * Pure response shape builder.
 *
 * @param {Array<object>} txs — transactions from whales table
 * @param {Map<string, object>} walletMap — known labels map
 * @param {string} rootAddress — center of graph
 * @returns {object} { nodes, links, metrics }
 */
export function buildGraphPayload(txs, walletMap, rootAddress) {
  const root = String(rootAddress || "").toLowerCase();
  const nodesMap = new Map();
  const linksMap = new Map();
  let totalGraphVolumeUSD = 0;

  // Ensure root node exists
  const rootInfo = walletMap?.get ? walletMap.get(root) : walletMap?.[root];
  nodesMap.set(root, {
    id: root,
    label: rootInfo?.label || shortAddr(root),
    type: rootInfo?.type || "whale",
    is_root: true,
    inflow_usd: 0,
    outflow_usd: 0,
    net_flow_usd: 0,
  });

  for (const t of txs || []) {
    const from = String(t.from_address || "").toLowerCase();
    const to = String(t.to_address || "").toLowerCase();
    const usd = Number(t.usd_value) || 0;
    if (!from || !to) continue;

    totalGraphVolumeUSD += usd;

    // Register nodes
    if (!nodesMap.has(from)) {
      const info = walletMap?.get ? walletMap.get(from) : walletMap?.[from];
      nodesMap.set(from, {
        id: from,
        label: info?.label || shortAddr(from),
        type: info?.type || "unknown",
        is_root: from === root,
        inflow_usd: 0,
        outflow_usd: 0,
        net_flow_usd: 0,
      });
    }
    if (!nodesMap.has(to)) {
      const info = walletMap?.get ? walletMap.get(to) : walletMap?.[to];
      nodesMap.set(to, {
        id: to,
        label: info?.label || shortAddr(to),
        type: info?.type || "unknown",
        is_root: to === root,
        inflow_usd: 0,
        outflow_usd: 0,
        net_flow_usd: 0,
      });
    }

    nodesMap.get(from).outflow_usd += usd;
    nodesMap.get(to).inflow_usd += usd;

    // Register directed link
    const linkKey = `${from}->${to}`;
    if (!linksMap.has(linkKey)) {
      linksMap.set(linkKey, {
        source: from,
        target: to,
        usd_value: 0,
        count: 0,
        symbol: t.symbol || "USD",
        chain: t.chain || "eth",
      });
    }
    const link = linksMap.get(linkKey);
    link.usd_value += usd;
    link.count++;
  }

  for (const node of nodesMap.values()) {
    node.net_flow_usd = node.inflow_usd - node.outflow_usd;
  }

  return {
    root_address: root,
    nodes: Array.from(nodesMap.values()),
    links: Array.from(linksMap.values()),
    node_count: nodesMap.size,
    link_count: linksMap.size,
    total_graph_volume_usd: totalGraphVolumeUSD,
  };
}
