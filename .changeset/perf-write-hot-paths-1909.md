---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Eliminate O(file-size) work from four per-write hot paths (issue #1909):

- Plaintext secure appends now classify a file as encrypted by reading only the
  fixed-size magic header (cached per path, self-invalidated on in-process
  rewrites and key changes) instead of reading the whole target file (a
  lifecycle ledger can grow to hundreds of MB on a large corpus).
- `writeMemory("fact", …)` gains `deferHashIndexSave`; the extraction persist
  path defers the per-fact fact-hash-index flush to the existing authoritative
  batch save, turning 11 whole-index rewrites per 10-fact batch into 1. Single
  writers keep the immediate, crash-safe save; deferred hashes remain
  rebuildable from the durable fact corpus.
- `appendBehaviorSignals` keeps its dedup key set in memory, validated by
  (size, mtime) file identity, instead of re-reading + JSON.parsing the whole
  `behavior-signals.jsonl` on every append.
- The smart buffer coalesces per-turn saves onto a trailing-edge debounce
  (`bufferSaveDebounceMs`, default 3000ms; `0` restores save-every-turn);
  extraction trigger/clear and daemon shutdown force an immediate flush.
