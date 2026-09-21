// src/jev.js — TypeSafe Jev wrapper: typed decisions (Choice/Score/Noul)
// from a single fan-out call per batch. Built per jev/06-agent-handoff.md:
//   * one call answers ALL questions in parallel (never serial fan-out)
//   * thresholds come from config (KV config:jev), never code literals
//   * model pinned + response.model logged; latency + token/cost estimate logged
//   * deterministic MockJevClient when TYPESAFE_API_KEY is absent — the full
//     pipeline runs offline and unit tests never touch the network
//   * user-supplied text (headlines) is HOSTILE: sanitized before it enters
//     state, and an injection Noul guards every batch (04-failure-modes §5)
//
// Jev CANNOT generate text, count, or do date math — all aggregation happens
// here in code. See jev/04-failure-modes.md.

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL_DEFAULT = "jev-1.13.0";
export const JEV_COST_PER_MTOK = 0.042;

/** Injection patterns stripped from any user-adjacent text before it can
 *  enter state (04-failure-modes §5 layer 1). */
export const INJECTION_PATTERNS = [
  /ignore\s+(all|any|previous|above|prior)/gi,
  /system\s*:/gi,
  /\bact\s+as\b/gi,
  /###/g,
  /disregard\s+(all|previous)/gi,
];

/** Sanitize user-adjacent text (headlines are fetched from third-party
 *  feeds — treat as hostile). Returns a bounded, stripped string. */
export function sanitizeText(text, maxLen = 220) {
  let t = String(text ?? "");
  for (const re of INJECTION_PATTERNS) t = t.replace(re, "[stripped]");
  t = t.replace(/\s+/g, " ").trim();
  return t.slice(0, maxLen);
}

/** Default thresholds — overridden per key by KV config:jev (JSON).
 *  Pattern 2: threshold PER ACTION, with the safe default below each. */
export const JEV_DEFAULTS = {
  model: JEV_MODEL_DEFAULT,
  min_sentiment_confidence: 0.60, // below → lexicon fallback for that headline
  min_choice_confidence: 0.45,    // below → event type 'other'
  max_headlines_per_call: 20,
};

async function jevConfig(env) {
  try {
    const raw = await env.KV.get("config:jev");
    if (raw) return { ...JEV_DEFAULTS, ...JSON.parse(raw) };
  } catch { /* defaults */ }
  return { ...JEV_DEFAULTS };
}

/** Is a real Jev key configured? Mock mode (JEV_MOCK=1) also counts as
 *  available so the pipeline can be exercised offline end to end. */
export function jevAvailable(env) {
  return Boolean(env.TYPESAFE_API_KEY) || env.JEV_MOCK === "1";
}

/**
 * Deterministic MockJevClient — answers the documented response shape
 * without any network. Anchored on keyword heuristics so tests can assert
 * exact outputs; deliberately simple (it mocks, it does not think).
 */
export function mockJevSystemOne(state, questions) {
  const answers = {};
  const text = JSON.stringify(state).toLowerCase();
  for (const [key, q] of Object.entries(questions || {})) {
    if (q.type === "choice") {
      let best = "other", bestScore = 0;
      const probs = {};
      for (const [option, desc] of Object.entries(q.criteria || {})) {
        // 5-char prefix matching (catches approve/approvals) and the option
        // key itself is matchable — a naive but deterministic mock
        const words = [option, ...String(desc).toLowerCase().split(/\W+/)].filter((w) => w.length > 2);
        const hits = words.filter((w) => text.includes(w.slice(0, 5))).length;
        probs[option] = hits;
        if (hits > bestScore && option !== "other") { best = option; bestScore = hits; }
      }
      const total = Object.values(probs).reduce((s, x) => s + x, 0) || 1;
      for (const k of Object.keys(probs)) probs[k] = Math.round((probs[k] / total) * 100) / 100;
      probs[best] = Math.max(probs[best] ?? 0, 0.34);
      answers[key] = { type: "choice", choice: best, probabilities: probs, confidence: bestScore ? 0.72 : 0.3 };
    } else if (q.type === "score") {
      const levels = q.criteria || [];
      const anchors = ["very bearish", "bearish", "neutral", "bullish", "very bullish",
        "routine", "substantive", "decisive", "not", "mildly", "strongly"];
      let idx = levels.findIndex((l) => text.includes(String(l).toLowerCase().split(" ")[0]));
      if (idx < 0) idx = Math.floor(levels.length / 2);
      answers[key] = { type: "score", score: idx, confidence: 0.6 };
      void anchors;
    } else if (q.type === "noul") {
      const claim = String(q.instructions || "").toLowerCase();
      const positiveWords = ["hack", "exploit", "stolen", "approved", "launch", "surge", "record", "inflow"];
      const negativeWords = ["rumor", "speculat", "mulls", "considers", "unknown"];
      const hitPos = positiveWords.some((w) => text.includes(w) || claim.includes(w));
      const hitNeg = negativeWords.some((w) => text.includes(w));
      answers[key] = { type: "noul", noul: hitPos ? 0.82 : hitNeg ? 0.25 : 0.5 };
    }
  }
  return { model: "mock-jev-1.0", answers, latencyMs: 0 };
}

/**
 * The one call: state + questions → all answers in parallel.
 * Uses the real endpoint when TYPESAFE_API_KEY is set, else the mock.
 * Logs model, latency, est. tokens + cost. Throws on hard failure (429
 * backoff/retry is the caller's concern at batch level).
 */
export async function jevSystemOne(env, { state, questions }) {
  const cfg = await jevConfig(env);
  const payload = { state, questions, model: cfg.model };
  const estTokens = Math.ceil(JSON.stringify(payload).length / 4);

  if (!env.TYPESAFE_API_KEY) {
    if (env.JEV_MOCK === "1") {
      const r = mockJevSystemOne(state, questions);
      console.log(`[jev] MOCK call: ${Object.keys(questions).length} questions, ${estTokens} tok est`);
      return r;
    }
    return { unavailable: true, model: cfg.model, answers: {} };
  }

  const t0 = Date.now();
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (j.error) throw new Error(`jev: ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
    const latency = Date.now() - t0;
    const cost = (estTokens / 1_000_000) * JEV_COST_PER_MTOK;
    // decision-log line: model + latency + cost estimate (audit trail)
    console.log(`[jev] model=${j.model || cfg.model} latency=${latency}ms est=${estTokens}tok ≈$${cost.toFixed(6)}`);
    return { model: j.model || cfg.model, answers: j.answers || {}, latencyMs: latency };
  } finally {
    clearTimeout(tid);
  }
}
