---
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
Stability: stable
---

Prefer the gateway-passed config snapshot in `register()` and stop reading `openclaw.json` when the host already delivered the plugin entry (#3612/#3613). `api.config` resolves through the same slot → preferred → canonical → legacy chain as the file loader, so the operator-authored entry wins without a disk read; the file loader remains only as the fallback for hosts that pass no snapshot. The raw runtime config and the file-backed leg of the bundled active-memory check follow the same rule: gateway snapshot authoritative when present, file read only when absent.
