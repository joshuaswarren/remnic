---
"@remnic/core": patch
---

Let `withBriefingDeadline` and `BriefingTimeoutError` take an optional label so other commands can reuse the same deadline with a correctly worded timeout message. Existing callers keep the briefing wording by default. Part of #3139.

Stability: stable
