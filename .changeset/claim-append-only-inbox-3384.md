---
"@remnic/core": patch
"@remnic/cli": patch
---

A buffer owner handing turns into a drain claim now appends one record to an append-only inbox beside the claim instead of reading, merging and rewriting the whole claim file under its lock, so the observe path's cost no longer grows with the claim's size (#3384). Readers fold the inbox over the claim with the same identity-aware merge; the drainer's progress write and ack compact it, and a kill between the claim write and the inbox delete replays nothing. Claim listings and the hand-over gate read a cached turn count, and `isDrained` verifies a drained verdict with one real read. To roll back to a build that predates this change, first run `remnic buffer drain --fold-inboxes` (see docs/ops/buffer-drain.md).

Stability: stable
