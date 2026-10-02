---
"@remnic/core": patch
---

Defuse three wall-clock deadline races in `release tests (packages-1)` that
were bundling the next merges into the following cut: a duration-deadline
scope-resolution test (#3140) and a raw-hint deadline test (#2206) now run
under mocked timers so the production budget elapses deterministically; the
destroyed-epoch startup test's hang-guard is right-sized to fail only on
genuinely never-settling lifecycles instead of bounding legitimate startup
cost. `scripts/clawhub-publish.sh` now classifies the Convex 512MB action
OOM alongside the existing read/rate-limit strings as transient, so the
specifically recognised third-party backend failure modes no longer mark an
already-published release red while unknown ClawHub failures stay fatal.
No public-package behavior change. Fixes #3158.

Stability: stable