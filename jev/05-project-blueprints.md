# 05 — Project Blueprints: what to build with Jev, and how

Nine projects, ranked roughly by buildability × payoff. Each spec is complete enough to hand to a
coding agent as-is: problem, why Jev beats the alternatives, architecture, the exact question set,
routing thresholds, cost estimate, and pitfalls.

Shared assumptions: Python or TypeScript; ~800 tokens per decision call ≈ **$0.000034/item**
(≈ **$34 per million items**); latency 70–500 ms fits inside normal request handlers.

| # | Project | Effort | Jev role | Killer stat |
|---|---|---|---|---|
| B1 | Support-ticket triage & routing service | 1–2 days | Classify + score + gate | ~150x cheaper than LLM triage, 70–500ms |
| B2 | Email auto-sorter & priority inbox | 2–3 days | Classify + flag | One call replaces 5 LLM calls per email |
| B3 | RAG relevance gate | 1 day | Filter retrieved chunks | Cut LLM context cost 30–60% |
| B4 | LLM output judge & guardrail | 1–2 days | Score generated content | Judge with provided context beats LLM self-grading |
| B5 | Review/comment analytics at scale | 2–3 days | Tag + score + detect at volume | 100k reviews ≈ **$1.68** |
| B6 | GitHub issue triage bot | 1–2 days | Label + severity + route | Prior art: jev-review, 40k decisions, 94% agreement |
| B7 | Application/resume screener | 2 days | Composite scoring | Auditable per-dimension scores |
| B8 | Research literature screener | 2–3 days | Retrieve-then-judge | 11x cheaper, 3x faster than frontier (1kpapers) |
| B9 | Chat front-door / intent router | 2 days | The cascade | 4.7x cheaper with better answers |

---

## B1. Support-Ticket Triage & Routing Service ⭐ start here

**The canonical Jev use case — build this first even if your real target is B5 or B9; it teaches
every pattern in one build.**

**Problem.** Every ticket currently costs either a human read (slow) or a frontier LLM call
(expensive, needs JSON parsing, retries, and still hallucinates structure).

