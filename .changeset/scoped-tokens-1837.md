---
"@remnic/core": minor
"@remnic/server": patch
---

Add per-token scoped capabilities (#1837). Tokens minted via the CLI now accept
`--ops <comma-list>` and `--namespaces <comma-list>` flags that constrain the
token to an explicit allow-list of operations and namespaces; invalid op names
or malformed namespace values are rejected at mint time. The access boundary's
`run()` chokepoint enforces the ops allow-list via AsyncLocalStorage for every
registered operation, HTTP routes enforce via `enforceTokenOp` / namespace
checks, and operator/admin routes deny scoped tokens. Every newly-minted token
carries an explicit versioned `{ version: 1 }` capability record — even when no
flags are given — so it is mechanically distinguishable from a pre-feature
legacy entry. Legacy tokens (absent capabilities field) retain full, backward-
compatible access; "full access via omission" is reachable only by entries that
predate this feature.
