---
name: remnic-memory-workflow
description: Shared memory workflow for Remnic-connected agents — recall before acting, observe during work, remember at the end. Trigger phrases include "what do you remember about", "save this for later", "any context from last time".
disable-model-invocation: true
allowed-tools:
  - remnic_recall
  - remnic_memory_store
  - remnic_lcm_search
  - remnic_entity_get
  - remnic_observe
---

## When to use

Use this skill as the default playbook whenever an agent picks up a task that could benefit from prior context, or when the user explicitly asks the agent to remember or recall something. It is the umbrella workflow — individual skills (`remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-entities`, `remnic-status`) implement the detailed steps.

Triggers:

- The user opens a new task, ticket, or branch.
- The user says "what do you know about X", "have we talked about Y before", "remind me of Z".
- The user asks the agent to save a preference, decision, or fact.
- A long-running turn produces a durable outcome worth capturing.

## Inputs

- Current user request (natural language).
- Optional: active project path, ticket number, branch name.
- Optional: topic keywords surfaced earlier in the session.

## Procedure

1. **Recall first.** Call `remnic_recall` with a concise natural-language query derived from the user's request. Pull 3–8 results. Skim them for anything relevant.
2. **Mention relevant memories briefly** to the user if they materially change the plan, otherwise quietly use them as context.
3. **Observe during work.** For significant tool outputs (file edits, command exits, test results) call `remnic_observe` so Remnic can keep its ambient context fresh.
4. **Deep search when needed.** If `remnic_recall` misses something the user insists exists, call `remnic_lcm_search` with a more literal phrase.
5. **Browse entities.** When the user references a specific project, person, or concept by name, call `remnic_entity_get` to pull its facts and relationships.
6. **Remember at the end.** Before ending the turn, store any durable decision, preference, or finding with `remnic_memory_store`. Keep each entry under ~300 tokens.

## Efficiency plan

- Batch recalls. One broad query is usually cheaper than several narrow ones.
- Skip recall for trivially local requests (e.g., "format this JSON").
- Reuse the current turn's recall results instead of re-querying within the same turn.
- Store each memory once. If you are about to store something you just recalled, update instead of duplicating.

## Pitfalls and fixes

- **Pitfall:** Storing transient task state ("user is running tests now"). **Fix:** Only store facts with durable value — decisions, preferences, conclusions, long-lived context.
- **Pitfall:** Leaking secrets into memories. **Fix:** Redact API keys, tokens, and credentials before calling `remnic_memory_store`.
- **Pitfall:** Drowning the user in recalled context. **Fix:** Summarize in 1–3 bullet points; offer to expand on request.
- **Pitfall:** Forgetting the write. **Fix:** Make "remember the decision" the last step of any non-trivial turn.

## Verification checklist

- [ ] Recall was attempted before the agent committed to a plan.
- [ ] Any user-facing mention of recalled context was concise and attributed.
- [ ] Durable decisions, preferences, and findings were stored via `remnic_memory_store`.
- [ ] No secrets, credentials, or transient state were written.
- [ ] Legacy `engram_*` aliases were NOT preferred over canonical `remnic_*` tool names.

> Tool names: this skill uses the canonical `remnic_*` MCP tools. Legacy `engram_*` aliases (`engram_recall`, `engram_memory_store`, `engram_lcm_search`, `engram_entity_get`, `engram_observe`) remain accepted during v1.x for backward compatibility.
