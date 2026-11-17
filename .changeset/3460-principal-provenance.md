---
"@remnic/plugin-pi": minor
Stability: stable
---

plugin-pi: emit writer identity as the `x-engram-principal` request header so turns carry per-writer provenance in `sessionOwnerPrincipal` (issue #3460). Resolution order: `principal` in `remnic.config.json`, then `REMNIC_PI_PRINCIPAL`, then auto-derived `HERDR_PANE_ID@<hostname>` when a herdr pane env is present. Without any of these, behavior is byte-identical to today. Effective when the daemon enables `server.trustPrincipalHeader`.
