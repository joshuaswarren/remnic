---
"@remnic/core": patch
---

Reject unknown `searchBackend` values (including `"builtin"`) at config load instead of silently coercing them to `"qmd"`.

Stability: stable
