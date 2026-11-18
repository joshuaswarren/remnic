---
"@remnic/core": patch
---

Rate-limit whole-file rewrites of large buffer session files (#3389). A hot
session file grew to tens of megabytes and was rewritten on every flushed
turn, so `durable-bufferMs` dominated observe latency (~99%, worst ~10 min)
on a serialized mutation chain while disk utilization stayed ~2%. Steady-state
persist passes now defer rewriting a dirty session at or above 8 MiB that was
persisted within the last 60s; it stays dirty and a retry is armed for when it
becomes rewrite-eligible, so a burst's tail lands without another turn.
First-ever persists, drain-claimed sessions (and backends that cannot prove a
session is unclaimed), small sessions, extraction-trigger saves, explicit
`buffer.save()`, and `flushPendingSave` barriers are never deferred — the added
crash-loss window matches the sanctioned `bufferSaveDebounceMs` semantics.

Stability: stable
