---
"@remnic/plugin-pi": patch
---

The Pi observe outbox now names the HTTP status and the replay key of a capture it drops after a permanent 4xx rejection, so a dropped capture can be traced. An existing but unreadable outbox file now fails the write instead of being treated as empty, which could let the next write replace the file and drop every queued capture; read-only views keep the last known entries. Behaviour note for callers of `RemnicClient.observe`: the idempotency key is `obs-<replayNonce>-<body hash>`, so reusing a key across separate `observe()` calls (for example a replay after a timeout) now requires passing the same `replayNonce`; a call without one gets a fresh key. The live hook and the outbox always pass the nonce. Full-outbox eviction of the oldest entries is unchanged and still warns with the count each time.

Stability: stable
