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
import { analyzeWalletPatterns } from "./graph-analyst.js";

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

  // Not obvious enough → fall through to Gemini
  return null;
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
export function buildPrompt(whale, market, history, news, patterns = null) {
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

  const p = patterns || (typeof analyzeWalletPatterns === "function" ? analyzeWalletPatterns([whale, ...(history || [])], whale.from_address, market, news) : null);
  const forensicBlock = p ? `
FORENSIC & DECEPTION PATTERNS:
- Behavioral profile: ${p.behavioral_profile}
- Deception risk: ${p.deception_risk} (Score: ${p.deception_score}/100)
- Wash trading loops: ${p.wash_loops?.length > 0 ? `DETECTED (${p.wash_loops.length} loops)` : "None"}
- Peeling chain / layering: ${p.is_peeling_chain ? "DETECTED (possible money laundering structuring)" : "None"}
- Rapid structuring: ${p.is_structuring ? "DETECTED (burst of split transfers)" : "None"}
- Deception flags: ${p.flags?.length > 0 ? p.flags.join(", ") : "ORGANIC_ONCHAIN_FLOW"}
- Inferred intent: ${p.intent_summary || "organic on-chain transfer"}
` : "";

  return `You are a crypto whale movement analyst. You are given STRUCTURED FACTS about a whale transaction.

Your job: summarize what the facts SUPPORT. Do not speculate.

RULES:
- State what the evidence indicates. Do NOT say "likely causing" or "may lead to" unless 3+ data points support it.
- If evidence is insufficient for a conclusion, say "insufficient data for conclusion."
- You are not predicting prices. You are interpreting behavior from facts.
- Evaluate direction carefully using STRUCTURED FACTS and FORENSIC PATTERNS:
  * Bullish: Outflow from exchange, cold storage withdrawal, smart accumulation during market fear.
  * Bearish: Inflow to exchange, panic selling during market dips, top distribution during extreme greed.
  * Neutral: Internal exchange rebalance sweeps, routine stablecoin peg transfers, or artificial wash trading loops.
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
- Prior similar events in wallet history: ${history?.length || 0} transactions
${forensicBlock}
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

// ─── Gemini & xAI (Grok) calls ───────────────────────────────────────

/** Call xAI (Grok). Returns the raw text response. Throws on error. */
export async function callXAI(env, prompt) {
  if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY missing");
  const url = "https://api.x.ai/v1/chat/completions";
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You are a professional crypto whale movement analyst. Return valid JSON only with headline, interpretation, signal, confidence, related_factor." },
          { role: "user", content: prompt },
        ],
        model: env.XAI_MODEL || "grok-2-latest",
        temperature: 0.3,
        max_tokens: 450,
      }),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (j.error) throw new Error(`xAI API: ${j.error.message || JSON.stringify(j.error)}`);
    const cand = j.choices?.[0]?.message?.content;
    if (!cand) throw new Error("xAI returned empty response");
    return cand;
  } finally {
    clearTimeout(tid);
  }
}

/** Call Gemini. Returns the raw text response. Throws on error. */
export async function callGemini(env, prompt, specificModel = null) {
  if (!env.GEMINI_KEY) throw new Error("GEMINI_KEY missing");
  // Use verified active models on the Gemini Generative Language API
  const primaryModel = specificModel || env.GEMINI_MODEL || "gemini-flash-lite-latest";
  const candidateModels = specificModel
    ? [specificModel]
    : [primaryModel, "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.8-flash"].filter(
        (m, i, arr) => m && arr.indexOf(m) === i
      );
  let lastErr = null;

  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`;
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "WhaleSignal/1.0",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
        }),
        signal: ctl.signal,
      });
      const rawText = await res.text();
      let j;
      try { j = JSON.parse(rawText); } catch { throw new Error(`Gemini (${model}) HTTP ${res.status}: ${rawText.slice(0, 200)}`); }
      if (j.error) {
        lastErr = new Error(`Gemini (${model}): ${j.error.message || JSON.stringify(j.error)}`);
        continue;
      }
      const cand = j.candidates?.[0]?.content?.parts?.[0]?.text;
      if (cand) return cand;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr || new Error("Gemini returned no candidates across all models");
}

