---
"@remnic/plugin-openclaw": patch
---

Stability: stable

Stop injecting recall into spawned subagent sessions (issue #3142). Every OpenClaw session whose key marks it as a spawned subagent (`agent:<agentId>:subagent:<runId>`, which the host's own session classification treats as a background `"subagent"` session) triggered a full recall and injected up to `recallBudgetChars` of memory into it on every turn. The hook payload exposes no deeper isolation discriminator, so the default is conservative: such sessions get no unsolicited recall — a fresh-eyes review agent no longer receives distilled memories of earlier findings and reviews on the same files, and spawns no longer fire concurrent 10s+ recalls that compete for the daemon at spawn time. Both the delegate runtime and the embedded `before_prompt_build` path now skip such sessions the same way cron sessions are excluded, using the host's own public `openclaw/plugin-sdk/routing` `isSubagentSessionKey` (exported since upstream 2026.3, so every supported host has it), probed lazily with a mirrored in-plugin predicate as the fallback for host-free environments where the peer package is absent; main-session recall is unchanged.
