---
"@remnic/core": patch
---

Run entity canonical-ID migration in the background during startup so briefings do not wait for its lock. Keep write barriers and migration retries unchanged. Retry entity reads under the journal's canonical ID when migration moves a file during a read.

Full readiness and shutdown wait for the background job. Direct and batch entity reads follow file moves without duplicate mapped entities.

Reject symlinked entity entries before startup replay and at direct, batch, and canonical-retry reads. Preserve encrypted-read errors and distinct migration claimants.

Part of #3139. QMD startup waits and CLI JSON log output remain outside this change.

Stability: stable