---
name: remnic-remember
description: Store a durable memory in Remnic so every connected agent can recall it. Trigger phrases include "remember this", "save this for later", "add a note that".
disable-model-invocation: true
allowed-tools:
  - remnic_memory_store
---

## When to use

Use when the user explicitly asks the agent to remember something, or when a turn produces a durable decision, preference, or finding worth storing for later sessions.

Triggers:

- "Remember that …"
- "Save this for later."
- "Add a note that …"
- End-of-turn consolidation after a non-trivial conclusion.

## Inputs

- `content` (required) — the statement to store, in the user's own words where possible.
- Optional: category hint (preference, decision, fact, procedure).
- Optional: related entity or project name.

## Procedure

1. Confirm the content is durable — it should still be useful days or weeks from now.
2. Strip any secrets, credentials, or transient context (current PID, test run timestamps).
3. Rephrase only if needed for clarity. Keep the user's voice.
4. Call `remnic_memory_store` with the text as `content`. Include category/entity hints if the tool schema supports them.
5. Confirm to the user what was stored, in one line.
6. Mention that the memory is now available across connected agents (Claude Code, Codex, Hermes, OpenClaw).

## Efficiency plan

- Batch closely related facts into a single memory rather than writing many tiny ones.
- If a prior memory on the same topic already exists, prefer an update-in-place phrasing over a fresh write.
- Do not store anything that can be re-derived trivially from source code or docs.

## Pitfalls and fixes

- **Pitfall:** Storing transient state like "user is running tests now". **Fix:** Only commit facts that will still matter tomorrow.
- **Pitfall:** Accidentally including a secret or token. **Fix:** Redact before calling the tool; reject any content that matches known secret patterns.
- **Pitfall:** Duplicate memories on the same topic. **Fix:** Recall first; prefer update over re-store.
- **Pitfall:** Vague entries ("user likes clean code"). **Fix:** Be specific — who, what, when, why.

## Verification checklist

- [ ] Content is durable and specific.
- [ ] No secrets, credentials, or PII were included.
- [ ] `remnic_memory_store` was called with the final content.
- [ ] User received a one-line confirmation.
- [ ] Legacy `engram_memory_store` alias was not preferred over `remnic_memory_store`.

> Tool names: canonical name is `remnic_memory_store`. The legacy `engram_memory_store` alias remains accepted during v1.x.
