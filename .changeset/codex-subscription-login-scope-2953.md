---
"@remnic/core": patch
---

codex-subscription: shared `codex login status` checks use a caller-independent
timeout budget so a short-deadline first waiter cannot starve a later request,
and in-flight login entries are scoped to the owning runner so one runtime's
shutdown cannot cancel another's precheck. Settled ChatGPT login successes stay
reusable across runners (issue #2953).
