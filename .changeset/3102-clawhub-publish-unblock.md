---
"@remnic/plugin-openclaw": patch
---

fix: unblock ClawHub publishing of `@remnic/plugin-openclaw` (#3102)

Stability: stable

ClawHub's Plugin Inspector statically scans the packed dist for `api.register*(` and blocks publish when a registrar is missing from the target OpenClaw. The OpenClaw 1.x-only `registerMemoryPromptSection`, `registerMemoryRuntime`, and `registerMemoryFlushPlan` seams are feature-detected at runtime but were written as `api.registerX(...)`, so every publish since 9.64.4 was rejected against OpenClaw 2026.8+ targets. They are now bound to locals and invoked via `.call(api, ...)`; 1.x hosts still get the same registrations, 2.0 hosts skip them as before.
