---
"@remnic/core": patch
---

Stamp a governance envelope on every shared-context agent output: frontmatter `sharedBy` (origin), `authority` (`informational` | `advisory` | `binding`, default `informational`), plus optional `expiresAt`/`supersedes` passthrough. Authority is least-privileged end to end: an unrecognized or missing value never resolves above `informational`, binding writes require both an explicit request and the new `sharedContextAllowBindingAuthority` opt-in (default `false`), and stored `binding` items read as `advisory` without the flag. Cross-signals reports and the daily roundtable annotate every source with its resolved authority and origin; legacy items without an envelope keep working unchanged. First control from #1957; staleness propagation, contradiction handling, provenance-preserving curation, and the trajectory repository remain open.
