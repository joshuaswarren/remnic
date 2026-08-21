---
name: remnic-recall
description: Search Remnic memories by natural-language query. Trigger phrases include "what do you remember about", "recall anything on", "have we discussed".
allowed-tools:
  - remnic_recall
---

## When to use

Use when the user or the current task needs prior context from Remnic. This is the default first step for any non-trivial turn that could benefit from memory.

Triggers:

- "What do you remember about …"
- "Have we talked about …"
- "Recall anything on …"
- A new task begins and the agent wants background.

## Inputs

- `query` (required) — natural-language question or topic string.
- Optional budget hint from the caller (e.g., "brief", "deep").

## Procedure

1. Build a concise natural-language query from the user's request. Prefer the user's own wording over paraphrase.
2. Call `remnic_recall` with that query. Ask for 3–8 results unless the caller hinted otherwise.
3. Skim the returned memories. Discard anything clearly off-topic.
4. Present 1–5 relevant bullet points to the user, each attributed to its source memory when useful.
5. If nothing relevant came back, say so plainly and suggest `remnic-remember` if there is something worth storing now.

## Efficiency plan

- One broad recall beats several narrow ones.
- Reuse results within the same turn — do not re-query for the same topic.
- Skip recall entirely for trivially local requests (formatting, arithmetic, mechanical refactors).

## Pitfalls and fixes

- **Pitfall:** Quoting irrelevant recalls just because they came back. **Fix:** Filter by topical relevance before surfacing.
- **Pitfall:** Over-narrowing the query and missing useful context. **Fix:** Start broad; refine only if the first pass was noisy.
- **Pitfall:** Presenting raw memory blobs. **Fix:** Summarize in the user's own terms.

## Verification checklist

- [ ] `remnic_recall` was called with a natural-language query.
- [ ] Results were filtered for relevance before surfacing.
- [ ] User-facing summary is concise (≤ 5 bullets unless requested).
- [ ] Legacy `engram_recall` alias was not preferred over `remnic_recall`.

> Tool names: canonical name is `remnic_recall`. The legacy `engram_recall` alias remains accepted during v1.x.
