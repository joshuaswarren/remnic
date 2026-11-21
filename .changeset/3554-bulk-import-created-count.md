---
"@remnic/core": patch
Stability: stable
---

`bulk-import` now reports `Memories created` from each batch's own persisted count instead of diffing the memory directory before and after the batch. Extractions from other sessions that write to the same memory root during an import no longer inflate the count. Refs #3554.
