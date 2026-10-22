---
"@remnic/core": minor
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

The standalone daemon runs weekly compounding synthesis when `compoundingWeeklyCronEnabled` and `compoundingEnabled` are both true. Both stay default off. The run calls `synthesizeWeekly` for the ISO week that just ended, including calibration when calibration is enabled, skips a week whose report already exists, and catches up that missed week after a restart.

Stability: alpha