**Why Jev.** One 70–500 ms call answers routing, urgency, sentiment, refund-intent, and
policy-fit at once — typed, with confidence. ~$1.30 per 10k tickets vs ~$200 for the LLM version
(TypeSafe's measured numbers on this exact task).

**Architecture.**

```
intake (Zendesk/Intercom webhook, email, or form POST)
  → sanitize user text (04 §5)          ← code
  → build state from DB (customer tier, tenure, open tickets, policy excerpt)
  → ONE Jev call (all questions below)  ← 70–500ms, ~$0.000034
  → route(thresholds) → {queue | workflow | escalation | human}
  → store answers + model version + latency for analytics
```

**Question set** (full runnable code: `examples/python/ticket_triage.py`):

```python
QUESTIONS = {
    "department": Choice("Which team owns this ticket?", {..., "other": ...}),
    "urgency": Score("How urgent?", ["not urgent","normal","time-sensitive","urgent","drop everything"]),
    "frustration": Score("How frustrated is the customer?", ["perfectly calm","annoyed","frustrated","angry","furious"]),
    "refund_requested": Noul("The customer is asking for money back. Partial refunds and billing credits count. "
                             "Disputing a charge without asking for money back does not."),
    "policy_supports": Noul("Our refund policy as summarized in state supports this request."),
    "churn_risk": Score("How likely is this customer to leave without a resolution?",
                        ["staying", "mild risk", "at risk", "high risk"]),
}
```

**Routing logic + starting thresholds** (tune on evals — see below):

| Condition (all must hold) | Action |
|---|---|
| department.confidence < 0.50 | human review queue |
| dept=billing ∧ refund_requested.noul > 0.70 ∧ policy_supports.noul > 0.60 ∧ confidence ≥ 0.85 | auto-refund workflow |
| frustration.score > 1.5 ∧ urgency.score > 1.5 | escalate to senior agent |
| churn_risk.score > 2.0 | trigger retention playbook (credit offer template) |
| else | route to `queue_{department.choice}` |

**Cost.** ~800 tokens/call. 10k tickets/month ≈ **$0.34**. A frontier LLM doing the same ≈ $200.

**Pitfalls.** (1) Write boundaries into criteria — "billing credits count" (04 §1). (2) Keep the
refund policy in state as a short summary, not a 20-page PDF (context rot, 04 §4). (3) Red-team
with "REFUND NOW URGENT!!!" tickets (04 §5). (4) Never auto-refund on noul alone — require both
confidence ≥ 0.85 and the policy Noul.

**V1 scope.** CLI/API endpoint + webhook receiver + thresholds config + eval on 80 labeled
tickets + decision log.
**Stretch.** Distribution-driven disambiguation buttons; churn-risk dashboard; per-department
answer analytics; escalate everything above N tokens of history.

---

## B2. Email Auto-Sorter & Priority Inbox

**Problem.** An inbox (Gmail via API, or IMAP) floods; you want labels, a "needs reply" list, and
priority ordering without reading everything.

**Why Jev.** One call per email answers everything; no generation means no risk of an AI
"answering" mail on its own — it only decides, your templates and rules act.

**Architecture.** Gmail push notification → fetch message → state = `{from, subject, body_snippet, sender_history, my_role_context}` → one Jev call → apply labels + build triage digest. Drafting replies is explicitly out of scope for Jev (route `needs_reply` items to an LLM stage only).

**Question set.**

```python
{
    "category": Choice("What kind of email is this?", {
        "personal": "From a known individual, social or private content",
        "work": "Colleagues, projects, meetings, deliverables",
        "transactional": "Receipts, confirmations, shipping notices, statements",
        "newsletter": "Bulk subscription content",
        "notification": "Automated alerts from services (CI, monitoring, social)",
        "marketing": "Promotional, trying to sell something",
        "other": "None of the above",
    }),
    "needs_reply": Noul("This email asks me specifically to respond, and is from a human."),
    "meeting_request": Noul("This email proposes or reschedules a meeting."),
    "has_deadline": Noul("This email states a deadline or time-sensitive request for me."),
    "priority": Score("How much does this need my attention today?",
                      ["ignore", "someday", "this week", "today", "next hour"]),
}
```

**Actions.** `needs_reply.noul > 0.6 ∧ category=personal|work` → top of reply queue (sorted by
`priority.score`); `meeting_request` → extract proposed times via an LLM stage or templates;
`transactional` → archive + label; `newsletter/marketing` → skip inbox (label + skip
notifications); anything with confidence < 0.5 → leave in inbox untouched (fail-safe default).

**Cost.** ~400–600 tokens/email → 5k emails/month ≈ **$0.10**.

**Pitfalls.** Marketing mail is adversarial state — it impersonates "your account" and urgency;
sanitize, structure, and keep the `needs_reply` claim strict ("from a human"). Body snippet, not
full email with 12 quoted threads (context rot).

**Stretch.** Sender-history field in state (repeat senders get classified faster/better);
unsubscribe suggestions for marketing you never open; weekly digest generated by an LLM from Jev's
stored answers.

---

## B3. RAG Relevance Gate (drop into any existing RAG/agent app)

**Problem.** Your RAG pipeline stuffs top-k vector results into a frontier LLM context. Half are
irrelevant; you pay for them in tokens *and* in answer quality (distractors degrade generation).

**Why Jev.** Judge-with-provided-context is Jev's home turf — it judged retrieved papers better
than frontier models judged their own guesses. Insert one cheap pass between retrieval and
generation.

**Architecture.**

```
query → vector search (top 20–50 chunks)
      → ONE Jev call: all chunks in state, per-chunk Nouls
      → keep chunks passing filters (code)
      → LLM generation with the survivors only
```

**Question set** (per chunk, one call):

```python
{f"chunk_{i}_relevant": Noul(f"Chunk {i} contains information that helps answer the question in state.")
 for i in range(len(chunks))}
# plus, if your corpus is citation-sensitive:
{f"chunk_{i}_supports": Noul(f"Chunk {i} directly supports the claim being checked.")
 for i in range(len(chunks))}
```

**Filters.** Keep `relevant.noul > 0.35` (recall-friendly; tune on evals); rank survivors by noul;
cap at N chunks for generation. If **zero** pass → return "no good sources" instead of letting the
LLM hallucinate from bad context.

**Cost.** Gate: 20 chunks × ~150 tokens ≈ 3k tokens ≈ $0.00013/query — vs saving 5–15k tokens of
LLM context at $3–15/MTok (≈ $0.02–0.20/query). Net 10–100x on the generation stage, plus better
answers.

**Pitfalls.** Don't ask Jev "which chunk is best" as a single Choice over chunks (255-option
menus are fine, but per-chunk Nouls give rankable, thresholdable numbers — prefer them). Number
the chunks and reference by index in the Noul text, exactly as above.

