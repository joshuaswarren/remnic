---
"@remnic/core": patch
---

Parse `activity.timeline.journal.source` (`"file"` default, `"vault"` opt-in)
and `heading` (required non-empty string in vault mode, trimmed; ignored in
file mode). Unknown sources and empty vault headings throw instead of
silently defaulting. Config parsing only; no runtime read path yet.
Part of #1987.
