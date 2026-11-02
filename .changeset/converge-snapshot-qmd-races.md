---
"@remnic/core": patch
---

Stability: stable

Survive transient snapshot and QMD races during converge. An offline sync
snapshot no longer fails when a memory file vanishes between the directory scan
and its hash read: the vanished file is skipped. The convergence refresh now
requests a forced strict QMD index update, so a min-interval throttle skip can
no longer be reported as a refreshed index while transferred memories remain
unsearched, and any real update failure still fails finalize before the cursor
advances. A QMD update failed by a transient sqlite `database is locked` error
no longer arms the failure backoff that would suppress the next update.
