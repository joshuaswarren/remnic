---
"@remnic/plugin-openclaw": patch
---

Stability: stable

OpenClaw 2.0 delegate-mode fixes for hosts that register in the discovery modes.

- `registrationMode: "discovery"` and `"tool-discovery"` now run the runtime registration (tools, `before_prompt_build`, `agent_end`, memory capability). OpenClaw's loader accepts capability handlers in those modes, and the agent runtime that serves `openclaw agent` turns registers in them; skipping register() there left it with no memory loop. The one-time engram migration stays off in both discovery passes.
- Delegate mode registers daemon-backed `memory_search` (through the capability's search manager, so scoping and authorization match the host's own memory search) and `memory_get` (`GET /engram/v1/memories/{id}`) tools when the host exposes `registerTool`.
- Delegate mode registers `registerMemoryPromptPreparation`, which the host awaits BEFORE `before_prompt_build`, so a session-primed `POST /engram/v1/recall` lands in the system prompt's own memory section. `before_prompt_build` still prepends the prompt-specific recall.
- The recall query is the current turn (`event.prompt`, envelope-cleaned) capped at 1500 characters, keeping the tail, so a host that hands the hook an assembled prompt cannot 413 the daemon's body limit.
- `agent_end` no longer blocks on the observe POST: the turn capture is detached (it keeps the configured observe timeout) and chained per session, and a flush for the same session waits behind it, bounded by what is left of the flush deadline.
- A `REMNIC_HOST` that names one of this machine's own interface addresses (a NIC or VIP) is dialed through loopback, like a wildcard bind; a gateway fetch to such an address has been observed to hang.
