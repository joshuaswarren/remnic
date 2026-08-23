---
"@remnic/core": patch
---

codex-subscription: harden the request lifecycle (issue #2833, follow-ups
to #2828). Each request now times out on its own budget while sharing an
in-flight `codex login status` check — a short-deadline caller no longer
waits out another request's longer check, and caller cancellation reaches
the login subprocess (no spawn when pre-aborted, in-flight wait aborts,
shared check only cancels when the last waiter leaves). A cached ChatGPT
login is revalidated when the Codex auth store changes on disk, so a later
API-key login cannot be masked; relative `HOME`/`CODEX_HOME` resolve
against the original process cwd so login and exec always see the same
auth home. `codex-subscription` `apiKey`/SecretRef config is rejected
before any secret resolution, timeout classification wins over auth
patterns in mixed output, a timed-out child that traps SIGTERM and exits 0
still reports `TimeoutError`, and terminal typed provider errors
(timeout/auth/config) survive `FallbackLlmClient` chain exhaustion instead
of collapsing into a generic empty result. Detached Codex child process
groups are tracked and terminated on parent SIGINT/SIGTERM/shutdown.
