---
"@remnic/plugin-openclaw": patch
---

Stability: stable

OpenClaw 2.0 delegate-mode fixes for hosts that register in the discovery modes.

- `registrationMode: "discovery"` and `"tool-discovery"` now run the runtime registration (tools, `before_prompt_build`, `agent_end`, memory capability). OpenClaw's loader accepts capability handlers in those modes, and the agent runtime that serves `openclaw agent` turns registers in them; skipping register() there left it with no memory loop. The one-time engram migration stays off in both discovery passes.
- Delegate mode registers daemon-backed `memory_search` (through the capability's search manager, so scoping and authorization match the host's own memory search) and `memory_get` (`GET /engram/v1/memories/{id}`) tools when the host exposes `registerTool`.
- Delegate mode does NOT register the OpenClaw 2.0 `registerMemoryPromptPreparation` step: it runs before `before_prompt_build` and is handed no session namespace, so it could only recall a previous scope. `before_prompt_build` injects this turn's recall in the session's bound scope.
- The recall query is the current turn (`event.prompt`, envelope-cleaned) capped at 1500 characters, keeping the tail, so a host that hands the hook an assembled prompt cannot 413 the daemon's body limit.
- `agent_end` no longer blocks on the observe POST: the turn capture is detached and chained per session, bounded by half the flush timeout so that a flush for the same session (which waits behind it for at most that long) can never overtake one observe and always keeps the other half for its own requests. When a whole QUEUE of observes outlasts that wait, the flush proceeds and a follow-up flush is chained behind the queue, so late turns are never left buffered past `session_end`. The follow-up drains the whole queue (including turns observed after the hook returned, which the daemon buffers per session) and resolves its scope from the session's bindings rather than the ended event's captured metadata.
- A `REMNIC_HOST` that names one of this machine's own interface addresses (a NIC or VIP) is dialed through loopback, like a wildcard bind; a gateway fetch to such an address has been observed to hang.
