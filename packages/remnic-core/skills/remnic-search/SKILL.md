---
name: remnic-search
description: Run a deep full-text search across every Remnic memory. Trigger phrases include "search memories for", "find anything about", "deep search".
allowed-tools:
  - remnic_lcm_search
---

## When to use

Use when a natural-language `remnic-recall` did not surface something the user insists exists, or when the task genuinely needs exhaustive coverage rather than a ranked summary.

Triggers:

- "Search memories for …"
- "Deep search on …"
- "I know I told you about X, find it."
- Follow-up after `remnic-recall` returned nothing useful.

## Inputs

- `query` (required) — literal phrase or keyword string; this is full-text, not semantic.
- Optional: date range, category filter, or entity constraint if the tool supports it.

## Procedure

1. Ask the user (or the calling skill) for the most literal phrase they expect to match.
2. Call `remnic_lcm_search` with that phrase.
3. Group results by date or category when the tool returns enough metadata.
4. Present the top 5–10 matches with dates and short excerpts.
5. If still nothing, say so plainly and suggest `remnic-remember` if the content should be captured going forward.

## Efficiency plan

- Use the most specific phrase available; literal matches are cheaper than wildcarding.
- Prefer one targeted search over several broad ones.
- When recall already worked, do not re-run a deep search for the same topic in the same turn.

## Pitfalls and fixes

- **Pitfall:** Using `remnic_lcm_search` as the default. **Fix:** Start with `remnic_recall`; escalate to search only when recall fails.
- **Pitfall:** Pasting huge result dumps. **Fix:** Show the top matches with excerpts, not the raw payloads.
- **Pitfall:** Over-broad queries like "notes". **Fix:** Require at least one distinctive keyword.

## Verification checklist

- [ ] `remnic_lcm_search` was called only after recall fell short or the task required exhaustive matching.
- [ ] Results were grouped by relevance/date when possible.
- [ ] User-facing output shows excerpts, not raw blobs.
- [ ] Legacy `engram_lcm_search` alias was not preferred over `remnic_lcm_search`.

> Tool names: canonical name is `remnic_lcm_search`. The legacy `engram_lcm_search` alias remains accepted during v1.x.
