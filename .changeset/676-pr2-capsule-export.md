---
"@remnic/core": minor
---

feat(capsule): capsule export pipeline (#676 PR 2/6)

Add `exportCapsule()` in `packages/remnic-core/src/transfer/capsule-export.ts`
— a pure async function that bundles a memory directory into a portable,
capsule-aware V2 export. Output is a single `.capsule.json.gz` archive plus
a sidecar `manifest.json`. Supports `since` (mtime cutoff), `includeKinds`
(top-level subdirectory allow-list, transcripts opt-in), and `peerIds`
(peers/ subtree filter). No CLI surface yet; that lands in PR 6/6.
