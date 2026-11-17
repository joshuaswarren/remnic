---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
"@joshuawarren/openclaw-engram": patch
---

Stability: stable

Parse `agentAccessHttp.trustPrincipalHeader` (default `false`) and pass it to the embedded HTTP access server and to `access http-serve`, so the `x-engram-principal` per-request override can be enabled from config the same way `server.trustPrincipalHeader` already works on the standalone daemon. The `--trust-principal-header` CLI flag still enables trust; neither source disables the other.
