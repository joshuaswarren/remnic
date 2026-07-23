---
"@remnic/core": patch
---

Recall no longer drops daemon-mode QMD candidates when the hot-facts collection is registered at the facts/ subtree: qmdResultPathCandidates now probes the facts/<date>/ fallback for pre-absolutized result paths inside the storage root (mirroring the existing relative-path fallback), and the dead private duplicate of the helpers in access-service.ts is removed (issue #2111).
