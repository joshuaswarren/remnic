---
"@remnic/core": patch
"@remnic/plugin-pi": patch
Stability: stable
---

Widen the observe-buffer admission idempotency ring from 512 to 4096 entries per session buffer. The 512-entry FIFO only covered roughly fifteen minutes at typical capture load, so a drain outage longer than that made duplicate captures likely once a client outbox replay caught up; 4096 retains the most recent keys per session — about two hours at typical capture load; a replay of more than 4096 keys for one session still evicts its oldest keys. The client outbox stale-replay warning window and message now describe the wider bound (and note older daemons remember only their most recent 512 keys).
