---
"@remnic/core": minor
---

Recognition-index write-path maintenance (issue #2975): when
`recallRecognitionTier` is enabled, a namespace memory write upserts the
memory id into `state/index_recognition.json` so the recall slice's
`loadRecognitionIndex` sees a fresh entry. Off-path is a proven no-op —
zero index I/O. Descriptions stay first-line extraction; the
discriminability tidy pass is a later layer.

- New `maintainRecognitionIndexAfterWrite({ memoryDir, enabled, changes })`.
  `enabled: false` returns before any read, write, or lock.
- Extraction persist updates the namespace index through the existing
  `updateTemporalTagIndexes` post-write hook (capability gates for the
  temporal/tag indexes stay independent).
- No new config keys. `saveRecognitionIndex` remains single-writer; this
  slice serializes with an op chain plus directory lock.
- A missing index is bootstrapped from the active corpus so the first
  post-enable write cannot publish a 1-id index that recall would treat
  as the full working set. Abandoned directory locks older than 60s are
  reclaimed.

Not in this layer (follow-ups on #2975): storage.ts direct-write hook,
RetrievalTier += recognition + xray labels, discriminability tidy pass,
synthetic bench.
