# 03 — The Five Core Patterns

These five patterns cover essentially every good Jev use case. Code is Python; the TypeScript
equivalents are direct translations (see `examples/typescript/`).

---

## Pattern 1 — Speculative fan-out: ask everything at once

**Idea:** Don't ask what you need *now* — ask everything you could conceivably *act on* in one
call. All questions are answered in parallel for one input price. Serial asking is ~10x slower and
~12x more expensive (TypeSafe's measured numbers), and the extra answers are free.

**When:** every online decision point. Default to this.

```python
response = client.system_one(
    state={"ticket": ticket_text, "account": account_profile},
    questions={
        "department":        Choice(...),   # routing
        "urgency":           Score(...),    # SLA
        "frustration":       Score(...),    # escalation
        "refund_requested":  Noul(...),     # triggers refund workflow
        "policy_supports":   Noul(...),     # "our refund policy supports this request"
        "churn_risk":        Score(...),    # retention outreach
    },
)
```

Even if you only *use* two answers today, fan out — future features read answers you already have.
Speculative questions cost nothing extra in latency or dollars.

---

## Pattern 2 — Confidence-gated routing (thresholds per action)

**Idea:** Jev tells you when it's guessing. Every action gets a threshold; below it, the case goes
to a human or a bigger model. This is the difference between "an AI demo" and "automation you can
ship."

**When:** always. No exceptions.

```python
THRESHOLDS = {
    "min_route_confidence": 0.50,   # below → human queue
    "min_autorefund_confidence": 0.85,
    "refund_noul": 0.70,            # refund believed requested
    "escalate_frustration": 1.50,   # > "annoyed" on the 5-level scale
    "escalate_urgency": 1.50,
}

def route(ticket, answers, t=THRESHOLDS):
    dept = answers["department"]
    if dept.confidence < t["min_route_confidence"]:
        return {"action": "human_review", "reason": f"routing confidence {dept.confidence:.2f}"}

    if (dept.choice == "billing"
            and answers["refund_requested"].noul > t["refund_noul"]
            and answers["policy_supports"].noul > 0.60
            and dept.confidence >= t["min_autorefund_confidence"]):
        return {"action": "auto_refund_workflow"}

    if (answers["frustration"].score > t["escalate_frustration"]
            and answers["urgency"].score > t["escalate_urgency"]):
        return {"action": "escalate_to_senior"}

    return {"action": f"route_{dept.choice}"}
```

Key moves:

- **Threshold per action, not global.** Auto-refunding money needs far more certainty than
  picking a queue.
- **Cheap insurance on mid confidence.** 0.30–0.50 confidence → attach the runner-up option as a
  one-click choice for a human instead of a full manual review.
- **Distribution-driven UX.** `probabilities` of 0.67 billing / 0.28 technical → show the customer
  a 2-button picker and route on their click.
- Thresholds are **tuned on evals** (see `04-failure-modes.md` §9), never guessed in production.

---

## Pattern 3 — Composite scoring (dimensions in the model, weights in code)

**Idea:** One "quality score" question gets you one muddy answer. Instead, score each dimension
separately (Jev answers them all in parallel), then combine with **explicit weights in code** where
you control them, can audit them, and can unit-test them.

```python
questions = {
    "skills_match":  Score(instructions="How well do the candidate's listed skills cover the role requirements?",
                           criteria=["no overlap", "minimal", "partial", "strong", "expert"]),
    "domain_fit":    Score(instructions="Depth of experience in this specific industry.",
                           criteria=["none", "adjacent", "some", "extensive", "industry expert"]),
    "communication": Score(instructions="Quality of written communication in the application.",
                           criteria=["poor", "adequate", "good", "excellent"]),
}

WEIGHTS = {"skills_match": 0.5, "domain_fit": 0.3, "communication": 0.2}

def composite(answers, weights=WEIGHTS):
    total = sum(answers[k].score * w for k, w in weights.items())
    max_possible = sum((len(criteria_levels) - 1) * w for ...)  # normalize 0..1
    return total / max_possible
```

Rules that make this work:

- Each dimension is **atomic** — one concept only ("leadership" and "technical depth" don't mix).
- **Weights live in config**, not in the model. Weight changes are auditable code changes.
- Output includes **why**: surface per-dimension scores in the UI, not just the blended number.

---

## Pattern 4 — The cascade (Jev decides who deserves the frontier model)

**Idea:** Jev as the always-on first stage that decides which specialist gets the expensive cases.
This turns one flat LLM app into a tiered system.

```
Jev (classify + score + confidence)
 ├─ deterministic handler   ← 82% of traffic, ~$0.00003/case
 ├─ specialist LLM prompt   ← 15%, chosen BY NAME (routing = Choice)
 └─ human queue             ← 3%, low-confidence + edge cases
```

```python
def cascade(message, answers):
    intent = answers["intent"]            # Choice: e.g. 20 named intents + "other"
    complexity = answers["complexity"]    # Score: ["trivial", "simple", "moderate", "complex"]

    if intent.choice == "other" or intent.confidence < 0.40:
        return human_queue(message)

    handler = HANDLER_PROMPTS.get(intent.choice)
    if handler is None:
        return human_queue(message)

    if complexity.score > 2.0 or answers["safety"].noul > 0.30:
        return frontier_model(handler.big_prompt, message)   # GLM/Claude/GPT class
    return cheap_llm_or_template(handler.small_prompt, message)
```

Measured on production traffic (TypeSafe's router example): **$6,480 vs $30,400 per 1M messages**
— a 4.7x cost cut — *with better answers*, because each specialist prompt got narrow and focused.

The trick: **routing by named intent** means each intent maps to its own tuned prompt. Small
models answer narrow prompts well.

---

## Pattern 5 — Retrieve-then-judge

**Idea:** Jev doesn't know the news. Give it retrieved documents (RAG-style) and it judges them
better than frontier models judge their own guesses. "Fetch precisely, judge cheaply."

Two shapes:

**A. Judge candidates** (generated elsewhere) — e.g. summarization quality:

```python
# candidates generated once by an LLM (Jev cannot generate)
response = client.system_one(
    state={
        "source_article": article,
        "candidate_a": candidates[0],
        "candidate_b": candidates[1],
        "criteria": ["key facts preserved", "no hallucination", "concise"],
    },
    questions={
        "winner": Choice(instructions="Which summary better meets the criteria in state?",
                         criteria={"candidate_a": "...", "candidate_b": "...", "neither": "..."}),
    },
)
```

**B. Judge retrieved documents** — literature screening, evidence checks:

```python
questions = {
    "is_relevant":  Noul("This paper directly investigates the research question."),
    "has_data":     Noul("The paper reports original empirical data (not a review)."),
    "evidence":     Score(instructions="Strength of study design for this question.",
                          criteria=["anecdote", "case study", "observational", "quasi-experimental",
                                    "randomized controlled trial"]),
}
```

TypeSafe's own 1,000-paper literature screening: 11x cheaper, 3x faster, near-identical recall vs
a frontier model. The pattern generalizes to any "search → filter → deep-read" pipeline.

---

## Bonus pattern — Counting via per-item Nouls

Jev cannot count (see `04-failure-modes.md` §2). When you need a count, ask one Noul **per item**
and sum in code:

```python
questions = {f"item_{i}": Noul(f"Checklist item '{item}' is completed in this report.")
             for i, item in enumerate(checklist)}
completed = sum(1 for i in range(len(checklist))
                if response.answers[f"item_{i}"].noul > 0.5)
```

This is also the honest API: each judgment is auditable, and you can threshold per item.
