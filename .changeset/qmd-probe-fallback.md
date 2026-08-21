---
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Fix false-negative QMD availability reports from `probeEmbeddingAvailability` and `probeVectorAvailability`.

Both probe surfaces previously consulted only the cached `qmd.isAvailable()` flag, which starts as `false` on a fresh process and only flips to `true` after some other code path has actively probed QMD. On systems where probe checks fired before any read/write traffic (e.g. `openclaw status --all --json` immediately after gateway start), the runtime would report `vector.available: false` and `qmdAvailable: false` even when QMD was fully functional. The probe surfaces now fall back to an actual `qmd.probe()` call before reporting the backend down, so status checks reflect real availability.

Credit: reported and patched by [@earlvanze](https://github.com/earlvanze) — see the 2026-04-24 OpenClaw/Remnic QMD fix bundle for the original analysis. The companion OpenClaw upstream fixes (memory-search config plumbing and config-less allowlist warning suppression) live outside this repo and are tracked separately.
