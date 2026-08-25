---
"@remnic/core": minor
---

Per-directory abstract/overview sidecars, retrieval drill-down layer (issue
#2977): when directory sidecars are enabled and fresh, recall hits under a
winning directory receive that directory's neighborhood abstract. No LLM.

- New `applyDirectorySidecarDrillDown(memoryDir, query, hits, { enabled,
  namespace })`. `enabled: false` (the default) is a proven no-op: hits
  return unchanged and the missing-store path is never read. When enabled,
  directories are scored from stored sidecars with `{ refresh: false }`,
  stale sidecars are skipped, and the most specific fresh abstract is
  prepended as `Neighborhood: …`. Hit order is preserved.
- `enabled` stays a function argument. It is not a parseConfig key
  (`config.ts` / `types.ts` sit at their file-size ratchets).

Not in this layer (follow-ups on #2977): parseConfig wiring, storage.ts
write-hook, xray trajectory, live recall-pipeline wiring, and LLM
summarization.
