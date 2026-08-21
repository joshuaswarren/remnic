---
name: remnic-entities
description: Browse entities in the Remnic knowledge graph and surface their facts and relationships. Trigger phrases include "tell me about the entity", "look up", "what do we know about".
allowed-tools:
  - remnic_entity_get
---

## When to use

Use when the user names a specific project, person, service, or concept and asks what is known about it. Entities are the structured graph view of memory — facts and relationships rather than free text.

Triggers:

- "Tell me about the entity …"
- "Look up …"
- `/remnic:entities <name>` slash command invocation.
- Any reference to a named thing that could have linked facts.

## Inputs

- `name` (required) — canonical entity name, ideally as the user wrote it.
- Optional: entity type hint (project, person, service, tool).

## Procedure

1. Extract the entity name from the user's message. Preserve capitalization.
2. Call `remnic_entity_get` with that name.
3. If found, present facts, relationships, and a last-updated timestamp in a compact block.
4. If missing, say so and offer to create it via `remnic-remember` with the user's permission.
5. If multiple candidates match, list them briefly and ask which the user meant.

## Efficiency plan

- Do not fetch speculatively for every proper noun — only when the user asks or the task depends on it.
- Cache the entity payload within the current turn.
- Pair with `remnic-recall` when unstructured context would round out the view.

## Pitfalls and fixes

- **Pitfall:** Guessing entity names. **Fix:** Use the user's wording; disambiguate rather than inventing.
- **Pitfall:** Dumping the full payload. **Fix:** Summarize into facts, relations, last-updated.
- **Pitfall:** Treating missing entities as a bug. **Fix:** Missing just means the graph has not captured it yet.

## Verification checklist

- [ ] `remnic_entity_get` was called with a user-supplied or user-confirmed name.
- [ ] Output shows facts, relationships, and timestamps in a compact view.
- [ ] Missing entities are acknowledged plainly with an offer to create.
- [ ] Canonical `remnic_entity_get` was used over legacy `engram_entity_get`.

> Tool names: canonical name is `remnic_entity_get`. The legacy `engram_entity_get` alias remains accepted during v1.x.