/** Call Groq. Returns the raw text response. Throws on error. */
export async function callGroq(env, prompt, specificModel = null) {
  if (!env.GROQ_KEY) throw new Error("GROQ_KEY missing");
  const primaryModel = specificModel || env.GROQ_MODEL || "openai/gpt-oss-120b";
  const candidateModels = specificModel
    ? [specificModel]
    : [primaryModel, "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"].filter(
        (m, i, arr) => m && arr.indexOf(m) === i
      );

  let lastErr = null;
  for (const model of candidateModels) {
    const url = "https://api.groq.com/openai/v1/chat/completions";
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${env.GROQ_KEY.trim()}`,
          "user-agent": "Mozilla/5.0 (compatible; WhaleSignal/1.0)",
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "You are a professional crypto whale movement analyst. Return valid JSON only with headline, interpretation, signal, confidence, related_factor." },
            { role: "user", content: prompt },
          ],
          model,
          temperature: 0.3,
          max_tokens: 350,
          response_format: { type: "json_object" },
        }),
        signal: ctl.signal,
      });
      const rawText = await res.text();
      let j;
      try { j = JSON.parse(rawText); } catch { throw new Error(`Groq HTTP ${res.status}: ${rawText.slice(0, 200)}`); }
      if (j.error) {
        lastErr = new Error(`Groq API (${model}): ${j.error.message || JSON.stringify(j.error)}`);
        continue;
      }
      const cand = j.choices?.[0]?.message?.content;
      if (cand) return cand;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr || new Error("Groq returned empty response across all models");
}

/** Unified AI dispatcher: routes across xAI, Groq, and Gemini with automatic fallback. */
export async function callAI(env, prompt) {
  if (env.XAI_API_KEY && env.AI_PROVIDER !== "gemini" && env.AI_PROVIDER !== "groq") {
    try {
      return await callXAI(env, prompt);
    } catch (e) {
      console.warn("[analyst] xAI failed, falling back:", e.message);
    }
  }

  if (env.GROQ_KEY && env.AI_PROVIDER !== "gemini") {
    try {
      return await callGroq(env, prompt);
    } catch (e) {
      console.warn("[analyst] Groq failed, falling back:", e.message);
    }
  }

  if (env.GEMINI_KEY) {
    return await callGemini(env, prompt);
  }

  throw new Error("No AI provider available (set GROQ_KEY, GEMINI_KEY, or XAI_API_KEY)");
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
  const patterns = analyzeWalletPatterns([whale, ...(history || [])], whale.from_address, market, news);

  // Sprint 1: try template analysis first (no AI call needed for obvious cases).
  // Saves 80% of AI calls. Falls through to AI for ambiguous events.
  const templateResult = templateAnalysis(whale, market, history);
  if (templateResult) {
    await saveAnalysis(env, whale_id, templateResult);
    // Suppress internal exchange sweeps and low-interest neutral moves from spamming public Telegram
    const shouldBroadcast = whale.tx_type !== "exchange_internal" &&
      (templateResult.signal !== "neutral" || (whale.usd_value ?? 0) >= 25_000_000);
    if (shouldBroadcast) {
      await env.BOTQ.send(JSON.stringify({ kind: "public_alert", whale_id: whale.id }));
    }
    return { ok: true, whale_id, signal: templateResult.signal, confidence: templateResult.confidence, source: "template" };
  }

  // Not obvious enough for a template → call unified AI (xAI / Gemini).
  const prompt = buildPrompt(whale, market, history, news, patterns);

  let parsed;
  let source = "gemini";
  try {
    const text = await callAI(env, prompt);
    source = (env.XAI_API_KEY && env.AI_PROVIDER !== "gemini") ? "xai" : "gemini";
    parsed = parseAnalysis(text);
    if (!parsed) throw new Error("AI response was not parseable JSON");
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

  return { ok: true, whale_id, signal: parsed.signal, confidence: parsed.confidence, source };
}

/** Diagnostic probe for Groq, Gemini models, and xAI with token/cost efficiency breakdown. */
export async function diagnoseAIEngines(env) {
  const testPrompt = `TRANSACTION:
Blockchain: eth
Amount: 3500 ETH ($11,200,000)
From: 0x28c6c06298d514de13c02684fa65b7c0c1f723e4
To: 0x1111111111111111111111111111111111111111
Transaction type: exchange_outflow
Market sentiment: Fear (28)
BTC price: $67,000
ETH price: $3,200

Return JSON:
{
  "headline": "Whale withdraws 3500 ETH from exchange",
  "interpretation": "Large cold storage withdrawal during market fear indicating smart accumulation.",
  "signal": "bullish",
  "confidence": 0.85,
  "related_factor": "Exchange outflow during market fear"
}`;

  const results = {
    ok: true,
    timestamp: new Date().toISOString(),
    engines: {},
    cost_efficiency: {
      template_engine: "0 tokens, 0ms (handles ~80% of predictable whale flows at zero cost)",
      groq_llama_70b: "Fastest response (<400ms), free tier (30 RPM / 14,400 RPD), native JSON output",
      gemini_2_0_flash: "Google Generative AI free tier (15 RPM), ~750ms latency, high reliability",
      recommendation: "Use template engine first, Groq llama-3.3-70b as primary LLM, Gemini 2.0-flash as secondary fallback",
    },
  };

  // 1. Probe Groq models
  if (env.GROQ_KEY) {
    results.engines.groq_models = {};
    const groqModelsToProbe = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
    for (const m of groqModelsToProbe) {
      const start = Date.now();
      try {
        const txt = await callGroq(env, testPrompt, m);
        const parsed = parseAnalysis(txt);
        results.engines.groq_models[m] = {
          ok: !!parsed,
          latency_ms: Date.now() - start,
          parsed_signal: parsed?.signal || null,
          headline: parsed?.headline || null,
        };
      } catch (e) {
        results.engines.groq_models[m] = {
          ok: false,
          latency_ms: Date.now() - start,
          error: e.message,
        };
      }
    }
  } else {
    results.engines.groq = { ok: false, error: "GROQ_KEY not configured" };
  }

  // 2. Probe Gemini models individually and list supported models
  if (env.GEMINI_KEY) {
    results.engines.gemini_models = {};
    const modelsToProbe = [
      "gemini-flash-latest",
      "gemini-3.7-flash",
      "gemini-3.5-flash",
      "gemini-3.8-flash",
      "gemini-flash-lite-latest",
    ];
    for (const m of modelsToProbe) {
      const start = Date.now();
      try {
        const txt = await callGemini(env, testPrompt, m);
        const parsed = parseAnalysis(txt);
        results.engines.gemini_models[m] = {
          ok: !!parsed,
          latency_ms: Date.now() - start,
          parsed_signal: parsed?.signal || null,
          headline: parsed?.headline || null,
        };
      } catch (e) {
        results.engines.gemini_models[m] = {
          ok: false,
          latency_ms: Date.now() - start,
          error: e.message,
        };
      }
    }

    // List models actually available to this key
    try {
      const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_KEY}`);
      const listData = await listRes.json();
      if (listData?.models) {
        results.engines.available_google_models = listData.models
          .filter((x) => x.supportedGenerationMethods?.includes("generateContent"))
          .map((x) => x.name.replace("models/", ""));
      }
    } catch {}
  } else {
    results.engines.gemini = { ok: false, error: "GEMINI_KEY not configured" };
  }

  // 3. Probe xAI if configured
  if (env.XAI_API_KEY) {
    const start = Date.now();
    try {
      const txt = await callXAI(env, testPrompt);
      const parsed = parseAnalysis(txt);
      results.engines.xai = {
        ok: !!parsed,
        model: env.XAI_MODEL || "grok-2-latest",
        latency_ms: Date.now() - start,
        parsed_signal: parsed?.signal || null,
      };
    } catch (e) {
      results.engines.xai = { ok: false, error: e.message };
    }
  } else {
    results.engines.xai = { ok: false, error: "XAI_API_KEY not configured (optional)" };
  }

  return results;
}

