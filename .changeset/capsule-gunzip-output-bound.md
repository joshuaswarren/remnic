---
"@remnic/core": patch
---

Stability: stable

`importCapsule` gunzips capsule archives with a hard decompressed-size cap (`CAPSULE_IMPORT_MAX_GUNZIP_BYTES`, 64 MiB). A small gzip that expands past the limit is refused with a clear oversize error instead of unbounded allocation; normal capsules still import.
