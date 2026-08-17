---
"@remnic/core": patch
---

Enforce the review-round budget ledger (issue #2442): the per-PR round comment counts fix rounds, posts a one-time warning reply at fix round 3, and at fix round 4 automatically files ONE backlog issue listing every still-open non-critical thread with permalinks, labels the PR `review-round:cap`, and links the issue from the ledger. Never fails a check or blocks merge — zero-unresolved-threads stays the merge gate.
