---
"@remnic/core": patch
Stability: stable
---

`buildStateEvidencePackets` now memoizes per-entry head resolution: one long supersession chain resolves in a single pass instead of re-walking the suffix per entry (scripts/bench-state-packet-chains.ts: 2618ms -> 21ms at 4000 entries). Output is unchanged; every cached node keeps its own depth. Closes #3565.
