---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
---

Stability: stable

Accept an optional client `deadlineMs` on the recall request and clamp the daemon's outer deadline to the tighter of `recallOuterTimeoutMs` and the client deadline, using the force-flush absolute-vs-relative convention (#3140). The clamped deadline drives the enrichment abort handles, the bounded core-section runner, and the episodic-context section, and an already-passed deadline degrades sections immediately rather than rejecting the recall. The OpenClaw delegate publishes its hook deadline (`promptDeadline`) so a recall cannot outlive the budget the host granted (#3499).
