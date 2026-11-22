---
"@remnic/core": patch
Stability: stable
---

`renderMemoryMd` no longer emits one `## Task` block per memory category — every block listed the identical rollout files, claiming per-task scoping that did not exist. The output now uses a single task per namespace carrying all rollout summaries and union keywords, which is the documented contract until real topic clustering exists. Category content still appears in the User preferences / Reusable knowledge / Failures sections. Refs #3614.
