---
"@remnic/core": patch
"@remnic/cli": patch
Stability: stable
---

Run the post-ready QMD corpus sync without remnic-server: the deferred path fires `startupSearchSync` once `deferredReady` settles, and freshness-dependent one-shot commands (`xray`, `why`, local-service commands) join the same shared flight instead of querying a stale index. The flight is owned by a shared controller so a joiner's abort settles its own wait without cancelling the run for live callers, a completed run publishes `deferredSyncSucceeded` for its epoch directly, and a `false` join warns rather than silently querying stale data.
