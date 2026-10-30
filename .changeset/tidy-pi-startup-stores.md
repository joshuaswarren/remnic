---
"@remnic/plugin-pi": patch
---

Correct recall-breaker comments to describe the fixed five-minute recovery cooldown. Warn once at startup when the plugin and daemon advertise different release versions, without failing startup. Add up to 250 ms jitter before explicit REST and MCP memory stores and one retry on HTTP 503, timeout, or transient connection failure, reusing the write's idempotency key. Each store attempt retains its configured timeout; recall deadlines, scope, and retry behavior are unchanged.

Stability: stable
