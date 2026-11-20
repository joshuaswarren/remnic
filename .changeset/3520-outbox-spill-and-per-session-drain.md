---
"@remnic/plugin-pi": patch
Stability: stable
---

Observe-outbox durability and per-session replay (issue #3520): a full outbox no longer loses captures — incoming captures that cannot join the 200-entry hot queue park in a durable `<outbox>.spill` file under the same lock and JSONL durability, and refill the queue's tail as it drains, keeping global FIFO across restarts. The spill is bounded (`maxSpillEntries`, default 5000); only past the disk bound do captures actually drop, with an error-level notification naming the count and `status().spilled` reporting what is parked. A retryable refusal now skips that `sessionKey` for the rest of the drain pass, so a session pinned at the daemon's cap keeps its own retry budget but can no longer starve every session queued behind it. Eligible spilled captures still replay past a hot window full of foreign-destination or blocked entries, and spill appends are flushed like the queue's atomic writes. Refs #3520.
