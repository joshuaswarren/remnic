---
name: remnic-status
description: Check the health of the Remnic daemon, stores, and connected clients. Trigger phrases include "is remnic running", "check memory status", "daemon health".
---

## When to use

Use when the user asks whether Remnic is running, when recall or store calls start failing, or when diagnosing cross-agent memory issues.

Triggers:

- "Is Remnic running?"
- "Check memory status."
- "Is the daemon up?"
- Recall/store tools returned connection errors in this turn.

## Inputs

- Optional: specific component to check (daemon, HTTP server, MCP server, store backend).

## Procedure

1. Check the Remnic health endpoint via the MCP bridge or by running `remnic daemon status` in a shell.
2. Report, in a compact block:
   - Daemon running state (PID if known).
   - Listening port(s).
   - Memory store path.
   - Connected clients or plugins, if the health payload exposes them.
3. If the daemon is not running, suggest `remnic daemon start`. Mention the log path for deeper debugging.
4. If recall/store tools were erroring earlier in the turn, correlate the health state with those errors in one sentence.

## Efficiency plan

- One health call per turn is enough; do not poll.
- Skip the check for trivially local tasks.
- Reuse the health payload for downstream troubleshooting within the same turn.

## Pitfalls and fixes

- **Pitfall:** Running `remnic daemon status` on a host where the daemon lives in a container. **Fix:** Prefer the MCP health endpoint, or run the CLI inside the container.
- **Pitfall:** Reporting "down" based on a single failed tool call. **Fix:** Confirm with the health endpoint before claiming an outage.
- **Pitfall:** Forgetting the log path. **Fix:** Always include a pointer to logs when reporting a failure.

## Verification checklist

- [ ] Health was checked via the endpoint or CLI, not guessed.
- [ ] Daemon state, port, store path, and clients were reported concisely.
- [ ] If unhealthy, the user was given a concrete next step.
- [ ] No legacy `engram daemon` wording was preferred over `remnic daemon` where the CLI has been renamed.

> CLI names: canonical CLI is `remnic daemon`. The legacy `engram daemon` invocation remains accepted during v1.x.
