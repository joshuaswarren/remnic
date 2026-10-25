---
"@remnic/cli": patch
---

Stability: stable

Keep `converge plan`, `apply`, and `watch` moving when one namespace census or peer snapshot fails. That namespace is left out of the plan on both sides, so nothing is pushed to it and nothing is deleted from it, and the cycle reports the exclusion. A plan that left a namespace out reports `converged: false`. A timeout on one snapshot alias still fails the cycle when the other alias only returns an HTTP error or a malformed body. A timeout while reading that failed response's body still fails the cycle instead of being recorded as an HTTP refusal. When every namespace census fails, the logged error has terminal control characters removed and the original rejection is kept as the cause. A missed peer file whose path contains transport wording excludes that namespace instead of failing the whole cycle. Names that share one physical root are excluded together, so a refusal of one alias cannot plan the others against an empty local side. The other namespaces still converge. A cycle where every namespace census fails still fails closed. A peer timeout or connection failure, including a hung planning download, fails the cycle instead of waiting out every remaining namespace. An apply download that times out stays a failed transfer for that file.
