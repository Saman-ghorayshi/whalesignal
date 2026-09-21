# 01 — Getting Started with Jev

## 1. Get access

1. Go to **console.typesafe.ai/settings/keys** and request/join the waitlist (early access).
2. When granted, create an API key.
3. Alternative route: Jev is also available through the **Vercel AI Gateway** if you already route
   models through it.

Export the key everywhere you'll run code:

```bash
# Linux/macOS
export TYPESAFE_API_KEY="jev-..."

# Windows (PowerShell)
$env:TYPESAFE_API_KEY="jev-..."

# Windows (Git Bash)
export TYPESAFE_API_KEY="jev-..."
```

> **No key yet?** You can still build today. The wrapper in `examples/python/jev_wrapper.py` ships
> a deterministic `MockJevClient` so the whole pipeline (routing logic, thresholds, tests) can be
> developed and tested offline. Swap in the real client the day the key arrives.

## 2. Install the SDK

```bash
# Python
pip install typesafe-sdk

# TypeScript / JavaScript
npm install @typesafe-ai/sdk
```

## 3. Hello world — Python

```python
from typesafe_sdk import TypeSafeClient, Choice, Score, Noul

client = TypeSafeClient()  # reads TYPESAFE_API_KEY from env

response = client.system_one(
    state={"ticket": "Refund please, charged twice this morning and I'm furious."},
    questions={
        "department": Choice(
            instructions="Which team owns this ticket?",
            criteria={
                "billing": "Payment, refund, subscription, invoice issues",
                "technical": "Bugs, errors, crashes, performance",
                "sales": "Pricing, demos, enterprise plans",
                "other": "Anything that doesn't fit the above",
            },
        ),
        "urgency": Score(
            instructions="How urgent is this ticket?",
            criteria=["not urgent", "normal", "time-sensitive", "urgent", "drop everything"],
        ),
        "refund_requested": Noul(
            instructions="The customer is asking for money to be returned to them.",
        ),
    },
)

a = response.answers
print(a["department"].choice)          # e.g. "billing"
print(a["department"].confidence)      # e.g. 0.97
print(a["urgency"].score)              # e.g. 2.87 (float between levels, 0-indexed)
print(a["refund_requested"].noul)      # e.g. 0.94 (probability, 0..1)
```

## 4. Hello world — TypeScript

```typescript
import { choice, score, noul, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY from env

const response = await client.systemOne({
  state: { ticket: "Refund please, charged twice this morning and I'm furious." },
  questions: {
    department: choice("Which team owns this ticket?", {
      billing: "Payment, refund, subscription, invoice issues",
      technical: "Bugs, errors, crashes, performance",
      sales: "Pricing, demos, enterprise plans",
      other: "Anything that doesn't fit the above",
    }),
    urgency: score("How urgent is this ticket?", [
      "not urgent", "normal", "time-sensitive", "urgent", "drop everything",
    ]),
    refund_requested: noul("The customer is asking for money to be returned to them."),
  },
});

const a = response.answers;
console.log(a.department.choice);       // "billing"
console.log(a.department.confidence);   // 0.97
console.log(a.urgency.score);           // 2.87
console.log(a.refund_requested.noul);   // 0.94
```

## 5. Direct HTTP (no SDK)

The SDKs wrap a plain REST endpoint. Useful for languages without an SDK yet:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
```

The body follows the SDK payload shape (`state` + `questions`). Prefer the SDKs — they handle
serialization, retries and rate-limit backoff for you.

## 6. Model pinning

Pass an explicit version instead of the rolling alias, **especially once you've tuned decision
thresholds** — new model versions can shift scores slightly:

```python
client = TypeSafeClient(model="jev-1.13.0")
```

Always log the version that actually answered (the response carries a `model` field) so a triage
regression can be traced to a silent upgrade.

## 7. Limits and retries

| Limit | Value | What to do |
|---|---|---|
| Rate limit | ~1,200 req/min, ~250k tok/s | SDK retries with backoff on 429; batch offline work in bulk, keep online calls inside request handlers |
| Context | 64k total; state + longest question ≤ 32k | Trim state — retrieve and filter, never dump raw dumps/logs |
| Latency | 70–500 ms | Fine for request paths; never loop calls serially when they could be one call |

## 8. Cost math you'll reuse constantly

- $0.042 per **million input tokens**; output is **free**. A "token estimate" of
  `len(json.dumps(payload)) / 4` is close enough for cost logging.
- Typical online decision call (state ~500–800 tokens): **≈ $0.00003–0.00004 per call**.
  → 1 million calls ≈ **$34**.
- TypeSafe's reported price ratio: **~150x cheaper** than a frontier LLM doing the same job
  (their triage benchmark: $1.30 vs $200 per 10k tickets), and no output tokens to pay for.

## 9. Optional: give your coding agent the official skill

If your agent supports skills (Claude Code-style), the community publishes a ready-made one:

```bash
npx skills add typesafe-ai/skills --skill typesafe-ai
```

Even with the skill installed, your agent should follow the rules in this kit's
`06-agent-handoff.md` — the failure modes in `04-failure-modes.md` are what actually determine
whether the build works.

## 10. First-run checklist

- [ ] `pip install typesafe-sdk` (or `npm install @typesafe-ai/sdk`) succeeds
- [ ] `TYPESAFE_API_KEY` exported in every shell/service that runs the code
- [ ] Hello world above returns answers (you have access)
- [ ] Model pinned; `response.model` logged
- [ ] Wrapper from `examples/python/jev_wrapper.py` (or equivalent) in place with cost logging
- [ ] If no key: `MockJevClient` path works and unit tests pass offline