---

## B4. LLM Output Judge & Guardrail Service

**Problem.** You generate content with any LLM (support replies, marketing copy, code-review
summaries). You need a cheap, consistent quality/safety check before it ships.

**Why Jev.** "Grading with a rubric" is a Spectrum task; consistency across thousands of gradings
is exactly what a decision model beats a generative model at. Judge sees your context and rubric —
not the world — so verdicts are auditable.

**Architecture.** LLM generates → Jev judges (one call) → pass / regenerate / human.

**Question set.**

```python
{
    "toxic": Noul("The response contains toxic, harassing, or hateful content."),
    "on_topic": Noul("The response addresses the user's original question."),
    "grounded": Noul("Every factual claim in the response is supported by the context provided in state."),
    "follows_instructions": Noul("The response obeys all constraints listed in state (tone, length, format)."),
    "quality": Score("Overall quality of this response for the user's purpose.",
                     ["unusable", "needs rewrite", "acceptable", "good", "excellent"]),
}
```

**Actions.** `toxic.noul > 0.3` → block + log (hard gate); `grounded.noul < 0.5` → regenerate with
a "cite only from context" prompt nudge (max 2 retries); `quality.score < 2.0 ∧ confidence < 0.6`
→ human review; else ship.

**Cost.** ~600–1,000 tokens/judgment ≈ $0.00004. Judging every output of a 100k-generation/month
product ≈ **$4**.

**Pitfalls.** "Grounded" means grounded **in the provided context** — always include the source
context in state, or the claim is meaningless. Toxicity thresholds are policy decisions: tune on a
labeled set, log everything, start strict.

---

## B5. Review & Comment Analytics at Scale

**Problem.** 100k product reviews/comments: tag them, score sentiment, find defects, find fakes.
LLM-per-review is $500+; regex misses everything that matters.

**Why Jev.** This is bulk judgment — the single cheapest thing Jev does. 100k items ≈ **$1.68**.

**Architecture.** Batch worker (queue or cron): pull reviews → group by product → one Jev call per
review (or small batches) → aggregate in SQL → dashboard.

**Question set** (one call per review):

```python
{
    "aspect": Choice("Which aspect of the product is this review mainly about?", {
        "quality": "Build quality, durability, materials",
        "shipping": "Delivery speed, packaging, condition on arrival",
        "price": "Value for money, cost complaints or praise",
        "service": "Customer service, returns, support interactions",
        "usability": "Ease of use, instructions, setup",
        "other": "General or mixed feedback",
    }),
    "sentiment": Score("How positive is this review?",
                       ["furious", "negative", "mixed", "positive", "delighted"]),
    "defect": Noul("The reviewer describes the product failing, breaking, or malfunctioning."),
    "fake": Noul("This review looks templated, incentivized, or unrelated to the product "
                 "(generic praise, off-topic text, repeated phrasing)."),
    "refund_demand": Noul("The reviewer explicitly wants a refund or return."),
}
```

**Aggregation (code, not model).** Defect rate by aspect × SKU; fake-review flag rate by
seller (cluster on repeated phrasing separately with code); sentiment trend over time;
`refund_demand ∧ defect ∧ sentiment < 1.0` → auto-open support ticket.

**Cost.** ~400 tokens/review → 100k = 40M tokens = **$1.68 total**. Run it weekly.

**Pitfalls.** Don't ask "how many reviews mention defects" over a batch (counting, 04 §2) —
per-review Nouls, sum in SQL. Fake-review detection is signal, not verdict: threshold high and
keep a human in the loop for seller penalties.

---

## B6. GitHub Issue / Bug-Report Triage Bot

**Problem.** OSS repo or internal tracker drowns in unlabelled issues; maintainers burn hours
routing, and bad reports sit unanswered.

**Why Jev.** Prior art ships: `jev-review` runs 40k code-review decisions with **94% agreement,
99.997% explicit-criterion agreement** vs humans. Issue triage is the same shape of problem.

**Architecture.** GitHub webhook (`issues.opened` / `issue_comment.created`) → fetch issue body +
comments + repo area list → one Jev call → apply labels via API → post a static checklist comment
when info is missing (template, not AI prose).

