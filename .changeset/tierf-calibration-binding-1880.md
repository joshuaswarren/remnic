---
"@remnic/bench": patch
"@remnic/cli": patch
---

Bind both Tier-F run wrappers to the same configurable calibration directory and attach the persisted local/frontier judge configuration hashes to every full baseline and real-profile run. Persist and verify the exact calibration source result, answer-set hash, and ordered question-id hash before benchmark dispatch. The real-profile wrapper now fails closed when its pinned calibration state cannot be attached, preventing uncalibrated or unrelated acceptance artifacts for issues #1876, #1878, and #1880.
