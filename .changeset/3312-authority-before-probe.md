---
"@remnic/core": patch
---

Close the stale-MISS race in the in-window fact dedup check. `confirmActiveFactDuplicate` now reads the shared index through one `StorageManager.lookupContentHash` call that returns the MISS together with the authority behind it. Before, the probe and a separate authority read could each rebuild the index, so a MISS read while a peer held the index lock could be trusted once the lock cleared, and a raced duplicate was written. An authoritative MISS still skips the corpus scan; any other answer confirms against the corpus. Fixes #3312 (finding 2).

Stability: stable
