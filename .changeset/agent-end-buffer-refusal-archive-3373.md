---
"@remnic/plugin-openclaw": patch
---

The OpenClaw agent_end hook no longer loses the LCM archive of a turn when the extraction buffer refuses a new session at its entry cap (issue #3373). The hook now logs a warning for the refused message and carries on, so the remaining messages and the LCM archive append still run.

Stability: stable
