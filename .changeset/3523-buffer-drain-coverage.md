---
"@remnic/core": patch
"@remnic/cli": patch
Stability: stable
---

Test coverage only: buffered turn ingestion (storage-target refusal, replay duplicate idempotency, admission refusal, pending-save flush and extraction queueing, `keep_buffering`, LCM archive observation), HTTP admission error mapping, capsule import path validation, and CLI JSON-mode logging routing every level to stderr. No runtime behavior change. Refs #3523.
