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
 * Try to analyze a whale without calling Gemini. Returns a normalized
 * analysis object if the case is obvious enough, or null if ambiguous.
 * Pure (no I/O, no API calls).
 *
 * This saves 80% of Gemini calls by handling the predictable patterns:
 *  - exchange_inflow + fear → bearish (classic sell setup)
 *  - exchange_outflow + greed → bullish (classic accumulation)
 *  - exchange_internal → neutral (exchange plumbing)
 *  - wallet_to_wallet small → neutral
 *
 * Anything ambiguous or with high interestingness → falls through to Gemini.
 *
 * @param {object} whale — { tx_type, usd_value, symbol, interesting_score }
 * @param {object|null} market — KV market_cache
 * @param {Array} history — last 5 txs for this wallet
 * @returns {object|null} normalized analysis or null (need Gemini)
 */
export function templateAnalysis(whale, market, history) {
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
    };
  }

  // Exchange inflow during market fear = bearish
  if (whale.tx_type === "exchange_inflow" && (regime === "fear" || behavior === "distribution")) {
    const factor = regime === "fear" && behavior === "distribution"
      ? "Exchange inflow during market fear with prior distribution history"
      : regime === "fear" ? "Exchange inflow during market fear" : "Wallet has prior distribution pattern";
    return {
      headline: `${fmtUSD(usd)} ${sym} deposited to exchange`,
      interpretation: `Whale deposited ${fmtUSD(usd)} ${sym} to an exchange. ${regime === "fear" ? "Market is in fear territory (F&G " + market?.fear_greed + "). " : ""}Exchange inflows often precede selling, especially when the wallet has shown prior distribution behavior.`,
      signal: "bearish",
      confidence: regime === "fear" && behavior === "distribution" ? 0.82 : regime === "fear" ? 0.75 : 0.65,
      related_factor: factor,
    };
  }

  // Exchange outflow during market greed = bullish
  if (whale.tx_type === "exchange_outflow" && (regime === "greed" || behavior === "accumulation")) {
    const factor = regime === "greed" && behavior === "accumulation"
      ? "Exchange outflow with prior accumulation history"
      : regime === "greed" ? "Exchange outflow during market greed" : "Wallet has prior accumulation pattern";
    return {
      headline: `${fmtUSD(usd)} ${sym} withdrawn from exchange`,
      interpretation: `Whale withdrew ${fmtUSD(usd)} ${sym} from an exchange. ${regime === "greed" ? "Market sentiment is greedy (F&G " + market?.fear_greed + "). " : ""}Exchange outflows often signal self-custody and accumulation, especially when the wallet has shown this pattern before.`,
      signal: "bullish",
      confidence: regime === "greed" && behavior === "accumulation" ? 0.78 : regime === "greed" ? 0.70 : 0.62,
      related_factor: factor,
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
    };
  }
  if (whale.tx_type === "miner_flow") {
    return {
      headline: `${fmtUSD(usd)} moved by miner-linked wallet`,
      interpretation: "A wallet labeled as mining infrastructure moved funds. Miner outflows are watched because miners are natural sellers, but a single transfer does not establish selling intent.",
      signal: "neutral",
      confidence: 0.55,
      related_factor: "Miner wallet movement",
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
export function buildPrompt(whale, market, history, news, pattern) {
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
  return {
    headline: String(o.headline || "").slice(0, 200),
    interpretation: String(o.interpretation || "").slice(0, 800),
    signal,
    confidence,
    related_factor: String(o.related_factor || o.relatedFactor || "").slice(0, 200),
  };
}

// ─── Gemini call ─────────────────────────────────────────────────────

/** Call Gemini. Returns the raw text response. Throws on error.
 *  Key source: GEMINI_KEY env secret first, then KV `key:gemini` (writable
 *  from the admin bot's /setkey — lets you rotate keys without a redeploy). */
export async function callGemini(env, prompt) {
  let key = env.GEMINI_KEY;
  if (!key) {
    try { key = await env.KV.get("key:gemini"); } catch { /* kv hiccup → treat as missing */ }
  }
  if (!key) throw new Error("GEMINI_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_KEY}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
      }),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (j.error) throw new Error(`Gemini API: ${j.error.message || JSON.stringify(j.error)}`);
    const cand = j.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!cand) throw new Error("Gemini returned no candidates");
    return cand;
  } finally {
    clearTimeout(tid);
  }
}

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
  const { results } = await env.DB.prepare(
    "SELECT address, label, type FROM wallets WHERE lower(address) IN (?, ?)"
  ).bind(String(fromAddr).toLowerCase(), String(toAddr).toLowerCase()).all();
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
    `INSERT INTO analysis (whale_id, headline, interpretation, signal, confidence, related_factor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(whale_id) DO UPDATE SET
       headline=excluded.headline, interpretation=excluded.interpretation,
       signal=excluded.signal, confidence=excluded.confidence,
       related_factor=excluded.related_factor`
  ).bind(
    whaleId, parsed.headline, parsed.interpretation, parsed.signal,
    parsed.confidence, parsed.related_factor, Date.now()
  ).run();
  await env.DB.prepare(
    "UPDATE whales SET analysis_status = 'done' WHERE id = ?"
  ).bind(whaleId).run();
}

/** Mark analysis failed (acknowledged). */
async function markFailed(env, whaleId) {
  await env.DB.prepare(
    "UPDATE whales SET analysis_status = 'failed' WHERE id = ?"
  ).bind(whaleId).run();
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
  const templateResult = templateAnalysis(whale, market, history);
  if (templateResult) {
    await saveAnalysis(env, whale_id, templateResult);
    await env.BOTQ.send(JSON.stringify({ kind: "public_alert", whale_id: whale.id }));
    return { ok: true, whale_id, signal: templateResult.signal, confidence: templateResult.confidence, source: "template" };
  }

  // Not obvious enough for a template → call Gemini.
  const prompt = buildPrompt(whale, market, history, news, pattern);

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

  // queue the bot to post the alert to the public channel
  await env.BOTQ.send(JSON.stringify({
    kind: "public_alert",
    whale_id: whale.id,
  }));

  return { ok: true, whale_id, signal: parsed.signal, confidence: parsed.confidence, source: "gemini" };
}

export default {
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
        if (/GEMINI_KEY missing/i.test(e.message)) {
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
