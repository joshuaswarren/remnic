---
"@remnic/core": patch
---

Close the reconstruct-clock finding class on the wearable cross-source fusion foundation (PR #1849 / issue #1810): when a stored transcript renders a missing conversation end as `--:--`, `reconstructFusionInputs` rebuilds segments carrying only a `startIso`, so the cluster interval fallback previously collapsed to a zero-length point at the conversation start and mis-clustered later conversations. The cluster `effectiveInterval` now derives the conversation window end from each segment's own extent (`endIso ?? startIso`) — reaching the latest segment start when no end is known — and clamps it to `>= start`, so a missing-end conversation clusters by its actual segments (including cross-midnight-rolled ones) instead of its start. Prior clock fixes (24:xx normalization, heading + segment cross-midnight roll) are unchanged.
