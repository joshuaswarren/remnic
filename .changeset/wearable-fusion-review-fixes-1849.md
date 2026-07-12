---
"@remnic/core": patch
---

Address second-round reviewer findings on the wearable cross-source fusion foundation (PR #1849 / issue #1810): normalize renderer `24:xx` midnight clocks to valid `00:xx` ISO and roll cross-midnight conversation windows when reconstructing fusion inputs; prefer a longer corroborating transcript over a truncated high-trust clip; keep distinct cross-source untimestamped utterances from collapsing on speaker key; treat raw diarization keys (`SPEAKER_00`) as generic speakers; and relocate the fused-day file IO out of the root `storage.ts` watchlist file (LOC ratchet) into a new `FusionArtifactStore` under `wearables/fusion/store.ts`.
