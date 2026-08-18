---
"@remnic/core": minor
---

Add the host-agnostic timeline-card layer over the activity store (issue #2049): deterministic grouping into cards with stable evidence-derived ids, explicit idle/gap and user-pause semantics, a validated ordered category registry with a deterministic first-pass classifier, and a correction store whose manual edits survive rebuilds. Gated by `activity.timeline.enabled`, default false. Fixes #2049.
