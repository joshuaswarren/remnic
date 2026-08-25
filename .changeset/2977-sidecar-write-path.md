---
"@remnic/core": minor
---

Per-directory abstract/overview sidecars, write-path layer (issue #2977): a
memory write now populates the changed directory's sidecar and every category
ancestor, incrementally, using the layer-1 fingerprint/render path. No LLM.

- New `refreshDirectorySidecarsAfterWrite(memoryDir, changedPath, enabled)`.
  `enabled: false` (the default) is a proven no-op: no readdir, no writes.
  When enabled, only the changed directory's ancestry is refreshed, so a
  write does not walk the rest of the store. Deleting a child rewrites the
  parent and prunes an emptied directory's sidecar.
- `parseDirectorySidecarsEnabled` ships the off-default gate
  (`directorySidecarsEnabled`). Invalid/absent values stay false.

Not in this layer (follow-ups on #2977): wiring the key into `parseConfig`
(config.ts sits at its file-size ratchet), storage.ts write-hook, retrieval
drill-down that attaches neighborhood abstracts to hits, xray trajectory,
and LLM summarization.
