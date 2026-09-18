// src/analyst.js
// Queue consumer. Receives { whale_id, chain } from scanner, fetches the
// whale tx + market cache + recent wallet history from D1/KV, constructs a
// Gemini prompt, stores the AI analysis, then queues a "send alert" message
// to the bot worker. NEVER touches Telegram directly — only the bot does.
//
// This worker is the slow one: a Gemini call can take 3-5s. That's why it
// is a queue consumer, not a cron handler — Queues give a larger wall-time
// envelope than cron triggers on Workers free.
//
// Bindings (env):
//   DB       — D1
//   KV       — KV (market_cache, news_cache)
//   BOTQ     — Queue to bot
//   GEMINI_KEY — Gemini API key (set via `wrangler secret put`)
//
// Failure model: if Gemini fails or returns garbage, we mark the whale's
// analysis_status='failed' and DO NOT retry (the queue has max_retries=3 by
// default; we ack the message by resolving the handler). If we start seeing
// failures we'll add gpt-3.5-turbo as a fallback in Phase 3.

import { fetchJSON, fmtUSD, shortAddr } from "./worker-utils.js";
import { taSnapshot, regimeAlignment } from "./ta.js";

// ─── confluence model (docs/SIGNAL_MODEL.md) ──────────────────────────

/**
 * Chart + news context for the confluence model. Two small D1 reads.
 * All optional — missing context just means fewer features in the composite.
 */
// Fitted confluence weights (config:flow_weights, written by the laptop
// research loop) — isolate-cached 5 min. Missing/invalid → defaults.
let weightsCache = { w: null, ts: 0 };
async function loadFlowWeights(env) {
  if (weightsCache.w && Date.now() - weightsCache.ts < 300_000) return weightsCache.w;
  let w = null;
  try { w = JSON.parse(await env.KV.get("config:flow_weights") || "null"); } catch {}
  weightsCache = { w: sanitizeWeights(w), ts: Date.now() };
  return weightsCache.w;
}

// Isolate-level cache: 400-row price read per analyzed event was wasteful
// when a queue batch analyzes several events from the same chain in seconds.
const ctxCache = new Map(); // chain → { ctx, ts }
const CTX_TTL_MS = 60_000;

export async function getMarketContext(env, chain, symbol) {
  const coin = String(chain || "").toLowerCase() === "eth" ? "eth" : "btc";
  const hit = ctxCache.get(coin);
  if (hit && Date.now() - hit.ts < CTX_TTL_MS) return hit.ctx;
  let ta = null;
  try {
    const { results } = await env.DB.prepare(
      "SELECT ts, price FROM price_history WHERE coin = ? ORDER BY ts DESC LIMIT 400"
    ).bind(coin).all();
    if (results && results.length >= 51) {
      ta = taSnapshot(results.slice().reverse());
    }
  } catch { /* no price history yet */ }
  let newsSent = null;
  try {
    const sym = String(symbol || "").toUpperCase();
    if (sym) {
      const row = await env.DB.prepare(
        "SELECT SUM(sentiment) AS s, COUNT(*) AS n FROM news WHERE first_seen > ? AND symbols LIKE ?"
      ).bind(Date.now() - 6 * 3600_000, "%" + sym + "%").first();
      if (row && row.n > 0 && row.s != null) newsSent = { sum: row.s, n: row.n };
    }
  } catch { /* no news yet */ }
  const out = { ta, newsSent };
  ctxCache.set(coin, { ctx: out, ts: Date.now() });
  return out;
}

/**
 * The WhaleSignal confluence model (weights documented in
 * docs/SIGNAL_MODEL.md). Additive, explainable adjustments over a 0.60 base
 * — one term per research-backed signal category:
 *   on-chain flow      (primary evidence, the direction itself)
 *   on-chain behavior  (wallet history supporting/conflicting)
 *   on-chain sizing    (transfer vs this wallet's own average)
 *   technical regime   (tape agrees/conflicts — RSI/EMA from src/ta.js)
 *   sentiment          (F&G regime + asset news sentiment)
 * Hard bounds [0.50, 0.85]; huge unlabeled flows cap at 0.55 (treasury-
 * migration risk). Pure. Returns { confidence, features[] } so every alert
 * can show its own reasoning.
 */
const DEFAULT_WEIGHTS = { fg: 0.05, history: 0.05, tape: 0.08, size: 0.05, news: 0.05, derivs: 0.05 };

/**
 * weights override: config:flow_weights (KV JSON) replaces defaults —
 * written by the laptop research loop from graded-ledger fits (RESEARCH.md).
 * Unknown/oversized weights are ignored.
 */
export function sanitizeWeights(w) {
  const out = {};
  if (!w || typeof w !== "object") return out;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const v = Number(w[k]);
    if (Number.isFinite(v) && v >= 0 && v <= 0.12) out[k] = v;
  }
  return out;
}

