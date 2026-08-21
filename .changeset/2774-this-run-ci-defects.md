---
"remnic-workspace": patch
---

CI and tooling fixes for the five defects a parallel five-PR batch actually hit:
`npm run test:file` now resolves the tsx CLI explicitly on every platform
instead of failing with an opaque `spawn tsx ENOENT`; a new
`npm run check:pre-push` bundles the cheap `checks`-job gates so they run in
seconds rather than being skipped; `check-ratchets` ends with an explicit
warning naming touched files at their size ceiling; the PR scope-budget gate no
longer counts a descriptive `the closed #123` as a claimed issue; and the AI
review gate's reviewer-absence path concludes `success` with a stated reason so
it stops forcing an admin merge that would bypass every other required check.
