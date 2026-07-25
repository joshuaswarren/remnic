---
"@remnic/core": minor
---

Replica divergence detection (#2149): a daemon configured with `replicaPeers` polls each peer's authenticated `/health` corpus watermark on an interval and flags per-namespace drift — file-count delta, newest-write age delta, and digest mismatch (equal counts but different content: the split-brain case) — plus a namespace present on only one side. Results surface in a new `replica` block on `GET /engram/v1/health` and in the `remnic doctor` `replica_divergence` check.

A peer that times out, refuses the connection, returns non-2xx, or omits `corpus` is reported as a distinct `unreachable`/`unknown` state, never conflated with `converged` (a monitor must tell "peer agrees" from "we could not ask"). The poller prefers `GET /remnic/v1/health` and falls back to the legacy `GET /engram/v1/health`, bounds each request with a timeout and caps concurrent fetches, resolves peer tokens through the same `agentAccessHttp.authToken` indirection (never logging or echoing a token, and redacting peer identity to `host:port`), and serves cached poll state stale-while-revalidate so a health probe never blocks on peer I/O. The `/health` `replica` block is filtered to the presenting token's namespace capabilities, exactly like `corpus`. Disabled by default; a daemon with no peers behaves exactly as before. Detection only — reconciliation is tracked in #2150.
