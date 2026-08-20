---
"@remnic/core": patch
---

Add a span provenance builder. Verified offsets produce the quote/charStart/charEnd triple; empty spans, out-of-range offsets, and non-matching quotes return `{ok:false}`. Non-integers throw. No on-disk format change. Part of #2333.
