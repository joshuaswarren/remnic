---
"@remnic/core": minor
---

Add shared-context staleness helpers (issue #1957). `filterLiveEnvelopes` drops expired items on a half-open bound, and `markSupersededCirculation` flags superseded items that still circulate. Never deletes files. Part of #1957.
