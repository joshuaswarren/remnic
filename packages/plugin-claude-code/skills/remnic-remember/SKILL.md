---
name: remnic-remember
description: Store a durable memory in Remnic so every connected agent can recall it. Trigger phrases include "remember this", "save this for later", "add a note that".
disable-model-invocation: true
allowed-tools:
  - remnic_memory_store
---

## When to use

Use when the user explicitly asks Claude Code to remember something, or when a turn produces a durable decision, preference, or finding worth storing for later sessions.

Triggers:

- "Remember that …"
- "Save this for later."
- `/remnic:remember <text>` slash command invocation.
- End-of-turn consolidation after a non-trivial conclusion.

## Inputs

- `content` (required) — the statement to store, in the user's own words where possible.
- Optional: category hint (preference, decision, fact, procedure).
- Optional: related entity or project name.

## Procedure

1. Confirm the content is durable — it should still be useful days or weeks from now.
2. Strip any secrets, credentials, or transient context.
3. Keep the user's voice; rephrase only when needed for clarity.
4. Call `remnic_memory_store` with the text as `content`. Include category or entity hints when the tool accepts them.
5. Confirm to the user in one line what was stored.
6. Mention that the memory is available across connected agents (Claude Code, Codex, Hermes, OpenClaw).

## Efficiency plan

- Batch related facts into a single memory rather than writing many tiny ones.
- If a prior memory on the same topic exists, update it rather than duplicating.
- Do not store anything easily re-derived from source code or docs.

## Pitfalls and fixes

- **Pitfall:** Storing transient state. **Fix:** Only commit facts that will still matter tomorrow.
- **Pitfall:** Leaking secrets. **Fix:** Redact before calling the tool.
- **Pitfall:** Duplicates on the same topic. **Fix:** Recall first; prefer update.
- **Pitfall:** Vague entries. **Fix:** Be specific — who, what, when, why.

## Verification checklist

- [ ] Content is durable and specific.
- [ ] No secrets or PII were included.
- [ ] `remnic_memory_store` was called with the final content.
- [ ] User received a one-line confirmation.
- [ ] Canonical `remnic_memory_store` was used over legacy `engram_memory_store`.

> Tool names: canonical name is `remnic_memory_store`. The legacy `engram_memory_store` alias remains accepted during v1.x.
