---
"@remnic/plugin-pi": patch
---

Refresh the stale `Remnic offline` status label once a daemon call succeeds again. The startup probe runs once per `session_start` and wrote the offline label with no later writer, so a daemon that came back within the breaker cooldown left every pane showing `Remnic offline` for the rest of the session even though recall and observe worked. Session state now flags the offline write, and the first successful recall or observe sets the ready label once; sessions whose probe succeeded are untouched, and `statusEnabled: false` still never calls setStatus.

Stability: stable
