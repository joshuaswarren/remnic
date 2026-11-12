---
"@remnic/core": patch
---

The hourly summarizer no longer starts a gateway call after the daemon shutdown signal has aborted its local LLM call. The gateway fallback now returns no summary once shutdown has begun, for both the standard and the extended summary.

Stability: stable
