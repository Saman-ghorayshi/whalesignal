# 02 — Jev API Reference (working notes)

One call = your entire program **state** + a dict of typed **questions** → one response containing
**all answers in parallel**. There is no multi-turn conversation; every call is stateless.

```
response = client.system_one(state={...}, questions={...})
```

> Names below follow the launch article and `typesafe-sdk` / `@typesafe-ai/sdk`. The SDK is early —
> verify signatures against the installed package (README + type stubs) before finalizing code.
> (Note: the article also showed `response.nouls[...]` in one snippet; `.answers[key].noul` is the
> consistent accessor — check which your SDK version exposes.)

---

## 1. `state` — what the model sees

`state` is the world the model reasons about. It can be a string, array, or nested object; it is
**text-only** (no images).

Design rules:

1. **Retrieve precisely.** State should be the result of a database query or filtered read, not a
   raw dump. Relevance beats completeness.
2. **Every field must earn its place.** Irrelevant fields don't just cost tokens — they dilute
   attention and measurably degrade answer quality.
3. **Structure it.** Field names are read ("user_tenure_days" tells the model more than a bare
   number in a log line).
4. **Different concerns → different calls (or different states).** If one question needs the
   customer profile and another needs the last 3 support tickets, either make two cheap calls with
   tailored states, or one call with a state that cleanly separates both under named keys.

## 2. `questions` — the three primitives

All questions are asked **in the same call** and answered **in parallel** — asking 2 or 12 costs the
same latency and one input-token price.

### 2.1 `Choice` — multiple choice, with a probability distribution

```python
"department": Choice(
    instructions="Which team owns this ticket?",
    criteria={
        "billing":   "Payment, refund, subscription, invoice issues",
        "technical": "Bugs, errors, crashes, performance",
        "sales":     "Pricing, demos, enterprise plans",
        "other":     "Anything that doesn't fit the above",   # ALWAYS include
    ),
)
```

- Up to **255 options**; the model handles large menus as well as small ones.
- Returns:
  - `.choice` — the winning option key
  - `.probabilities` — full distribution over options
  - `.confidence` — how strongly held (0–1)
- **Always add `other`** so nothing gets force-fitted. Monitor which items land there.
- Write option descriptions like an investigator, not a marketer: specific, boundary-marking.
- Distribution is gold for UX: "67% billing, 28% technical" can drive a 1-click disambiguation.

### 2.2 `Score` — a spectrum with described levels

```python
"frustration": Score(
    instructions="How frustrated is the customer?",
    criteria=["perfectly calm", "annoyed", "frustrated", "angry", "furious"],
)
```

- **2–10 ordered levels**, each described **in words**, not numbers. Vague labels → vague scores.
- Scores are **relative to the described scale**, not comparable across different scales.
- Returns `.score` as a **float that can fall between levels** (e.g. `1.035` on a 5-level scale
  means "more than 'annoyed', less than 'frustrated'").
- **0-indexed from the array order** — a returned `4.0` means the 5th criterion, "furious".
- Never mix directions in one scale ("very bad … very good" is fine; a scale that flips polarity
  mid-way is not).
- Returns `.probabilities` (over levels) and `.confidence`.

### 2.3 `Noul` — probability of one claim, 0–1

```python
"refund_requested": Noul(
    instructions="The customer is asking for money to be returned to them.",
)
```

- One **positive, declarative sentence**. The answer is the probability the claim is true.
- No options to design — all the intelligence goes into the phrasing. This is the hardest
  primitive to write well.
- Returns `.noul` (0–1). **No `.confidence` field** — the number *is* the belief strength
  (unlike Choice/Score, which report a distribution plus a confidence).
- Phrase claims **positively**; avoid stacking negations ("is not missing" → rephrase).
- Nuance lives in the sentence: "the customer would leave without a resolution" reads very
  differently from "the customer mentions canceling."

## 3. Context limits

| Limit | Value |
|---|---|
| Total context | 64k tokens |
| state + single longest question | ≤ 32k tokens |
| Options per Choice | up to 255 |
| Score levels | 2–10 |

Practical reading: for a decision call, state of 500–4,000 tokens is typical and healthy. If you're
approaching the caps, you're dumping, not retrieving — see `04-failure-modes.md` §5.

## 4. The response object

```python
response.model                      # e.g. "jev-1.13.0" — LOG THIS
response.answers["department"].choice
response.answers["department"].probabilities   # {option_key: prob, ...}
response.answers["department"].confidence      # 0..1
response.answers["urgency"].score              # float between levels, 0-indexed
response.answers["refund_requested"].noul      # 0..1, no confidence
```

## 5. Errors and operational behavior

- **429 rate limit** — the SDKs retry with backoff automatically (~1,200 req/min,
  ~250k tok/s ceilings). Design as if retries are normal.
- Keep **all decision thresholds out of code literals** and in config — they're the thing you'll
  tune after evals (see `03-patterns.md` §2 and `06-agent-handoff.md`).
- Log per call: `response.model`, latency, question keys, and a **token estimate**
  (`len(json.dumps(payload)) / 4` is close enough) × $0.042/MTok for cost.

## 6. Question-authoring checklist

- [ ] Every `Choice` has an `other` (or explicit catch-all) option
- [ ] Every `Score` has 2–10 word-described levels, single direction
- [ ] Every `Noul` is one positive declarative sentence, no stacked negation
- [ ] All questions for one item are in ONE call (fan-out, not serial)
- [ ] State contains only fields relevant to the questions asked
- [ ] No question requires counting, arithmetic, or date comparison (see failure modes)
- [ ] Model version pinned; `response.model` logged
