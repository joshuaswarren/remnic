---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Register the OpenClaw `before_prompt_build` hook with Remnic's configurable
`initGateTimeoutMs` budget and use the same setting for Remnic's internal
cold-start init gate so slow first-turn startup can complete without the host's
generic hook timeout aborting recall.
