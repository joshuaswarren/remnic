---
"@remnic/core": patch
---

Stability: stable

Stop an unscoped `TranscriptManager.readRecent(hours)` (no `sessionKey`) from reading and parsing every transcript file ever written. It now skips daily partitions (`<type>/<channel>/YYYY-MM-DD.jsonl`) named for a UTC date earlier than the window start (less one day for clock skew); every other file, including legacy `<type>/<channelId>.jsonl` and root-level files even when their names look like dates, is always read, and explicit `readRange` calls are unchanged. On a store with thousands of transcript files this was a recall `transcript` section stall of tens of seconds on any recall that arrived without a session key.
