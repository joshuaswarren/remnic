---
"@remnic/core": patch
---

Add `scripts/pr-merge-ready.sh <pr>` to finish a review-settled PR in one command: verify head-SHA check-run gates and the GraphQL unresolved-thread count with a printed evidence block, dismiss stale CHANGES_REQUESTED reviews (superseded commits) with a reason, merge `--squash` with one logged `--admin` retry when every verified precondition held, and delete the remote branch only after polling confirms `MERGED` (issue #2440).
