---
"@remnic/core": patch
---

Tests only: pin that a failed first transcript append does not fail the next queued one for the same directory, and that cleanup drops the remembered transcript directories when it deletes a file whose rows are all expired (COS-666f).

Stability: stable
