---
"@remnic/core": minor
"@remnic/cli": minor
---

Add `remnic buffer drain`: one command empties the extraction buffer out of process. Worker processes with their own orchestrator drain the backlog (same chunking, retry/backoff, provider circuit-breaker and dropped-chunk recovery as the daemon), each session is claimed into a durable claim file first so a kill loses nothing and the next run resumes, and a live buffer owner hands claimed turns into the claim instead of resurrecting them.

Stability: stable