export function flowConfidence({
  bullish, fgRegime = null, behavior = null, sizeRatio = null,
  taRegime = null, newsSent = null, derivs = null, hugeUnlabeled = false, weights = null,
}) {
  const W = { ...DEFAULT_WEIGHTS, ...sanitizeWeights(weights) };
  const adj = [];
  let c = 0.60;

  if (fgRegime === (bullish ? "greed" : "fear")) { c += W.fg; adj.push("F&G agrees +" + W.fg); }
  else if (fgRegime === (bullish ? "fear" : "greed")) { c -= W.fg; adj.push("F&G conflicts −" + W.fg); }

  if (bullish && behavior === "accumulation") { c += W.history; adj.push("wallet history agrees +" + W.history); }
  else if (!bullish && behavior === "distribution") { c += W.history; adj.push("wallet history agrees +" + W.history); }
  else if ((bullish && behavior === "distribution") || (!bullish && behavior === "accumulation")) {
    c -= W.history; adj.push("wallet history conflicts −" + W.history);
  }

  const align = regimeAlignment(taRegime, bullish);
  if (align === 1) { c += W.tape; adj.push("tape agrees +" + W.tape); }
  else if (align === -1) { c -= W.tape; adj.push("tape conflicts −" + W.tape); }

  if (sizeRatio != null && sizeRatio >= 5) { c += W.size; adj.push(`size ${sizeRatio.toFixed(1)}× usual +${W.size}`); }
  else if (sizeRatio != null && sizeRatio <= 0.25) { c -= W.size; adj.push(`size ${sizeRatio.toFixed(1)}× usual −${W.size}`); }

  if (newsSent && newsSent.n >= 2) {
    const s = Math.sign(newsSent.sum);
    if ((bullish && s > 0) || (!bullish && s < 0)) { c += W.news; adj.push("news agrees +" + W.news); }
    else if ((bullish && s < 0) || (!bullish && s > 0)) { c -= W.news; adj.push("news conflicts −" + W.news); }
  }

  // derivatives crowding (contrarian — the 2026 regime papers treat funding
  // as a state variable): |funding| > 0.03%/8h means a crowded side, which a
  // flow in the SAME direction fights, and a flow against it confirms.
  if (derivs && derivs.funding != null) {
    const f = Number(derivs.funding);
    if (f > 0.0003) {
      if (bullish) { c -= 0.05; adj.push("crowded longs \u22120.05"); }
      else { c += 0.05; adj.push("longs crowded +0.05"); }
    } else if (f < -0.0003) {
      if (bullish) { c += 0.05; adj.push("shorts crowded +0.05"); }
      else { c -= 0.05; adj.push("crowded shorts \u22120.05"); }
    }
  }

  c = Math.max(0.50, Math.min(0.85, c));
  if (hugeUnlabeled) c = Math.min(c, 0.55);
  return { confidence: Math.round(c * 100) / 100, features: adj };
}

// ─── prompt building (pure, testable) ─────────────────────────────────

/**
 * Classify the market regime from the Fear & Greed index.
 * Pure. Returns 'fear' | 'greed' | 'neutral' | 'unknown'.
 */
export function marketRegime(market) {
  if (!market) return "unknown";
  const fg = market.fear_greed;
  if (fg == null) return "unknown";
  if (fg < 50) return "fear";
  if (fg >= 75) return "greed";
  return "neutral";
}

/**
 * Derive the wallet's historical behavior from its recent tx history.
 * Pure. Returns 'accumulation' | 'distribution' | 'mixed' | 'unknown'.
 * accumulation = mostly outflow from exchanges (buying/holding)
 * distribution = mostly inflow to exchanges (selling)
 */
export function walletBehavior(history) {
  if (!history || history.length === 0) return "unknown";
  let inflows = 0, outflows = 0;
  for (const h of history) {
    if (h.tx_type === "exchange_inflow") inflows++;
    else if (h.tx_type === "exchange_outflow") outflows++;
  }
  if (inflows >= 2 && inflows > outflows) return "distribution";
  if (outflows >= 2 && outflows > inflows) return "accumulation";
  if (inflows > 0 || outflows > 0) return "mixed";
  return "unknown";
}

/**
 * Pure: how does this transfer size compare to the wallet's recent history?
 * Returns the ratio (current / avg prior size) or null without ≥2 rows.
 * A $5M deposit from a wallet that usually moves $200K is a different story
 * than the same deposit from a wallet that moves $50M routinely.
 */
export function sizeVsHistory(usd, history) {
  const rows = (history || []).filter((h) => Number(h?.usd_value) > 0);
  if (rows.length < 2) return null;
  const avg = rows.reduce((s, h) => s + Number(h.usd_value), 0) / rows.length;
  if (!(avg > 0)) return null;
  return (Number(usd) || 0) / avg;
}

/**
 * Try to analyze a whale without calling Gemini. Returns a normalized
 * analysis object if the case is obvious enough, or null if ambiguous.
 * Pure (no I/O, no API calls).
 *
 * Direction semantics (research-grounded, per CryptoQuant/Nansen):
 *  - BTC/ETH inflow → bearish (native-asset deposits = sell-side supply)
 *  - BTC/ETH outflow → bullish (self-custody withdrawal = accumulation)
 *  - STABLECOIN INVERTS: USDT/USDC/DAI inflow → bullish ("dry powder"
 *    staging on exchanges), outflow → bearish (buying power leaving).
 *    Caveat: stables arriving from DeFi exits can be risk-off, not
 *    fresh capital — the interpretation text says so.
 *  - exchange_internal → neutral; wallet_to_wallet small → neutral
 *
 * Flow direction is the primary evidence; market regime, wallet history
 * and size-vs-history modulate confidence (0.5-0.85).
 */
