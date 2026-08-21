---
name: remnic-recall
description: Search Remnic memories by natural-language query. Trigger phrases include "what do you remember about", "recall anything on", "have we discussed".
allowed-tools:
  - remnic_recall
---

## When to use

Use when the user or the current task needs prior context from Remnic. This is the default first step for any non-trivial Claude Code turn that could benefit from memory.

Triggers:

- "What do you remember about …"
- "Have we talked about …"
- `/remnic:recall <query>` slash command invocation.
- A new task begins and the agent wants background.

## Inputs

- `query` (required) — natural-language question or topic string.
- Optional: caller-supplied budget hint (brief, deep).

## Procedure

1. Build a concise natural-language query from the user's message. Prefer the user's own wording.
2. Call `remnic_recall` with that query; request 3–8 results unless the caller specified otherwise.
3. Filter results for topical relevance.
4. Present 1–5 bullet points summarizing the relevant memories, attributed when useful.
5. If nothing relevant came back, say so plainly and suggest `remnic-remember` if there is something worth storing now.

## Efficiency plan

- One broad recall beats several narrow ones.
- Reuse recall results within the same turn — do not re-query the same topic.
- Skip recall for trivially local tasks.

## Pitfalls and fixes

- **Pitfall:** Quoting irrelevant recalls just because they came back. **Fix:** Filter for relevance before surfacing.
- **Pitfall:** Over-narrowing the query. **Fix:** Start broad; refine only when the first pass was noisy.
- **Pitfall:** Showing raw memory payloads. **Fix:** Summarize in the user's own terms.

## Verification checklist

- [ ] `remnic_recall` was called with a natural-language query.
- [ ] Results were filtered for relevance before being shown.
- [ ] Summary is ≤ 5 bullets unless the user asked for more.
- [ ] Canonical `remnic_recall` was used over legacy `engram_recall`.

> Tool names: canonical name is `remnic_recall`. The legacy `engram_recall` alias remains accepted during v1.x.
