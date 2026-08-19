---
"@remnic/core": patch
---

Add a deep-recall budget clamp. 0 stays 0. Positive integers pass through. Negative, non-finite, and non-integer values throw. Part of #2332.
