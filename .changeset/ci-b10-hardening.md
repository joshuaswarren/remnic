---
"@remnic/core": patch
---

Add a CI gate asserting the navigation link-type vocabularies agree (`scripts/check-nav-link-vocabularies.mjs`, wired into the `checks` job), a batched review-thread helper that replaces per-PR list queries and per-thread resolve mutations with one aliased query and one aliased mutation — plus one extra query per additional page for a PR with more than 50 threads — and three review defect classes documented in `.omp/rules/README.md`. The proposed rule for literal-union widening was measured against the tree, matched 13 legitimate frozen data arrays, and is recorded as rejected rather than shipped.
