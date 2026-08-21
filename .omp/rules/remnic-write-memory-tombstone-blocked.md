---
name: remnic-write-memory-tombstone-blocked
description: "Destructuring only { id } from writeMemory() drops the tombstoneBlocked signal; production call sites must gate post-write work on it"
astCondition:
  - 'const { id } = await $O.writeMemory($$$A)'
  - 'const { id: $X } = await $O.writeMemory($$$A)'
globs:
  - "**/*.ts"
interruptMode: never
---

Advisory: this call site destructures only `id` from
`storage.writeMemory(...)` and discards `tombstoneBlocked` (and
`blockedBy`) from `MemoryWriteResult`. When a tombstone blocks the
write, the memory lands as `pending_review` — continuing to index,
promote, link, or report "success" on it re-activates content the user
explicitly forgot. Reviewers flagged ~15 such call sites in a single PR
(#1724) after the `MemoryWriteResult` shape change.

Production call sites should read `tombstoneBlocked` and skip active
post-write work (indexing, dedup registration, success replies,
follow-on edges) when it is `true`.

Fine to ignore when: writing test fixtures that don't exercise the
tombstone path, or writing categories the tombstone gate never applies
to. If unsure, check `StorageManager.writeMemory` in
`packages/remnic-core/src/storage.ts`.
