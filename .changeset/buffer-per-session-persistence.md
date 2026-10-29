---
"@remnic/core": patch
Stability: stable
---

Fixed the smart buffer's persistence cost: buffered turns now live in one file per session under `state/buffer/` instead of a single `state/buffer.json`, and a save writes only the sessions whose state changed. A daemon with many active sessions no longer re-serializes every buffered turn on each observe. An existing `state/buffer.json` is migrated to per-session files on first load — an interrupted migration keeps the newer per-session file and resumes from the legacy snapshot — and the per-session files are encrypted at rest with the rest of the store's state sidecars.