**Question set.**

```python
{
    "kind": Choice("What kind of issue is this?", {
        "bug": "Reports broken behavior",
        "feature": "Requests new functionality",
        "question": "Asks how to do something",
        "docs": "Documentation problem or request",
        "spam": "Advertisement or unrelated content",
        "other": "None of the above",
    }),
    "severity": Score("If this is a bug, how severe?", ["trivial", "minor", "moderate", "major", "critical"]),
    "has_repro": Noul("The issue contains steps or a link that reproduce the problem."),
    "has_version": Noul("The issue states the affected version or environment."),
    "area": Choice("Which part of the codebase is likely involved?", {...front/back/infra/docs/unknown...}),
}
```

**Actions.** Labels: `kind`, `area`, `severity ≥ 3` → `priority`. Missing repro/version → post the
static checklist comment + `needs-info` label (this alone fixes ~30% of bad reports). `spam` →
close with template. `kind=question ∧ confidence > 0.8` → point to discussions. Everything at
confidence < 0.5 → label `needs-triage` for a human.

**Cost.** ~600 tokens/issue ≈ **$0.000025** — a 1,000-issue month costs 2.5 cents.

**Pitfalls.** Users write "URGENT!!!" — the adversarial-state rules apply (04 §5); severity must
come from described impact (criteria: "critical = data loss or outage"), not exclamation marks.
Keep the area list to real top-level components (≤ 20 + `unknown`).

---

## B7. Application / Resume Screener (with guardrails)

**Problem.** 500 applicants for a role; humans can't do a careful first pass on all of them.

**Why Jev.** Composite scoring per dimension (Pattern 3) is auditable — every applicant carries
per-dimension scores and the weights are in your config, reviewable and bias-testable. A flat
LLM "score this resume 1–10" is neither.

**Architecture.** ATS export / upload → parse resume text → state = `{resume_text, job_requirements, screening_criteria}` → one Jev call → composite score in code → ranked list with per-dimension breakdowns.

**Question set.**

```python
{
    "skills_match": Score("How well do the candidate's listed skills cover the required skills in state?",
                          ["no overlap", "minimal", "partial", "strong", "expert"]),
    "domain_fit": Score("Depth of directly relevant industry/domain experience.",
                        ["none", "adjacent", "some", "extensive", "industry expert"]),
    "seniority": Score("Evidence of seniority for this role's level.",
                       ["below level", "approaching", "at level", "above level"]),
    "communication": Score("Quality of written communication in the resume and cover letter.",
                           ["poor", "adequate", "good", "excellent"]),
    "meets_hard_requirements": Noul("The candidate meets every must-have requirement listed in state."),
}
```

**Composite.** `weights = {skills: .40, domain: .25, seniority: .20, communication: .15}` in
config; `meets_hard_requirements.noul < 0.6` → exclude regardless of score; top-N go to humans
with the per-dimension table attached.

**Cost.** ~900 tokens/application → 500 applicants ≈ **$0.02**.

**⚠️ Compliance guardrails (non-negotiable).**
- **No protected characteristics** — never ask about (or include state fields revealing) age,
  gender, ethnicity, photos, marital status. Strip them from parsed text where feasible.
- **Human decision** — Jev ranks and explains; a human rejects/interviews. Never auto-reject.
- **Audit + bias eval**: run the labeled-set eval (04 §9) with demographic-blind criteria; log
  every score for audit; check adverse impact before deploying. When in doubt, keep the tool as
  "prioritization aid" not "filter."

---

## B8. Research Literature Screener

**Problem.** "Find every RCT on X published since 2023" — 2,000 search results, a week of reading.
Prior art: TypeSafe's 1kpapers run — **11x cheaper, 3x faster, near-identical recall** vs a
frontier model.

**Why Jev.** Pattern 5 (retrieve-then-judge) in its purest form: fetch candidates from scholarly
APIs, judge each with a stable rubric in one call.

**Architecture.**

```
query → search APIs (Valyu, Semantic Scholar, arXiv, PubMed)
      → for each paper: fetch title + abstract
      → ONE Jev call per paper (or batch abstracts)
      → shortlist by filters → export CSV/BibTeX + report
```

**Question set.**

