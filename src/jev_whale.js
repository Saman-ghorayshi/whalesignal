// src/jev_whale.js — Jev shadow-scoring for whale interestingness
// (Pattern 3: dimensions scored by the model, weights in code, composite
// normalized 0..1 — always auditable per-dimension).
//
// SHADOW MODE BY DESIGN: when TYPESAFE_API_KEY is set, every analyzed whale
// also gets a Jev composite score that is LOGGED NEXT TO the hand-tuned
// interesting_score but NEVER gates anything. After enough rows exist, the
// two can be compared (does the model's judgment beat the hand-tuned
// heuristic at predicting graded outcomes?) and only then promoted.
// Without a key this module is inert.

import { jevSystemOne, sanitizeText } from "./jev.js";

const DIMENSIONS = {
  size_significance: {
    instructions: "How significant is this transfer's USD size for the crypto market?",
    criteria: ["negligible", "small", "notable", "large", "market-moving"],
    weight: 0.35,
  },
  venue_relevance: {
    instructions: "How relevant is the exchange or custody involvement for trading this asset?",
    criteria: ["irrelevant", "tangential", "relevant", "highly relevant"],
    weight: 0.25,
  },
  novelty: {
    instructions: "How unusual is this event compared to routine wallet operations?",
    criteria: ["routine", "somewhat unusual", "unusual", "rare"],
    weight: 0.25,
  },
  direction_clarity: {
    instructions: "How clearly does the event direction (buying vs selling pressure) read from the facts?",
    criteria: ["ambiguous", "weak hint", "clear", "unambiguous"],
    weight: 0.15,
  },
};

/** Build filtered state: only facts relevant to the four dimensions.
 *  Whale addresses are hostile third-party strings — sanitized. */
function whaleState(whale) {
  return {
    asset: String(whale.symbol ?? "").toUpperCase(),
    chain: String(whale.chain ?? "").toLowerCase(),
    transfer_type: String(whale.tx_type ?? "unknown"),
    usd_value: Math.round(Number(whale.usd_value) || 0),
    // hostile strings sanitized + bounded
    from_address: sanitizeText(whale.from_address, 60),
    to_address: sanitizeText(whale.to_address, 60),
  };
}

/**
 * Shadow-score one whale. Returns null when Jev is unavailable.
 * { composite: 0..1, dimensions: {name: {score, weight}}, model }
 */
export async function jevWhaleShadow(env, whale) {
  if (!env.TYPESAFE_API_KEY && env.JEV_MOCK !== "1") return null;
  const questions = {};
  for (const [name, d] of Object.entries(DIMENSIONS)) {
    questions[name] = { type: "score", instructions: d.instructions, criteria: d.criteria };
  }
  const r = await jevSystemOne(env, { state: whaleState(whale), questions });
  if (r.unavailable) return null;

  let composite = 0, maxPossible = 0;
  const dimensions = {};
  for (const [name, d] of Object.entries(DIMENSIONS)) {
    const raw = Number(r.answers?.[name]?.score) || 0;
    const max = (d.criteria.length - 1) || 1;
    dimensions[name] = { score: raw, normalized: Math.round((raw / max) * 100) / 100, weight: d.weight };
    composite += (raw / max) * d.weight;
    maxPossible += d.weight;
  }
  return {
    composite: maxPossible ? Math.round((composite / maxPossible) * 100) / 100 : 0,
    dimensions,
    model: r.model,
  };
}
