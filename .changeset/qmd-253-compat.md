---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Update Remnic's QMD supported target to `@tobilu/qmd` 2.5.3 and gate QMD 2.5.3's preferred `--format json` output selector behind runtime version detection while preserving legacy `--json` for older QMD installs.
