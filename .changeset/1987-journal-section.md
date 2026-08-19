---
"@remnic/core": patch
---

Add a pure ATX heading extractor for vault journal sections. A unique heading returns the body until the next same-or-higher heading. A missing heading returns null. Duplicate or empty headings are refused. No filesystem. Part of #1987.
