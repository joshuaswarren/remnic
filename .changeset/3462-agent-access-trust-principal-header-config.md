---
"@remnic/core": minor
"@remnic/cli": minor
---

Add `agentAccessHttp.trustPrincipalHeader` config (default `false`; bool-like strings coerced) so fleet daemons can honor the `X-Engram-Principal` per-request principal header without passing `--trust-principal-header`. The explicit CLI flag still overrides the config; when both are unset the header stays ignored. Only enable behind the bearer-token trust boundary. Closes #3462.

Stability: stable