export function templateAnalysis(whale, market, history, ctx = null) {
  if (!whale) return null;
  const regime = marketRegime(market);
  const behavior = walletBehavior(history);
  const usd = whale.usd_value ?? 0;
  const sym = (whale.symbol ?? "").toUpperCase();
  const isStable = (sym === "USDT" || sym === "USDC" || sym === "DAI");

  // Exchange internal = always neutral, high confidence. It's just routing.
  if (whale.tx_type === "exchange_internal") {
    return {
      headline: `${fmtUSD(usd)} ${sym} moved between exchange wallets`,
      interpretation: "Exchange-internal transfer — this is operational routing between exchange hot and cold wallets, not a whale sell or buy signal.",
      signal: "neutral",
      confidence: 0.90,
      related_factor: "Exchange internal routing",
      context_relevance: "low",
    };
  }

  // Directional exchange flows — scored by the confluence model
  // (flowConfidence below; docs/SIGNAL_MODEL.md). Native assets and
  // stablecoins read OPPOSITE:
  //   BTC/ETH  inflow → bearish (sell-side supply) · outflow → bullish (accumulation)
  //   USDT/DC  inflow → bullish (dry powder staging) · outflow → bearish (powder leaving)
  if (whale.tx_type === "exchange_inflow" || whale.tx_type === "exchange_outflow") {
    const isIn = whale.tx_type === "exchange_inflow";
    const bullish = isStable ? isIn : !isIn;
    const sizeRatio = sizeVsHistory(usd, history);
    const hugeUnlabeled = usd >= 100_000_000;
    const { confidence, features } = flowConfidence({
      bullish,
      fgRegime: regime,
      behavior,
      sizeRatio,
      taRegime: ctx?.ta?.regime ?? null,
      newsSent: ctx?.newsSent ?? null,
      derivs: ctx?.derivs ?? null,
      weights: ctx?.weights ?? null,
      hugeUnlabeled,
    });

    const stableNote = isStable
      ? (isIn ? " Stablecoins arriving on exchanges are typically deployable buying power (dry powder), the inverse of native-asset deposits. Caveat: stables exiting DeFi can signal risk-off instead of fresh capital."
             : " Stablecoins leaving exchanges drain deployable buying power — the inverse of native-asset withdrawals.")
      : (isIn ? "Exchange inflows often precede selling, especially when the wallet has shown prior distribution behavior."
              : "Exchange outflows often signal self-custody and accumulation, especially when the wallet has shown this pattern before.");
    const caveat = hugeUnlabeled ? " Caveat: very large transfers with unlabeled counterparties are frequently exchange treasury migrations, not genuine directional flow." : "";
    const sizeNote = sizeRatio != null && sizeRatio >= 5 ? ` Transfer is ${sizeRatio.toFixed(1)}× this wallet's recent average — unusually large for it.` : "";
    const tapeNote = ctx?.ta?.regime && ctx.ta.regime !== "unknown"
      ? ` Tape: ${ctx.ta.regime} (RSI14 ${ctx.ta.rsi14}).` : "";
    const confluence = features.length ? ` Confluence: ${features.join("; ")}.` : "";

    return {
      headline: bullish
        ? `${fmtUSD(usd)} ${sym} ${isIn ? "staged on exchange" : "withdrawn from exchange"}`
        : `${fmtUSD(usd)} ${sym} ${isIn ? "deposited to exchange" : "withdrawn from exchange"}`,
      interpretation: `Whale ${isIn ? "deposited" : "withdrew"} ${fmtUSD(usd)} ${sym} ${isIn ? "to" : "from"} an exchange.${stableNote}${sizeNote}${tapeNote}${caveat}${confluence}`,
      signal: bullish ? "bullish" : "bearish",
      confidence,
      related_factor: `${isStable ? "Stablecoin" : sym} exchange ${isIn ? "inflow" : "outflow"} — ${features.length ? features[0] : "flow direction"}`,
    };
  }

  // Small stablecoin wallet-to-wallet = neutral, low interest
  if (whale.tx_type === "wallet_to_wallet" && isStable && usd < 5_000_000) {
    return {
      headline: `${fmtUSD(usd)} ${sym} wallet-to-wallet transfer`,
      interpretation: "Stablecoin moved between private wallets. No exchange involvement visible. This is likely OTC settlement or internal treasury management — no immediate market impact expected.",
      signal: "neutral",
      confidence: 0.50,
      related_factor: "Wallet-to-wallet stablecoin transfer",
      context_relevance: "low",
    };
  }

  // ── supply operations (mint / burn) ──
  // Facts only: new supply entered or left circulation. Direction claims
  // ("prints precede pumps") need more context than one tx provides, so the
  // template stays neutral and lets the destination/exchange facts speak.
  if (whale.tx_type === "mint") {
    return {
      headline: `${fmtUSD(usd)} ${sym} newly minted`,
      interpretation: `New ${sym} tokens were created (${fmtUSD(usd)}). This increases circulating supply. Watch where these tokens move next — deposits to exchanges after a large mint are historically read as sell-side liquidity.`,
      signal: "neutral",
      confidence: usd >= 10_000_000 ? 0.70 : 0.55,
      related_factor: "Token mint — new supply created",
    };
  }
  if (whale.tx_type === "burn") {
    return {
      headline: `${fmtUSD(usd)} ${sym} sent to burn address`,
      interpretation: `${sym} was transferred to a burn sink, permanently removing ${fmtUSD(usd)} from circulating supply. Supply reduction is mechanically deflationary for the token; market impact depends on size relative to total supply.`,
      signal: "neutral",
      confidence: 0.60,
      related_factor: "Token burn — supply removed",
    };
  }
  if (whale.tx_type === "bridge_flow") {
    return {
      headline: `${fmtUSD(usd)} ${sym} crossed a bridge`,
      interpretation: "Funds moved through a cross-chain bridge contract. This is infrastructure rotation between chains, not an exchange deposit or withdrawal by itself. Repeated bridge flows in one direction can indicate capital migration.",
      signal: "neutral",
      confidence: 0.65,
      related_factor: "Cross-chain bridge flow",
      context_relevance: "low",
    };
  }
  if (whale.tx_type === "miner_flow") {
    return {
      headline: `${fmtUSD(usd)} moved by miner-linked wallet`,
      interpretation: "A wallet labeled as mining infrastructure moved funds. Miner outflows are watched because miners are natural sellers, but a single transfer does not establish selling intent.",
      signal: "neutral",
      confidence: 0.55,
      related_factor: "Miner wallet movement",
      context_relevance: "medium",
    };
  }

  // Not obvious enough → fall through to Gemini
  return null;
}

