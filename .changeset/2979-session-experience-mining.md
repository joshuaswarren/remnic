---
"@remnic/core": minor
---

Promoted session-end experience memories now feed procedure mining when `sessionExperience.enabled` is on (issue #2979 layer 3). They share the existing lookback and cluster thresholds. Gate off leaves miner input byte-identical to the trajectory-only set; `pending_review` episodes stay out.
