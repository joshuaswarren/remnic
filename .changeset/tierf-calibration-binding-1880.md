---
"@remnic/bench": patch
---

Bind both Tier-F run wrappers to the same configurable calibration directory and attach the persisted local/frontier judge configuration hashes to every full baseline and real-profile run. The real-profile wrapper now fails before benchmark dispatch when its pinned calibration state cannot be attached, preventing uncalibrated acceptance artifacts for issues #1876, #1878, and #1880.
