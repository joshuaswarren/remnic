---
"@remnic/core": patch
---

Add `resolveActivityGates` to the activity subsystem: an internal pure helper that resolves the five activity feature gates behind a master override — `activity.enabled` false forces every gate false. Gate values reuse `parsePrivacyEnabled` token handling and invalid values or unknown gate keys throw `TypeError`. Not wired into any surface yet; that is a later slice. Part of #2053.
