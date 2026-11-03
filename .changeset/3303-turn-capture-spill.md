---
"@remnic/core": patch
---

Stability: stable

Stop dropping live turn capture when the extraction buffer is at its 200-session entry cap. A capture that arrives while the single extraction worker is busy now spills to a durable spill queue (persisted with a whole-state save) and is admitted FIFO when capacity frees; the buffered observe returns normally instead of throwing `ReplayAdmissionRefusedError`. Fixes the live-data-loss w9C measured (25-40% of live captures dropped at busy hours since October 27). Fixes #3303.
