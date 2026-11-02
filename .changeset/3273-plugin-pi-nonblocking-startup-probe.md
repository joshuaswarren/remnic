---
"@remnic/plugin-pi": patch
Stability: stable
---

Made the Pi `session_start` startup probe non-blocking: the daemon health probe, version-mismatch warning, and namespace preflight now run in the background instead of being awaited in the handler, so Pi startup and extension reloads no longer block on the daemon round trip. The first `before_agent_start` awaits the in-flight probe under a bounded budget, so a down daemon still fails fast instead of burning the full turn budget on the first turn. Refs #3273.
