# Jev Cheatsheet

**Jev = typed decisions, not text.** One call: `state` + questions → all answers in parallel,
70–500 ms, $0.042/MTok input, output free, ~1,200 req/min, 64k context.

## The three questions

```python
Choice(instructions="Which team owns this ticket?",
       criteria={"billing": "...", "technical": "...", "other": "ALWAYS"})   # ≤255 options
# → .choice  .probabilities  .confidence

Score(instructions="How urgent?",
      criteria=["not urgent", "normal", "time-sensitive", "urgent", "drop everything"])  # 2–10
# → .score (float BETWEEN levels, 0-indexed)  .confidence

Noul(instructions="The customer is asking for money back (credits count, disputes don't).")
# → .noul (0..1).  NO confidence — the number IS the belief.
```

## Golden rules

1. All questions in ONE call (parallel, one price).
2. Threshold per action; below → human. Always.
3. `other` on every Choice; word-described single-direction Score levels; positive one-sentence Noul.
4. No counting, no date math — per-item Nouls + code; enumerated date fields + code.
5. Pin model (`jev-1.13.0`), log `response.model`.
6. State = filtered facts, not dumps; user text is hostile input.
7. Generation → LLM/template, gated by Jev. Jev never writes text.

## Threshold recipe (B1 triage)

```python
if dept.confidence < 0.50:                      → human_review
if refund.noul > .70 and policy.noul > .60 \
   and dept.confidence >= .85:                  → auto_refund
if frustration.score > 1.5 and urgency.score > 1.5: → escalate
else:                                           → route_{dept.choice}
```

## Cost line

`est_tokens = len(json.dumps(payload)) / 4` → `cost = tokens/1e6 × $0.042`.
Typical call ~800 tok ≈ **$0.000034** → 1M calls ≈ **$34**; 100k reviews ≈ **$1.68**.

## Install / call

```bash
pip install typesafe-sdk        # or: npm install @typesafe-ai/sdk
export TYPESAFE_API_KEY="jev-..."   # console.typesafe.ai/settings/keys
npx skills add typesafe-ai/skills --skill typesafe-ai   # optional agent skill
```

```python
from typesafe_sdk import TypeSafeClient, Choice, Score, Noul
client = TypeSafeClient(model="jev-1.13.0")
r = client.system_one(state={...}, questions={"k": Choice(...), ...})
r.answers["k"].choice / .score / .noul / .confidence   # r.model → log it
```

## Pattern picker

| Need | Pattern |
|---|---|
| Any online decision | 1. Speculative fan-out (ask everything now) |
| Automation you can ship | 2. Confidence-gated routing (thresholds per action) |
| Quality/ranking score | 3. Composite scoring (dimensions in model, weights in code) |
| LLM app too slow/expensive | 4. Cascade (Jev routes to handlers/specialists/humans) |
| Judge documents/candidates | 5. Retrieve-then-judge (fetch precisely, judge cheaply) |
| Count/aggregation | per-item Nouls + sum in code |

## Failure quick-map

Literal reading → write the missing half · Can't count → per-item Nouls · Dates → enums + code ·
Big state → filter/split · User injection → sanitize/structure/red-team Noul · Muddy scores → fix
polarity · Needs prose → LLM stage.