// ─── wallet behavioral patterns (alpha ladder B) ─────────────────────

const DAY_MS = 86_400_000;

/**
 * Pure: derive a behavioral tag for this wallet from its recent history.
 * Semantics follow the CODEBASE's tx types: exchange_inflow means INTO an
 * exchange (deposit / sell-side), exchange_outflow means OUT of one.
 *
 *   fresh_stealth       — depositing to an exchange within a day of first sight
 *   frequent_depositor  — 3rd+ deposit inside 30 days
 *   accumulator         — 3+ withdrawals from exchanges in 30 days
 *   dumper              — long history (5+) that keeps landing on exchanges
 *   unknown             — nothing conclusive
 *
 * Exported for tests.
 */
export function patternFor(history, currentTx, firstSeen) {
  const cur = currentTx || {};
  const now = Date.now();
  const toExchangeNow = cur.tx_type === "exchange_inflow";
  const hist = (history || []).filter((h) => h?.detected_at && now - h.detected_at <= 30 * DAY_MS);
  const deposits = hist.filter((h) => h.tx_type === "exchange_inflow").length;
  const withdrawals = hist.filter((h) => h.tx_type === "exchange_outflow").length;

  if (toExchangeNow && firstSeen && now - firstSeen < DAY_MS) return "fresh_stealth";
  if (toExchangeNow && deposits >= 2) return "frequent_depositor"; // current tx makes 3
  if (withdrawals >= 3) return "accumulator";
  // dumper: long lifetime history that lands on an exchange again without
  // enough *recent* deposits to qualify as a frequent depositor
  if ((history || []).length >= 5 && toExchangeNow && deposits < 2) return "dumper";
  if (deposits >= 3) return "frequent_depositor";
  return "unknown";
}

/**
 * Compute + persist the behavioral tag for the whale's source wallet.
 * Best-effort: any failure returns null and never blocks analysis.
 */
async function applyWalletPattern(env, whale, history) {
  try {
    const row = await env.DB.prepare(
      "SELECT first_seen FROM wallets WHERE address = ? AND chain = ?"
    ).bind(whale.from_address, whale.chain).first();
    const firstSeen = row?.first_seen ?? null;
    const pattern = patternFor(history, whale, firstSeen);
    if (!pattern || pattern === "unknown") return null;
    await env.DB.prepare(
      `INSERT INTO wallets (address, chain, pattern, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(address, chain) DO UPDATE SET pattern = excluded.pattern`
    ).bind(whale.from_address, whale.chain, pattern,
           firstSeen ?? Date.now(), Date.now()).run();
    return pattern;
  } catch (e) {
    console.warn(`[analyst] wallet pattern upsert failed: ${e.message}`);
    return null;
  }
}

/**
 * Build the Gemini prompt from a whale + context. Evidence-based: feeds
 * structured FACTS and forbids speculation without supporting evidence.
 * Pure function.
 *
 * @param {{chain,from_address,to_address,amount,symbol,usd_value,tx_type,block_time,detected_at}} whale
 * @param {object|null} market — KV market_cache object
 * @param {Array<{chain,tx_hash,from_address,to_address,amount,symbol,usd_value,tx_type,detected_at}>} history - last 5 txs for this wallet
 * @param {Array<{title}>|null} news — top headlines
 */
