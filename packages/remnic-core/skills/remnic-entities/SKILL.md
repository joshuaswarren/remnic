---
name: remnic-entities
description: Browse entities in the Remnic knowledge graph and surface their facts and relationships. Trigger phrases include "tell me about the entity", "look up", "what do we know about".
allowed-tools:
  - remnic_entity_get
---

## When to use

Use when the user names a specific project, person, service, or concept and asks what is known about it. Entities are the graph-shaped view of memory — structured facts and relationships rather than free text.

Triggers:

- "Tell me about the entity …"
- "Look up …"
- "What do we know about project/service/tool X?"
- Any reference to a named thing that could have linked facts.

## Inputs

- `name` (required) — canonical entity name, ideally as the user wrote it.
- Optional: entity type hint (project, person, service, tool).

## Procedure

1. Extract the entity name from the user's message. Preserve original capitalization unless ambiguous.
2. Call `remnic_entity_get` with that name.
3. If the entity is found, present its facts and relationships in a short structured view (facts, relations, last updated).
4. If the entity is missing, say so and offer to create one via `remnic-remember` with the user's permission.
5. When multiple candidates match, list them briefly and ask which the user meant.

## Efficiency plan

- Do not call `remnic_entity_get` speculatively for every proper noun — only when the user asked or the task depends on it.
- Cache the entity payload within the current turn; do not re-fetch for the same name.
- Pair with `remnic-recall` when unstructured context would round out the entity view.

## Pitfalls and fixes

- **Pitfall:** Guessing entity names. **Fix:** Use the user's wording; disambiguate rather than inventing.
- **Pitfall:** Dumping the full entity payload. **Fix:** Summarize into a compact facts/relations/last-updated block.
- **Pitfall:** Treating a missing entity as a bug. **Fix:** Missing just means the graph has not captured it yet — offer to create it.

## Verification checklist

- [ ] `remnic_entity_get` was called with a user-supplied or user-confirmed name.
- [ ] Output shows facts, relationships, and timestamps in a compact view.
- [ ] Missing entities are acknowledged plainly with an offer to create.
- [ ] Legacy `engram_entity_get` alias was not preferred over `remnic_entity_get`.

> Tool names: canonical name is `remnic_entity_get`. The legacy `engram_entity_get` alias remains accepted during v1.x.
