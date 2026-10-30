---
"@remnic/core": patch
---

Stabilize the timeout subprocess regression by waiting for observed child-close cleanup before asserting the tracking set is empty. Provider behavior, timeout classification, and runtime deadlines are unchanged.

Stability: stable
