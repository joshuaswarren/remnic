---
"@remnic/core": patch
---

Add `buildStateEvidencePackets`: groups state-view entries into per-head evidence packets so superseded records stay visible as nearest-first history, with dangling and cyclic links reported as orphans instead of dropped. Internal helper only — the recall-path wiring that would use this ordering lands in a later slice. Part of #1952.
