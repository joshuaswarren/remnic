---
"@remnic/connector-limitless": patch
---

Stability: stable

Recover timed-out lifelog requests with smaller pages at the same cursor, retaining subsequent pagination and the existing per-request deadlines and retry budgets. Treat response-body timeouts as recoverable rather than malformed JSON.
