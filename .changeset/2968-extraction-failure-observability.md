---
"@remnic/core": patch
---

Surface distinct extraction parse-failure classes at warn level (issue #2968). `parseWithSchemaDetailed` already knew `http_error` vs `empty` vs no-models internally, but schema rejection and the 90s abort-race timeout collapsed into those, and the extraction caller logged a single `extraction fallback returned no parsed output` line (detail only at debug). The warn line and `llm_error` event now carry `failureReason`, `modelUsed` when a model was selected, a redacted HTTP status/error class, and `traceId`. Timeouts stay their own class. Existing success `{ result, modelUsed }` and the historical `"no_models" | "empty" | "http_error"` reasons are unchanged; fingerprints remain retryable.
