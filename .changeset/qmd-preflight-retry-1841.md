---
"@remnic/core": patch
---

fix(qmd): retry transient `--version` preflight and split the failure log

The configured-`qmdPath` version probe now classifies a probe failure before
warning: a timeout/abort (binary started but exceeded the deadline, or was
aborted mid-spawn) is retried up to twice with a small backoff, while an
ENOENT/EACCES (missing or not-executable binary) fails fast. The two classes
emit distinct operator-facing warnings — `version check timed out (host may be
under load); retried N times` vs `configured qmdPath not found or not
executable` — so a slow binary under load is no longer mistaken for a real
misconfiguration. A transient timeout that succeeds on retry emits no warning at
all. The throttle/dedup behavior of `logCliProbeWarning` is preserved. Closes
#1841.
