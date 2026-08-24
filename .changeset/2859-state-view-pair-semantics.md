---
"@remnic/core": patch
---

Complete the #1952 state-view pair and temporal semantics (#2859): predecessor/successor pairs reconcile before the user cap/MMR so orphan removal never underfills (the cap counts complete evidence packets — a superseded row admitted with its successor consumes one slot), the reverse chain derives from the successor `supersedes` back-pointer when a predecessor lacks `supersededBy`, asOf labels use the temporal validity boundary (`invalidAt`, with `supersededAt` only as the legacy fallback) instead of the write-time supersession stamp, and chain identities are namespace-qualified so identical ids across namespace fanout never cross-anchor. Flag-off and non-change-query behavior stays byte-identical.
