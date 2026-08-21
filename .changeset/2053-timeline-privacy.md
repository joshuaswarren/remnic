---
"@remnic/core": minor
---

Add a pure activity privacy helper for retention and export gates (issue #2053). `retentionDays` 0 keeps forever, the expiry window is half-open, and a disabled master denies retain and empties export. Part of #2053.
