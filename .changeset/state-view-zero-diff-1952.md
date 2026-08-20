---
"@remnic/core": patch
---

Add `checkStateViewZeroDiff`: a pure guard comparing the recall inject lines produced without state views (baseline) against the same lines with state views enabled (annotated). When no historical or transition item is present the guard reports `verified` and any byte-level change to a current line's text or to the memoryId ordering is a failure; when such an item is present it reports `not_applicable` because the promise's precondition is false. This makes issue #1952's "zero diff for existing users when no historical item qualifies" promise checkable, and a test exercises the real `injectStateViewLines` pipeline through it rather than only the guard in isolation. Wiring the guard into a runtime caller is a later slice. Part of #1952.
