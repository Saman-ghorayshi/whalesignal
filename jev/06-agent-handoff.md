# 06 — Agent Handoff: build instructions for a coding agent

You are a coding agent about to build a feature or product using **Jev**, TypeSafe AI's System One
model. This document is your contract. Read it fully before writing code.

## 0. Required reading order

1. This file.
2. `02-api-reference.md` — the three question types, state rules, limits.
3. `04-failure-modes.md` — what Jev cannot do, and the workaround for each. **You must apply
   these proactively; the user will check.**
4. `03-patterns.md` — the five patterns; match the build to a pattern before coding.
5. `05-project-blueprints.md` — the chosen project's spec (the user will name one, or pick B1 by
   default).
6. `examples/` — the wrapper and reference build; reuse them.

If anything here conflicts with the installed SDK's actual API surface (`pip show typesafe-sdk`,
read the package README/type stubs; or `node_modules/@typesafe-ai/sdk`), **the SDK wins** — adapt
and note the difference in your final report.

## 1. What Jev is (and is not) — hard constraints

- Jev returns **typed decisions** — `Choice` (multiple choice + probability distribution +
  confidence), `Score` (spectrum, 2–10 word-described levels, float between levels),
  `Noul` (probability 0–1 of one positive claim).
- One call answers ALL questions **in parallel**. 70–500 ms. ~$0.042/MTok input, output free.
- It **cannot**: generate text, count items, or do date arithmetic. Never attempt these directly —
  use the workarounds in `04-failure-modes.md`.
- It is **stateless** — no conversation. Every call carries its own state.

## 2. Non-negotiable rules

1. **All questions for an item go in ONE call.** Never loop serial calls when a single fan-out
   call works.
2. **Every Jev-driven action has a confidence/probability threshold**, loaded from config, with a
   human-review (or safe-default) branch below it. An unguarded action is a bug.
3. **Every `Choice` includes an `other`/catch-all option.**
4. **Every `Score` uses 2–10 single-direction, word-described levels.**
5. **Every `Noul` is one positive declarative sentence** with its boundaries written in
   ("X counts, Y does not count").
6. **Never ask it to count or compare dates.** Per-item Nouls summed in code; dates via
   enumerated fields + code math, or pre-computed facts injected into state.
7. **State is filtered, not dumped.** Only fields relevant to the call's questions. Different
   concerns → separate calls with tailored states.
8. **User-supplied text is hostile**: sanitize injection patterns, put user text under its own
   state key, add a prompt-injection Noul when the flow is user-facing, and test with adversarial
   inputs.
9. **Pin the model** (`jev-1.13.0`-style explicit version) and **log `response.model`** on every
   call.
10. **Generation belongs to LLMs/templates, never Jev.** If the feature needs prose, gate with Jev
    and delegate the writing.

## 3. Engineering standards

**Config, not constants.** Decision thresholds, model version, weights, and option lists live in a
config file (YAML/JSON/env), loaded at startup. The code reads them; tuning never requires
recompiling logic.

**Wrapper, not raw SDK.** Route all calls through a wrapper like `examples/python/jev_wrapper.py`
that provides:
- model pinning + logging of `response.model`
- latency + estimated-token/cost logging (`len(json.dumps(payload))/4` tokens × $0.042/MTok)
- error handling (429 backoff comes from the SDK; your wrapper logs and re-raises)
- **an offline `MockJevClient`** with deterministic answers so the full pipeline runs without an
  API key and unit tests never touch the network.

**Tests.** Unit tests use `MockJevClient` (or recorded fixtures) — fast, deterministic, offline.
Routing/threshold logic gets its own table-driven tests (input answers → expected action).

**Eval before automation.** Every build ships `eval/` with:
- a labeled dataset (start with 50–80 real or realistic cases; JSONL: `{state..., expected...}`)
- a runner computing agreement/accuracy + confusion + confidence-bucket calibration
  (see `examples/python/eval_harness.py`)
- a written threshold recommendation derived from the eval output.

**Decision log.** Persist per call: item id, timestamp, `response.model`, latency, all answers
(answers + confidences), the action taken, and the threshold values in force. This is the audit
trail and the tuning dataset.

**Secrets.** `TYPESAFE_API_KEY` from environment only. Never in code, state, logs, or the
decision log.

## 4. Build order (follow unless told otherwise)

1. **Scaffold**: repo/package, config file, wrapper (with mock), logging.
2. **Domain model**: item intake (webhook/CLI/queue), state builder (sanitize + filter + fetch),
   question set, `route()` with thresholds from config.
3. **Offline path green**: full pipeline on `MockJevClient`, table-driven tests for routing.
4. **Real path**: swap in `TypeSafeClient` behind the same interface (key present) — smoke test
   with 5 real items if a key exists; otherwise stop here and report.
5. **Eval**: labeled set → run → tune thresholds → write up results in `eval/RESULTS.md`.
6. **Ship surface**: API endpoint / scheduled worker / bot command — whatever the blueprint
   specifies.
7. **Report**: what was built, what's mocked vs live, eval numbers, tuned thresholds, known
   limitations.

## 5. Definition of done (per project)

- [ ] Pipeline runs end-to-end in mock mode with zero network calls
- [ ] Runs live when `TYPESAFE_API_KEY` is set
- [ ] All 10 rules in §2 verifiably satisfied (call them out in the PR/report)
- [ ] Config holds every threshold/weight/model pin
- [ ] Decision log written on every real call
- [ ] Eval harness + labeled set committed; thresholds justified by `eval/RESULTS.md`
- [ ] Adversarial-input tests present (injection strings, "URGENT!!!" spam)
- [ ] README for the project: setup, run, eval, tuning

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 429s in bulk runs | Rate limits (~1.2k req/min) | SDK backoff + batch; offline jobs off-peak |
| Answers regress silently | Model drift | Pin version; alert on `response.model` ≠ pinned |
| One class always wins | Criteria boundaries missing | Write the missing half (04 §1); add examples to descriptions |
| Probabilities near-flat | Question too vague / state too thin | Sharpen the claim; add relevant state fields |
| Scores cluster mid-scale | Levels vaguely worded | Rewrite levels as concrete behaviors |
| Wildly wrong on long inputs | Context rot | Split concerns; filter state (04 §4) |
| Counts don't add up | Asked it to count | Per-item Nouls + sum (04 §2) |
| `AttributeError` on answers | SDK shape differs from notes | Check SDK stubs; some versions expose `.nouls`; adapt wrapper |

## 7. Default first project (if the user says "just build something")

Build **B1 — support-ticket triage** (`05-project-blueprints.md`): CLI + webhook endpoint +
config + eval, using `examples/python/ticket_triage.py` as the reference. It exercises every
pattern and failure-mode workaround, and becomes the template for everything else in this kit.
