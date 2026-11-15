---
"@remnic/plugin-pi": patch
"@remnic/core": patch
---

Stability: stable

Three follow-ups from the observe outbox review (#3381):

- Pi observe: identical chunks of one observe now get distinct idempotency keys, so the daemon no longer drops the second chunk as a replay. The key keeps its length, and a single-chunk observe keeps the key it had before.
- MCP: a missing storage target now returns its explanation as the tool text instead of "internal error", and is no longer logged as an internal error. HTTP already answered it as a 400 request fault.
- Pi outbox: a replay stopped by rejected credentials (401/403) no longer adds a "daemon saturated" warning on top of the credentials warning.
