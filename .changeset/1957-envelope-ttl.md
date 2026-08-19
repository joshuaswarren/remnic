---
"@remnic/core": minor
---

Add shared-context envelope remaining TTL (issue #1957). `remainingTtlMs` returns null when `expiresAt` is missing, 0 at or after expiry, otherwise the remaining milliseconds, and throws on an invalid timestamp. Part of #1957.