export function buildPrompt(whale, market, history, news, pattern, ctx = null) {
  const m = market || {};
  const usd = whale.usd_value ?? 0;
  const fgValue = m.fear_greed != null ? m.fear_greed : "unknown";
  const fgLabel = m.fear_greed_label ?? "unknown";
  const regime = marketRegime(market);
  const behavior = walletBehavior(history);

  const btcPrice = m.btc?.price
    ? `$${m.btc.price.toLocaleString()} (${m.btc.change_24h?.toFixed(1) ?? 0}%)`
    : "unknown";
  const ethPrice = m.eth?.price
    ? `$${m.eth.price.toLocaleString()} (${m.eth.change_24h?.toFixed(1) ?? 0}%)`
    : "unknown";

  const hist = (history || []).slice(0, 5).map((h, i) =>
    `- [${i + 1}] ${new Date(h.detected_at).toISOString().slice(0, 19).replace("T", " ")}Z ${h.tx_type} ${h.amount} ${h.symbol} (${fmtUSD(h.usd_value)}) from ${shortAddr(h.from_address)} → ${shortAddr(h.to_address)}`
  ).join("\n") || "- (no prior history for this wallet — first sighting)";

  const newsText = (news && news.length)
    ? news.slice(0, 5).map((n, i) => `- [${i + 1}] ${n.title}`).join("\n")
    : "- (no recent headlines cached)";

  // Determine the destination type for the facts block
  const destIsExchange = whale.tx_type === "exchange_inflow" || whale.tx_type === "exchange_internal";
  const sourceIsExchange = whale.tx_type === "exchange_outflow" || whale.tx_type === "exchange_internal";

  return `You are a crypto whale movement analyst. You are given STRUCTURED FACTS about a whale transaction.

Your job: summarize what the facts SUPPORT. Do not speculate.

RULES:
- State what the evidence indicates. Do NOT say "likely causing" or "may lead to" unless 3+ data points support it.
- If evidence is insufficient for a conclusion, say "insufficient data for conclusion."
- You are not predicting prices. You are interpreting behavior from facts.
- Return ONLY a JSON object (no markdown, no prose).

TRANSACTION:
- Blockchain: ${whale.chain}
- Amount: ${whale.amount} ${whale.symbol} (${fmtUSD(usd)})
- From: ${whale.from_address}
- To: ${whale.to_address}
- Transaction type: ${whale.tx_type}

STRUCTURED FACTS:
- Destination: ${destIsExchange ? "exchange wallet" : "private wallet / unknown"}
- Source: ${sourceIsExchange ? "exchange wallet" : "private wallet / unknown"}
- Wallet historical behavior: ${behavior}
- Market sentiment: ${regime === "fear" ? "Fear" : regime === "greed" ? "Greed" : regime === "neutral" ? "Neutral" : "unknown"} (${fgValue})
- BTC price: ${btcPrice}
- ETH price: ${ethPrice}
- Exchange involvement: ${whale.tx_type === "wallet_to_wallet" ? "no" : "yes"}
- Wallet behavioral tag: ${pattern || "unknown"}
- Prior similar events in wallet history: ${history?.length || 0} transactions
- Technical regime: ${ctx?.ta?.regime ?? 'unknown'}${ctx?.ta?.rsi14 != null ? ' (RSI14 ' + ctx.ta.rsi14 + ', EMA20 ' + ctx.ta.ema20 + ' vs EMA50 ' + ctx.ta.ema50 + ')' : ''}
- Asset news sentiment (6h): ${ctx?.newsSent ? (ctx.newsSent.sum > 0 ? '+' : '') + ctx.newsSent.sum + ' across ' + ctx.newsSent.n + ' headlines' : 'no data'}

RECENT HEADLINES:
${newsText}

WALLET HISTORY (last 5 transactions from the source address):
${hist}

Return JSON:
{
  "headline": "one line describing what the whale did — no emojis, no chain name, max 80 chars",
  "interpretation": "2-3 sentences: state what the structured facts indicate. Cite specific facts. If insufficient evidence, say so explicitly.",
  "signal": "bullish" | "bearish" | "neutral",
   "confidence": 0.0-1.0 float — only above 0.7 if 3+ supporting facts exist,
   "context_relevance": "low" | "medium" | "high" — how much context supports this event:
     high = exchange/wallet labels + history + headlines all line up,
     medium = some supporting context,
     low = routine plumbing with no supporting context (internal routing, small stablecoin moves),
   "related_factor": "the single most relevant fact (e.g. 'exchange inflow during market fear' or 'insufficient data')"
}`;
}

/**
 * Parse the LLM response into a structured analysis. Pure. Failures return null.
 * Gemini returns text: try to extract a JSON object even if wrapped in ```json fences.
 */
export function parseAnalysis(text) {
  if (!text) return null;
  if (typeof text === "object") {
    return normalizeAnalysis(text);
  }
  let s = String(text).trim();
  // strip code fences
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  // find the first { ... last }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  const slice = s.slice(first, last + 1);
  try {
    return normalizeAnalysis(JSON.parse(slice));
  } catch {
    return null;
  }
}

