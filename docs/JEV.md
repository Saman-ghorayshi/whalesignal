# Jev integration — typed decisions for WhaleSignal

Jev (TypeSafe AI, see `jev/` for the full kit) answers **typed questions**
with calibrated confidence: `Choice` (multi-choice + distribution),
`Score` (word-described spectrum), `Noul` (probability of one claim).
70–500 ms, ~$0.042/MTok input, output free. It cannot generate text, count,
or do date math — aggregation lives in our code.

## Status: built in mock mode, dormant in production

No `TYPESAFE_API_KEY` exists yet (waitlist). Per the kit's own contract, the
integration is complete against the documented API contract with a
**deterministic mock client**, and the real endpoint swaps in the moment
`TYPESAFE_API_KEY` is set as a bot/analyst secret. `JEV_MOCK=1` forces the
full pipeline offline for testing.

## Where it plugs in

1. **News scoring chain: Jev → Gemini → lexicon** (`src/jev_news.js`,
   wired into `scorePendingNews`). One fan-out call per batch of 20
   headlines: per headline a sentiment Score (5 word-described levels),
   event Choice (10 + other), magnitude Score (3 levels), plus one
   prompt-injection Noul per batch (headlines are hostile input).
   Headlines scoring below the confidence threshold are OMITTED and fall
   through to Gemini — thresholds live in KV `config:jev`, never literals.
2. **Whale interestingness shadow score** (`src/jev_whale.js`, wired into
   `analyzeOne`): Pattern-3 composite over 4 dimensions (size, venue,
   novelty, direction clarity), weights in code. LOG-ONLY — it never gates.
   Purpose: accumulate the comparison dataset against the hand-tuned
   interestingness heuristic; promote only if it predicts graded outcomes
   better.

## Files

- `src/jev.js` — wrapper: one fan-out call, model pin, latency + token/cost
  logging, sanitization, deterministic mock
- `src/jev_news.js` — headline question set + confidence gating
- `src/jev_whale.js` — shadow composite scorer
- `eval/news_labeled.jsonl` — 30 hand-labeled headlines (sentiment/event/magnitude)
- `eval/run_news_eval.mjs` — eval runner: agreement per dimension +
  confidence-bucket calibration + threshold recommendation

## Testing

- `tests/jev.test.js` — 8 tests: mock determinism, fan-out shape,
  sanitization (injection strings stripped), confidence gating (low-conf
  omitted), shadow composite bounds, the analyst chain both ways (Jev first;
  without Jev the Gemini path unchanged)
- `node eval/run_news_eval.mjs` — runs offline on the mock

## Honest limits

- The mock validates the PLUMBING, not judgment quality (its eval agreement
  is ~13% — deterministic keyword matching, not intelligence). The day the
  key arrives, `TYPESAFE_API_KEY=... node eval/run_news_eval.mjs` produces
  the agreement + calibration numbers that justify or reject the thresholds
  BEFORE the live chain is enabled (drop the key into the secret and the
  chain is live; tune `config:jev` per the eval output).
- Jev is a third-party early-access product: the endpoint/response shape is
  implemented per `jev/02-api-reference.md`; verify against the installed
  SDK/actual API on first real call (the wrapper isolates all of it).
