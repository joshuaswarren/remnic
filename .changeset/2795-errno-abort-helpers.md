---
"@remnic/core": patch
---

Migrate straggler abort and errno call sites to the shared helpers: offline-sync aborts now surface the `AbortError` name (previously a plain `Error`), and `isNotFoundError` is exported from `utils/errno.ts`. Closes #2795.
