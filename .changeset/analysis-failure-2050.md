---
"@remnic/core": patch
---

Add `classifyAnalysisFailure` to the activity timeline layer: a pure,
fail-closed classifier for timeline analysis failures. Unknown kinds throw a
`TypeError` listing the allowed kinds, only `provider_unavailable`,
`timeout`, and `rate_limited` are retryable, and every failure kind
preserves the deterministic cards unchanged. Part of #2050