function normalizeAnalysis(o) {
  const signals = new Set(["bullish", "bearish", "neutral"]);
  let confidence = parseFloat(o.confidence);
  if (Number.isNaN(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  let signal = String(o.signal || "neutral").toLowerCase().trim();
  if (!signals.has(signal)) signal = "neutral";
  // context_relevance: how context-saturated this alert is. Default medium
  // keeps old analyses and non-conforming LLM output working unchanged.
  let relevance = String(o.context_relevance || o.contextRelevance || "medium").toLowerCase().trim();
  if (!["low", "medium", "high"].includes(relevance)) relevance = "medium";
  return {
    headline: String(o.headline || "").slice(0, 200),
    interpretation: String(o.interpretation || "").slice(0, 800),
    signal,
    confidence,
    related_factor: String(o.related_factor || o.relatedFactor || "").slice(0, 200),
    context_relevance: relevance,
  };
}

// ─── LLM providers (multi-provider chain, admin-managed at runtime) ─────
//
// config:llm_chain (KV JSON array) decides the order — e.g. ["groq","gemini"].
// Missing/empty → default ["groq","gemini"]. Keys resolve env secret first,
// then KV key:<provider>. First provider that answers wins; failures fall
// through and get collected into one error at the end.

const DEFAULT_LLM_CHAIN = ["groq", "gemini"];

export async function resolveLlmChain(env) {
  try {
    const chain = JSON.parse((await env.KV.get("config:llm_chain")) || "null");
    if (Array.isArray(chain) && chain.length > 0) return chain.map(String);
  } catch { /* fall through to default */ }
  return [...DEFAULT_LLM_CHAIN];
}

/** env secret first, then KV key:<provider> */
async function providerKey(env, provider) {
  const secretName = { gemini: "GEMINI_KEY", groq: "GROQ_KEY" }[provider];
  if (secretName && env[secretName]) return env[secretName];
  try { return await env.KV.get(`key:${provider}`); } catch { return null; }
}

/** Groq: OpenAI-compatible chat completions. Model via KV config:model_groq. */
async function callGroqProvider(env, prompt, key) {
  let model = "qwen/qwen3.8-27b";
  try { model = (await env.KV.get("config:model_groq")) || model; } catch {}
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 400,
      }),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (j.error) throw new Error(`groq: ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new Error("groq returned no content");
    return text;
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Gemini: classic generativelanguage surface first, then the Vertex
 * publisher path (new-format AI Studio keys only authenticate on Vertex).
 * Model via GEMINI_MODEL env / KV config:model.
 */
async function callGeminiProvider(env, prompt, key) {
  let model = env.GEMINI_MODEL || "gemini-3.6-flash";
  if (!env.GEMINI_MODEL) {
    try { model = (await env.KV.get("config:model")) || model; } catch {}
  }
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
  });
  const urls = [
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`,
  ];
  let lastErr = null;
  for (const url of urls) {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body,
        signal: ctl.signal,
      });
      const j = await res.json();
      if (j.error) throw new Error(`gemini (${url.split("/")[2]}): ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
      const cand = j.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!cand) throw new Error("gemini returned no candidates");
      return cand;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr || new Error("gemini endpoints failed");
}

const PROVIDERS = {
  groq: callGroqProvider,
  gemini: callGeminiProvider,
};

/**
 * Run the prompt through the configured chain. Throws a combined error when
 * every provider in the chain fails (or has no key).
 */
export async function callLLM(env, prompt) {
  const chain = await resolveLlmChain(env);
  const errors = [];
  for (const p of chain) {
    const fn = PROVIDERS[p];
    if (!fn) { errors.push(`${p}: unknown provider`); continue; }
    const key = await providerKey(env, p);
    if (!key) { errors.push(`${p}: no key configured`); continue; }
    try {
      return await fn(env, prompt, key);
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`all LLM providers failed [${chain.join(",")}]: ${errors.join(" | ")}`);
}

// back-compat alias — older tests/callers reference callGemini
export const callGemini = callLLM;
// ─── per-message workflow ─────────────────────────────────────────────

/** Look up a whale by id. Returns null if not found. */
async function getWhale(env, whaleId) {
  return await env.DB.prepare(
    "SELECT id, chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, block_number, block_time, detected_at, analysis_status FROM whales WHERE id = ?"
  ).bind(whaleId).first();
}

/** Get the last 5 whale txs sent from this address on the same chain. */
async function getWalletHistory(env, address, chain, excludeId) {
  const { results } = await env.DB.prepare(
    "SELECT chain, tx_hash, from_address, to_address, amount, symbol, usd_value, tx_type, detected_at FROM whales WHERE from_address = ? AND chain = ? AND id != ? ORDER BY detected_at DESC LIMIT 5"
  ).bind(address, chain, excludeId).all();
  return results || [];
}

/** Load labels for the from+to addresses of the whale. */
async function labelPair(env, fromAddr, toAddr) {
  // indexable: IN over raw+lowercase variants — lower(address) on the
  // column defeats idx_wallets_address (full wallets scan per event)
  const f = String(fromAddr), t = String(toAddr);
  const { results } = await env.DB.prepare(
    "SELECT address, label, type FROM wallets WHERE address IN (?, ?, ?, ?)"
  ).bind(f, f.toLowerCase(), t, t.toLowerCase()).all();
  const map = new Map();
  for (const r of results || []) map.set(String(r.address).toLowerCase(), r);
  return {
    fromLabel: map.get(String(fromAddr).toLowerCase())?.label || null,
    toLabel: map.get(String(toAddr).toLowerCase())?.label || null,
    fromType: map.get(String(fromAddr).toLowerCase())?.type || null,
    toType: map.get(String(toAddr).toLowerCase())?.type || null,
  };
}

/** Record the analysis + mark the whale done. */
async function saveAnalysis(env, whaleId, parsed) {
  await env.DB.prepare(
    `INSERT INTO analysis (whale_id, headline, interpretation, signal, confidence, related_factor, context_relevance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(whale_id) DO UPDATE SET
       headline=excluded.headline, interpretation=excluded.interpretation,
       signal=excluded.signal, confidence=excluded.confidence,
       related_factor=excluded.related_factor,
       context_relevance=excluded.context_relevance`
  ).bind(
    whaleId, parsed.headline, parsed.interpretation, parsed.signal,
    parsed.confidence, parsed.related_factor, parsed.context_relevance ?? "medium", Date.now()
  ).run();
  await env.DB.prepare(
    "UPDATE whales SET analysis_status = 'done' WHERE id = ?"
  ).bind(whaleId).run();
  try {
    await env.DB.prepare(
      "INSERT INTO counters (k, v) VALUES ('status:pending', -1) ON CONFLICT(k) DO UPDATE SET v = MAX(0, v + excluded.v)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO counters (k, v) VALUES ('status:done', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
    ).run();
  } catch { /* non-essential */ }
}

/** Mark analysis failed (acknowledged). */
async function markFailed(env, whaleId) {
  await env.DB.prepare(
    "UPDATE whales SET analysis_status = 'failed' WHERE id = ?"
  ).bind(whaleId).run();
}

/**
 * Fold a freshly-analyzed signal into the rollups (hourly_stats + counters).
 * Signal counts can only be finalized here — the scanner doesn't know the
 * direction yet. Best-effort: failure never blocks the alert.
 */
async function bumpSignalRollups(env, whale, signal) {
  const hour = Math.floor((whale.detected_at || Date.now()) / 3600000) * 3600000;
  const col = signal === "bullish" ? "bullish" : signal === "bearish" ? "bearish" : "neutral";
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO hourly_stats (hour_bucket, chain, ${col}) VALUES (?, ?, 1)
         ON CONFLICT(hour_bucket, chain) DO UPDATE SET ${col} = ${col} + 1`
      ).bind(hour, whale.chain),
      env.DB.prepare(
        "INSERT INTO counters (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
      ).bind(`signal:${signal}`),
    ]);
  } catch (e) {
    console.warn(`[analyst] signal rollup failed: ${e.message}`);
  }
}

