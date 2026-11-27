---
"@remnic/plugin-pi": patch
---

The startup health probe now names a real HTTP credential rejection instead of reporting it as plain "Remnic offline": a 401/403 from the daemon's live probe yields the footer "Remnic offline — daemon rejected credentials (HTTP 401/403)". Network failures keep the plain offline label, and the offline re-probe/recovery path is unchanged.

Stability: stable