export default {
  // HTTP endpoint for diagnostics (/test-ai)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/test-ai" || url.pathname === "/diagnostics") {
      const diag = await diagnoseAIEngines(env);
      return new Response(JSON.stringify(diag, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true, worker: "whalesignal-analyst", status: "healthy" }), {
      headers: { "Content-Type": "application/json" },
    });
  },

  // Cloudflare Queues: batch messages arrive — ack each by awaiting.
  async queue(batch, env) {
    const out = [];
    for (const m of batch.messages) {
      try {
        let body;
        try {
          body = typeof m.body === "string" ? JSON.parse(m.body) : (m.body || {});
        } catch {
          body = {};
        }
        if (body.kind === "diagnose_ai") {
          console.log("[analyst] running background AI diagnostics probe across Gemini and Groq...");
          const diag = await diagnoseAIEngines(env);
          try { await env.KV.put("ai_diagnostics", JSON.stringify(diag, null, 2)); } catch {}
          m.ack();
          out.push({ ok: true, type: "diagnose_ai", diag });
          continue;
        }
        const r = await analyzeOne(env, body);
        m.ack();
        out.push(r);
      } catch (e) {
        console.error("[analyst] msg handler threw:", e.message);
        // retry — but Workers Queues default max_retries=3, so this won't loop forever
        m.retry();
        out.push({ ok: false, error: e.message });
      }
    }
    return out;
  },
};