// ─── entry (queue consumer) ──────────────────────────────────────────

export async function analyzeOne(env, msg) {
  const { whale_id, chain } = msg || {};
  if (!whale_id) throw new Error("missing whale_id");

  const whale = await getWhale(env, whale_id);
  if (!whale) {
    console.warn(`[analyst:${whale_id}] whale not found — acking (maybe deleted)`);
    return { ok: true, skipped: "missing_whale" };
  }
  if (whale.analysis_status === "done") {
    return { ok: true, skipped: "already_done" };
  }

  // market + news from KV
  let market = null, news = null;
  try {
    market = JSON.parse(await env.KV.get("market_cache") || "null");
  } catch { /* null */ }
  try {
    const raw = JSON.parse(await env.KV.get("news_cache") || "null");
    // scanner writes {headlines:Array<{title}>, updated_at} (Phase 3a / whale-
    // reasoning Plan Ladder A). buildPrompt wants Array<{title}> or null.
    news = raw && Array.isArray(raw.headlines) ? raw.headlines : null;
  } catch { /* null */ }

  const history = await getWalletHistory(env, whale.from_address, whale.chain, whale.id);
  const pattern = await applyWalletPattern(env, whale, history);

  // Sprint 1: try template analysis first (no Gemini call needed for obvious cases).
  // Saves 80% of AI calls. Falls through to Gemini for ambiguous events.
  const ctx = await getMarketContext(env, whale.chain, whale.symbol);
  // derivatives crowding context rides on the market cache (funding + OI)
  ctx.derivs = market?.funding?.[String(whale.chain).toLowerCase()] ?? null;
  ctx.weights = await loadFlowWeights(env);
  const templateResult = templateAnalysis(whale, market, history, ctx);
  if (templateResult) {
    await saveAnalysis(env, whale_id, templateResult);
    await bumpSignalRollups(env, whale, templateResult.signal);
    await env.BOTQ.send(JSON.stringify({ kind: "public_alert", whale_id: whale.id }));
    return { ok: true, whale_id, signal: templateResult.signal, confidence: templateResult.confidence, source: "template" };
  }

  // Not obvious enough for a template → call Gemini.
  const prompt = buildPrompt(whale, market, history, news, pattern, ctx);

  let parsed;
  try {
    const text = await callGemini(env, prompt);
    parsed = parseAnalysis(text);
    if (!parsed) throw new Error("Gemini response was not parseable JSON");
  } catch (e) {
    console.error(`[analyst:${whale_id}] analysis failed:`, e.message);
    await markFailed(env, whale_id);
    return { ok: false, error: e.message };
  }

  await saveAnalysis(env, whale_id, parsed);
  await bumpSignalRollups(env, whale, parsed.signal);

  // queue the bot to post the alert to the public channel
  await env.BOTQ.send(JSON.stringify({
    kind: "public_alert",
    whale_id: whale.id,
  }));

  return { ok: true, whale_id, signal: parsed.signal, confidence: parsed.confidence, source: "gemini" };
}


// ─── daily LLM news scoring (one batched call; lexicon = fallback) ────
//
// The lexicon can't tell "SEC approves ETF" from "SEC delays ETF decision".
// One LLM call scores up to 20 unscored headlines with sentiment + event
// type; rows are marked so nothing is scored twice. Rebuilt Sep 18 — the
// original block was lost in a file restore (see AUDIT.md).
export function buildNewsScorePrompt(headlines) {
  return "You are a crypto news classifier. For each headline output a JSON array item:\n" +
    '  {"i": <index>, "s": <-1|0|1>, "e": "<regulation|hack|adoption|macro|etf|exchange|market|other>"}\n' +
    "  s: -1 bearish, 0 neutral, 1 bullish FOR THE ASSET MENTIONED (crypto-wide news counts for both BTC and ETH). Judge the headline's own content, not vibes.\n" +
    "  HEADLINES:\n" +
    headlines.map((h, i) => (i + 1) + ". " + h.title).join("\n") +
    "\n  Return ONLY the JSON array.";
}

export function parseNewsScores(text) {
  if (!text) return null;
  const s = String(text).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("["), last = s.lastIndexOf("]");
  if (first < 0 || last <= first) return null;
  try {
    const arr = JSON.parse(s.slice(first, last + 1));
    if (!Array.isArray(arr)) return null;
    return arr.filter((it) => it && Number.isFinite(it.i) && [-1, 0, 1].includes(it.s))
      .map((it) => ({ i: it.i, s: it.s, e: String(it.e || "other").slice(0, 24) }));
  } catch { return null; }
}

export async function scorePendingNews(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, title FROM news WHERE scored_at IS NULL ORDER BY first_seen ASC LIMIT 20"
  ).all();
  if (!results || results.length < 10) return { scored: 0, skipped: "fewer than 10 unscored" };
  const prompt = buildNewsScorePrompt(results);
  let parsed = null;
  try { parsed = parseNewsScores(await callLLM(env, prompt)); }
  catch (e) { return { scored: 0, skipped: e.message }; }
  if (!parsed) return { scored: 0, skipped: "unparseable" };
  const stmts = parsed.map((it) => {
    const row = results[it.i];
    if (!row) return null;
    return env.DB.prepare(
      "UPDATE news SET llm_sentiment = ?, llm_event = ?, scored_at = ? WHERE id = ? AND scored_at IS NULL"
    ).bind(it.s, it.e, Date.now(), row.id);
  }).filter(Boolean);
  if (stmts.length) await env.DB.batch(stmts);
  return { scored: stmts.length };
}


