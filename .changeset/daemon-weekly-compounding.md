---
"@remnic/core": minor
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

The standalone daemon runs weekly compounding synthesis when `compoundingWeeklyCronEnabled` and `compoundingEnabled` are both true. Both stay default off. The run calls `synthesizeWeekly` for the ISO week that just ended, including calibration when calibration is enabled, and catches up that missed week after a restart. A scheduler-owned completion marker (not the report file) is the skip signal, so a manual access-surface synthesis of the in-progress week cannot suppress that week's scheduled run. Weekly synthesis serializes per memory directory, so a scheduled run and an access-surface request cannot interleave their writes to the week's artifacts. Calibration records every applied week id in the same index write as any rule reinforcement, so a retry of an older week does not count that week's evidence twice.

Stability: alpha
