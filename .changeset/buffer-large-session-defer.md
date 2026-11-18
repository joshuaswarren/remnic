---
"@kore/remnic-core": patch
---

Rate-limit whole-file rewrites of large buffer session files (#3389). A hot
session file grew to tens of megabytes and was rewritten on every flushed
turn, so `durable-bufferMs` dominated observe latency (~99%, worst ~10 min)
on a serialized mutation chain while disk utilization stayed ~2%. Steady-state
persist passes now defer rewriting a dirty session at or above 8 MiB that was
persisted within the last 60s; it stays dirty and lands on the next pass or on
any durability barrier. First-ever persists, drain-claimed sessions, small
sessions, extraction-trigger saves, explicit `buffer.save()`, and
`flushPendingSave` barriers are never deferred — the added crash-loss window
matches the sanctioned `bufferSaveDebounceMs` semantics.