// ─── daily market brief (LLM narrative, generated once per day) ──────
//
// The analyst composes the brief from rollup context (regime, netflow,
// funding, headlines) and stores it in KV; the bot posts it with the
// 18:00 UTC scoreboard. Architecture rule preserved: only the bot
// touches Telegram.
export function buildBriefPrompt(ctx) {
  return "You are WhaleSignal's daily brief writer. Using ONLY the facts below,\n" +
    "write a 4-6 line market brief for a crypto whale-watching audience.\n" +
    "Tone: plain, factual, no hype, no price predictions. End with one line:\n" +
    '"What to watch" naming the single most informative thing to monitor.\n\n' +
    "FACTS:\n" + ctx.lines + "\n\n" +
    "Return plain text only.";
}

export async function generateDailyBrief(env) {
  const marker = "brief:" + new Date().toISOString().slice(0, 10);
  try { if (await env.KV.get(marker)) return { skipped: "already_generated" }; } catch {}
  const lines = [];
  try {
    const { results: ph } = await env.DB.prepare(
      "SELECT ts, price FROM price_history WHERE coin = 'btc' ORDER BY ts DESC LIMIT 48"
    ).all();
    if (ph && ph.length >= 51) {
      const t = taSnapshot(ph.slice().reverse());
      lines.push("BTC tape: " + t.regime + " (RSI14 " + t.rsi14 + ")");
    }
  } catch {}
  try {
    const n = await env.DB.prepare(
      "SELECT SUM(inflow_usd - outflow_usd) AS net FROM hourly_stats WHERE hour_bucket > ? AND (inflow_count > 0 OR outflow_count > 0)"
    ).bind(Date.now() - 86_400_000).first();
    if (n?.net != null) lines.push("24h exchange netflow: " + Math.round(n.net / 1e6) + "M USD");
  } catch {}
  try {
    const m = JSON.parse(await env.KV.get("market_cache") || "null");
    if (m?.funding?.btc?.funding != null) lines.push("BTC funding (8h): " + (m.funding.btc.funding * 100).toFixed(3) + "%");
    if (m?.fear_greed != null) lines.push("Fear & Greed: " + m.fear_greed + " (" + (m.fear_greed_label || "") + ")");
  } catch {}
  try {
    const n = JSON.parse(await env.KV.get("news_cache") || "null");
    const heads = (n?.headlines || []).slice(0, 5).map((h) => "- " + h.title);
    if (heads.length) lines.push("Recent headlines:\n" + heads.join("\n"));
  } catch {}
  if (lines.length < 2) return { skipped: "insufficient context" };
  const text = await callLLM(env, buildBriefPrompt({ lines: lines.join("\n") }));
  const clean = String(text || "").replace(/^```[a-z]*|```$/g, "").trim().slice(0, 1200);
  if (!clean) return { skipped: "empty brief" };
  await env.KV.put("daily_brief", JSON.stringify({ text: clean, generated_at: Date.now() }), { expirationTtl: 3 * 86400 });
  try { await env.KV.put(marker, "1", { expirationTtl: 2 * 86400 }); } catch {}
  return { generated: true, chars: clean.length };
}

export default {
  // Hourly cron: score pending news headlines (one batched LLM call when
  // enough accumulated) + generate the daily market brief. NOTE: this
  // handler was silently missing from the export for a full day — the cron
  // fired, Cloudflare called nothing, and llm_scored stayed 0. Found by the
  // scheduled e2e test, not by any deploy log.
  async scheduled(event, env, ctx) {
    try {
      const r = await scorePendingNews(env);
      console.log("[analyst] news scoring:", JSON.stringify(r));
      const br = await generateDailyBrief(env);
      console.log("[analyst] daily brief:", JSON.stringify(br));
    } catch (e) {
      console.error("[analyst] scheduled failed:", e.message);
    }
  },
  // Cloudflare Queues: batch messages arrive — ack each by awaiting.
  async queue(batch, env) {
    const out = [];
    for (const m of batch.messages) {
      try {
        let body;
        try { body = JSON.parse(m.body); }
        catch { body = {}; }
        const r = await analyzeOne(env, body);
        m.ack();
        out.push(r);
      } catch (e) {
        console.error("[analyst] msg handler threw:", e.message);
        // Missing-key is permanent, not transient — retrying just burns
        // queue ops 3x per whale during a backlog. Fail it and move on;
        // the whale stays 'failed' in D1 and can be re-analyzed later.
        // Matches both legacy "GEMINI_KEY missing" and the new multi-provider
        // "no key configured" or "all LLM providers failed" patterns.
        if (/(?:GEMINI_KEY missing|no key configured|all LLM providers failed)/i.test(e.message)) {
          try { await markFailed(env, JSON.parse(m.body || "{}")?.whale_id); }
          catch { /* best effort */ }
          m.ack();
          out.push({ ok: false, error: e.message, permanent: true });
          continue;
        }
        // everything else: retry — max_retries=3 bounds this
        m.retry();
        out.push({ ok: false, error: e.message });
      }
    }
    return out;
  },
};
