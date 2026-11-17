---
name: remnic-search
description: Run a deep full-text search across the Remnic LCM conversation archive. Trigger phrases include "search memories for", "find anything about", "deep search".
allowed-tools:
  - mcp__remnic__remnic_lcm_search
---

## When to use

Use when `remnic-recall` did not surface something the user insists exists, or when the task genuinely needs exhaustive coverage of archived conversations rather than a ranked semantic summary. `remnic_lcm_search` reads only the LCM conversation archive — durable memories stored via `remnic_memory_store` are not included; use `remnic-recall` or `remnic-entities` for those.

Triggers:

- "Search memories for …"
- "Deep search on …"
- `/remnic:remnic-search <query>` slash command invocation.
- Follow-up after `remnic-recall` returned nothing useful.

## Inputs

- `query` (required) — literal phrase or keyword string; this is full-text, not semantic.
- Optional: date range, category filter, entity constraint.

## Procedure

1. Pick the most literal phrase the user expects to match.
2. Call `remnic_lcm_search` with that phrase.
3. Group results by date or category when the tool returns enough metadata.
4. Present the top 5–10 matches with dates and short excerpts.
5. If still nothing, say so plainly and offer `remnic-remember` for capturing the content going forward.

## Efficiency plan

- Use the most specific phrase available.
- One targeted search beats several broad ones.
- Do not re-run a deep search for the same topic in the same turn after recall already covered it.

## Pitfalls and fixes

- **Pitfall:** Using `remnic_lcm_search` as the default. **Fix:** Start with `remnic_recall`; escalate only when recall fails.
- **Pitfall:** Pasting huge result dumps. **Fix:** Show top matches with excerpts.
- **Pitfall:** Over-broad queries. **Fix:** Require at least one distinctive keyword.

## Verification checklist

- [ ] `remnic_lcm_search` was called only after recall fell short or exhaustive matching was required.
- [ ] Results were grouped by relevance or date when possible.
- [ ] Output shows excerpts, not raw payloads.
- [ ] Canonical `remnic_lcm_search` was used over legacy `engram_lcm_search`.

> Tool names: canonical name is `remnic_lcm_search`. The legacy `engram_lcm_search` alias remains accepted during v1.x.
