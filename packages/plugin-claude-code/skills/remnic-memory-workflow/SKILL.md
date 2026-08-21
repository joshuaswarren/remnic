---
name: remnic-memory-workflow
description: Shared memory workflow for Claude Code agents connected to Remnic — recall before acting, observe during work, remember at the end. Trigger phrases include "what do you remember about", "save this for later", "any context from last time".
disable-model-invocation: true
allowed-tools:
  - remnic_recall
  - remnic_memory_store
  - remnic_lcm_search
  - remnic_entity_get
  - remnic_observe
---

## When to use

Use this skill as the default playbook whenever Claude Code picks up a task that could benefit from prior context, or when the user explicitly asks the agent to remember or recall something. The individual `remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-entities`, and `remnic-status` skills implement the detailed steps.

Triggers:

- New ticket, branch, or task begins.
- "What do you remember about …"
- "Save this for later."
- Long-running turn produces a durable outcome worth capturing.

## Inputs

- Current user request (natural language).
- Optional: active project path, ticket number, branch name.
- Optional: topic keywords surfaced earlier in the session.

## Procedure

1. **Recall first.** Call `remnic_recall` with a concise natural-language query built from the user's request. Pull 3–8 results and filter for relevance.
2. **Mention relevant memories briefly** to the user when they change the plan; otherwise use them as quiet context.
3. **Observe during work.** For significant tool results (Write/Edit/MultiEdit, Bash exits, test output) call `remnic_observe` so Remnic keeps its ambient context fresh.
4. **Deep search on demand.** If `remnic_recall` missed something the user insists exists, fall back to `remnic_lcm_search` with a more literal phrase.
5. **Browse entities.** When the user names a project, person, or concept, call `remnic_entity_get` to pull facts and relations.
6. **Remember at the end.** Before ending the turn, store durable decisions, preferences, and findings via `remnic_memory_store`.

## Efficiency plan

- One broad recall beats several narrow ones.
- Skip recall for trivially local tasks (formatting, arithmetic, mechanical refactors).
- Reuse recall results within the same turn.
- Store each memory once; update rather than duplicate.

## Pitfalls and fixes

- **Pitfall:** Storing transient state. **Fix:** Only store facts with durable value.
- **Pitfall:** Leaking secrets. **Fix:** Redact credentials and tokens before calling `remnic_memory_store`.
- **Pitfall:** Flooding the user with recalled context. **Fix:** Summarize in 1–3 bullet points.
- **Pitfall:** Forgetting the final write. **Fix:** Make "remember the decision" the last step of any non-trivial turn.

## Verification checklist

- [ ] Recall was attempted before the agent committed to a plan.
- [ ] User-facing mentions of recalled context were concise and relevant.
- [ ] Durable decisions and findings were stored via `remnic_memory_store`.
- [ ] No secrets, credentials, or transient state were written.
- [ ] Canonical `remnic_*` tool names were used over legacy aliases.

> Tool names: this skill uses the canonical `remnic_*` MCP tools. Legacy `engram_*` aliases remain accepted during v1.x for backward compatibility.
