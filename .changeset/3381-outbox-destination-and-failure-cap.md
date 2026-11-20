---
"@remnic/plugin-pi": patch
Stability: stable
---

Observe-outbox hardening (issue #3381, items 4, 6, 9, 11): an unrecognized 5xx from the daemon is now classified `retry-ambiguous` instead of `permanent`, so a transient `internal_error` no longer drops the capture; each entry carries a persisted `failedAttempts` count and leaves the queue after 8 ambiguous failures with a visible warning, so a deterministic 5xx cannot pin the FIFO. Entries now record the daemon URL they were enqueued for (`destination`), and a drain only sends entries matching its own configured `remnicDaemonUrl` — a pane repointed at another daemon no longer replays someone else's conversations to the wrong destination; pre-field entries replay anywhere, as before. Oversized `rawContent` (over 32 KiB serialized per message) is omitted from the durable replay so the 200-entry bound bounds disk too, while the rendered text, hashes and replay nonce keep the capture's identity. The drain test suite now settles its background drain under its own fetch mock instead of restoring `fetch` mid-retry. Refs #3381.
