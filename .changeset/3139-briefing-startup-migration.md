---
"@remnic/core": patch
---

Run entity canonical-ID migration in the background during startup so briefings do not wait for its lock. Keep write barriers and migration retries unchanged. Retry entity reads under the journal's canonical ID when migration moves a file during a read.

Part of #3139. QMD startup waits and CLI JSON log output remain outside this change.

Stability: stable