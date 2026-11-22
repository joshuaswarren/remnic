---
"@remnic/core": patch
---

### Calibration recall section ranked by query relevance

`buildCalibrationRecallSection` now similarity-ranks the user's calibration
rules against the retrieval query before applying `maxRules` and `maxChars`
caps, so relevant rules win the section budget instead of whichever happen
to sit earliest in the index. When nothing matches the query the index
order is preserved — the include-all fallback is unchanged.

Stability: stable
