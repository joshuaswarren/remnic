---
"@remnic/core": patch
---

Defuse three wall-clock deadline races in `release tests (packages-1)` that
were bundling the next merges into the following cut: a duration-deadline
scope-resolution test (#3140) and a raw-hint deadline test (#2206) now run
under mocked timers so the production budget elapses deterministically; the
destroyed-epoch startup test's hang-guard is right-sized to fail only on
genuinely never-settling lifecycles instead of bounding legitimate startup
cost. The ClawHub publish step in `release-and-publish.yml` is now marked
best-effort so a ClawHub-side outage cannot turn an already-published npm
release red. No public-package behavior change. Fixes #3158.

Stability: stable