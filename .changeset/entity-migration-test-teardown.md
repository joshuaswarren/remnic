---
"@remnic/core": patch
---

Stability: stable

Entity lazy-compatibility tests now wait for the deferred entity canonical-id migration before removing their temporary store, and settle the startup migration before counting reads. This removes two intermittent test failures (ENOTEMPTY on teardown and an extra counted read). No runtime behavior changes.
