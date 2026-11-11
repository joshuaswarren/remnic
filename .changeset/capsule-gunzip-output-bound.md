---
"@remnic/core": patch
---

Stability: stable

Capsule import and merge gunzip archives through one shared helper with a hard decompressed-size cap (`CAPSULE_IMPORT_MAX_GUNZIP_BYTES`, 64 MiB). A small gzip that expands past the limit is refused with a clear oversize error instead of unbounded allocation; normal capsules still import.
