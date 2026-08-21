---
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Fix OpenClaw plugin install rejection on stable hosts (issue #1450).
`openclaw.compat.pluginApi` used a `||`-joined version list, but OpenClaw's
installer checker (`clawhub.ts`) splits the range on whitespace and requires
every token to pass — so it fails as soon as it reaches the first `||` token,
and the package never installed on any host (it fell back to the `1.0.x` line).
The stable release `2026.6.1` was also missing from the list.

`openclaw.compat.pluginApi` now uses the single `>=2026.4.1` comparator
OpenClaw's checker accepts. OpenClaw normalizes away the host prerelease suffix
when comparing against a plain target, so this floor matches all stable **and**
prerelease hosts from `2026.4.1` forward (including stable `2026.6.1`).
`peerDependencies.openclaw` keeps the explicit `||` prerelease list because it
is resolved by npm/node-semver (which supports `||` but drops prereleases from a
bare `>=` range) — the two fields are intentionally decoupled by resolver.
`minHostVersion` already used the `>=2026.4.1` shape.
