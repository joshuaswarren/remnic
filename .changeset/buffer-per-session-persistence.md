---
"@remnic/core": patch
---

Stability: stable

Fixed the smart buffer's persistence cost: buffered turns now live in one file per session under `state/buffer/` instead of a single `state/buffer.json`, and a save writes only the sessions whose state changed. A daemon with many active sessions no longer re-serializes every buffered turn on each observe. An existing `state/buffer.json` is migrated to per-session files on first load; an interrupted migration keeps the newer per-session file and resumes from the legacy snapshot. The per-session files follow the secure-store encryption policy of the other state files (encrypted when a key is configured and encryption on write is enabled, plaintext otherwise). File names are the SHA-256 of the buffer key, so keys that differ only by case never share a file, and a symlinked `state/buffer` directory is refused.
