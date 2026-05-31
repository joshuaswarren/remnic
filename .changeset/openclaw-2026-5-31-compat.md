---
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Align OpenClaw manifests with the 2026.5.31 compatibility sweep by adding
`setup.providers[].envVars` for current optional plugin-mode OpenAI auth
discovery, preserving older OpenClaw auth and memory-slot compatibility
metadata, removing unsupported disclosure metadata, and recording the reviewed
OpenClaw build target while keeping the package range aligned with Remnic's
rolling 60-day OpenClaw support policy, including reviewed prerelease hosts
that default npm semver range checks would otherwise exclude from peer/plugin-API
compatibility checks.
