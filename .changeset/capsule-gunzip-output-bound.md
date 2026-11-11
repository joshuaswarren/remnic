---
"@remnic/core": patch
---

Capsule import, merge and inspect now gunzip archives through one shared helper with a hard decompressed-size cap (`CAPSULE_IMPORT_MAX_GUNZIP_BYTES`, 64 MiB). A small gzip that expands past the limit is refused with a clear oversize error instead of an unbounded allocation. `capsule inspect` is the command an operator runs first on an untrusted archive, so it applies the same cap on both the plain and the encrypted path. Normal capsules still import. An invalid gzip in `importCapsule` now fails with the same `archive is not a valid gzip file` message that `mergeCapsule` already used. Part of #3225 (finding C3).

Stability: stable
