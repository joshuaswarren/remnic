---
"@remnic/core": minor
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

The standalone daemon runs weekly compounding synthesis when `compoundingWeeklyCronEnabled` and `compoundingEnabled` are both true. Both stay default off. The run calls `synthesizeWeekly` for the ISO week that just ended, including calibration when calibration is enabled, skips a week whose report already exists, and catches up that missed week after a restart. Calibration records the week id in the same index write as any rule reinforcement, so a retry does not count that week's evidence twice.

Stability: alpha