```python
{
    "is_relevant": Noul("This paper directly investigates the research question in state."),
    "empirical": Noul("The paper reports original empirical data, not a review or opinion piece."),
    "design_strength": Score("Strength of study design for causal conclusions.",
                             ["anecdote", "case study", "observational", "quasi-experimental",
                              "randomized controlled trial"]),
    "human_subjects": Noul("The study is on human subjects (if that matters for the question)."),
    "recency_ok": Noul("The publication year shown in state is within the date range defined in state."),
}
```

**Note on dates:** publication year is a text field — put the year in state and the target range
in state, and let the Noul compare *equality/labels*, then verify the actual year math in code
(04 §3). Recency is better enforced by API filters where available.

**Filters.** `is_relevant.noul > 0.5 ∧ empirical.noul > 0.6` → shortlist; rank by
`design_strength.score`; RCTs flagged for the evidence table.

**Cost.** ~500 tokens/paper → 2,000 papers ≈ **$0.04**. The expensive part is the fetching, not
the judging.

**Stretch.** Evidence table generator (LLM writes the prose from Jev's structured verdicts);
dedup by title-similarity in code; per-author aggregation.

---

## B9. Chat Front-Door: Intent Router for Any Chat Product

**Problem.** A customer-support / assistant chatbot that calls a frontier model for every message:
slow on trivial stuff, expensive at scale, mediocre at everything because one prompt does
everything.

**Why Jev.** This is the cascade (Pattern 4) — the architecture TypeSafe measured at **$6,480 vs
$30,400 per 1M messages, 4.7x cheaper with better answers**, because named-intent routing lets
each specialist prompt be narrow and good.

**Architecture.**

```
user message → sanitize → ONE Jev call
  ├─ intent = Choice over your 10–20 named intents + "other"
  ├─ complexity = Score, safety = Noul, needs_account_access = Noul
  ├─ 82%: deterministic handler (template / FAQ hit / tool call)        ~$0.00003
  ├─ 15%: specialist LLM, prompt chosen BY INTENT NAME (+ tools)        cheap model if simple
  └─ 3%:  human handoff (intent=other, confidence<0.4, safety>0.3)
```

**Question set.**

```python
{
    "intent": Choice("What does the user want?", {
        "track_order": "...", "return_item": "...", "billing_question": "...",
        "product_question": "...", "greeting": "...", "complaint": "...",
        "account_change": "...", "talk_to_human": "...", "other": "...",
    }),
    "complexity": Score("How complex is this request?",
                        ["trivial", "simple", "moderate", "complex", "research-level"]),
    "safety": Noul("This message touches refunds over $X, legal threats, abuse, or self-harm — "
                   "topics requiring a human."),
    "angry": Noul("The user is visibly angry or threatening to cancel."),
}
```

**Routing.** `intent=greeting ∧ complexity < 1` → static welcome; FAQ intents with
`confidence > 0.7` → template/KB answer; `complexity ≤ 2` → cheap model with the intent's
narrow prompt; `complexity > 2` → frontier model with the intent's full prompt + tools;
`safety.noul > 0.3 ∨ angry.noul > 0.5` → human queue with priority.

**Cost.** The Jev gate adds ~$0.00003/message and removes 4.7x from the generation stage at 1M
messages/month scale.

**Pitfalls.** The intent list is product design — spend real time writing boundary-marking
criteria per intent (04 §1). Track `other`-rate weekly: a rising `other`-rate means new intents
are emerging in your traffic.

---

## What NOT to build with Jev (and the right tool)

| Temptation | Why it fails | Use instead |
|---|---|---|
| Drafting emails/replies/summaries | Cannot generate (04 §7) | LLM (optionally Jev-gated) |
| "Count how many…" in one question | Not a calculator (04 §2) | Per-item Nouls + code |
| "Is this ticket older than 14 days?" | Dates are text (04 §3) | Enumerated fields + code math |
| "Summarize the difference between…" | Generation | LLM; Jev can *pick* the best summary |
| Anything without a confidence gate | Unguarded automation | Add thresholds or don't ship |
| Whole-database judgments in state | Context rot (04 §4) | Retrieve & filter first |

## Choosing your first build

- Want the fastest learning build → **B1** (a weekend, teaches every pattern).
- Already have a RAG/LLM app → **B3** (one day, immediate cost win) then **B9**.
- Have a product with user-generated content → **B5** (cheapest big win, $1.68/100k).
- Maintainer of an OSS repo → **B6**.
