---
"@remnic/core": patch
---

Add `checkStateViewZeroDiff`: a pure guard comparing the recall inject lines produced without state views (baseline) against the same lines with state views enabled (annotated). When no historical or transition item is present, any byte-level change to a current line's text or to the memoryId ordering is reported as a failure, which makes issue #1952's "zero diff for existing users when no historical item qualifies" promise checkable by callers. Standalone helper — recall-path wiring is a later slice. Part of #1952.
