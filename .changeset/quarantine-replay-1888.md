---
"@remnic/core": patch
"@remnic/cli": patch
---

Add `remnic quarantine replay --namespace <ns> [--principal <p>]` to re-submit ACL-rejected, dead-lettered writes once the namespace config is fixed (#1888). A new `suppressQuarantine` flag on the write envelope and observe request lets replay re-submit through the same access surface without the replay attempt itself being re-quarantined: a target that is still not writable propagates the error, so the entry is recorded as a failure and left parked (never duplicated) instead of dead-lettered again. `WriteQuarantineStore` gains `entries()` (records paired with their on-disk path) and a containment-guarded `removeEntry()`; an entry is only counted as replayed when both the re-submit and its removal succeed.
