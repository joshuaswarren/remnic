# Offline sync applies memory changes only through atomic generation transactions

Status: accepted

## Context
Embedding generations span many files; a crash between direct per-file writes would leave a receiver serving a mixed-generation index. Some generation members approach the runtime string ceiling, so inline content paths cannot carry them. Local and remote state can disagree, and interrupted runs must resume from safe checkpoints.

## Decision
- Every change belonging to one embedding generation is one transactional item, staged and published atomically — never written per-file at final paths. Excluded members are still fetched with content and staged by the same transaction. Each request carries only the manifest entries for the generations it actually applies, so a receiver can never apply half a generation.
- Members too large for the inline base64 path are fetched chunk-wise into a private, secure-store-bound staging root; the transaction consumes the staged bytes through its apply callback, and only the transaction ever touches live marker and shard paths. Metadata-only preparation fills content the same way sync does: small files via base64 batches, oversized generation members chunk-wise into staging.
- Apply classifies incoming changes against the node-local local view — including local state stores — never against a push-filtered snapshot, or incoming upserts would misclassify as locally-deleted-but-remotely-modified.
- Checkpoints keep the original capture time for conflicted and deferred paths so the next run's fast-base reuse stays safe; a staging failure after a successful push still checkpoints the advanced base, matching the direct-hydration contract.
- Watch-mode 3-strikes exclusions apply to the changeset path as well as the direct-push path, or the changeset path would re-attempt skipped large files inline; the watch loop warns once when a path is retired and stays silent on later passes.
- Status folds durable pending impression and lifecycle spills before summarizing, so it reports the same pending set a following sync would push; a deferred or failed drain aborts the status rather than reporting a silent undercount.
- Enrichment candidates persist only through the sealed envelope. Generic command outputs are written by ensuring the parent directory exists and renaming atomically — an existing file is never deleted before the new one is successfully written.

## Consequences
Staging costs extra disk for oversized members, and transactional batching couples the fates of members within one generation. The payoff is crash-safety: no mixed generations, no lost checkpoints, no half-applied indexes.

## Origin comments
- `packages/remnic-cli/src/enrichment-persist.ts:10` — "/** * Persist one accepted enrichment candidate through the sealed envelope * (issue #1989 PR4). Enrichment-provider o"
- `packages/remnic-cli/src/index.ts:7439` — "// Embedding generation members must flow through the atomic generation"
- `packages/remnic-cli/src/index.ts:7440` — "// transaction, never through direct per-file hydration writes at their"
- `packages/remnic-cli/src/index.ts:7441` — "// final paths (issue #3148, codex round 6: a crash between direct writes"
- `packages/remnic-cli/src/index.ts:7442` — "// would expose a mixed generation). Excluded members are still fetched"
- `packages/remnic-cli/src/index.ts:7443` — "// WITH content by hydrateOfflineSnapshotContent (they are runtime-"
- `packages/remnic-cli/src/index.ts:7444` — "// authoritative in offlineSnapshotContentFilesForApply), so the"
- `packages/remnic-cli/src/index.ts:7445` — "// transaction stages and publishes them atomically."
- `packages/remnic-cli/src/index.ts:8081` — "// Generation-coherent batching (issue #3150): every change belonging to one"
- `packages/remnic-cli/src/index.ts:8082` — "// embedding generation is ONE item that must never be split across"
- `packages/remnic-cli/src/index.ts:8083` — "// requests — a receiver applying half a generation would serve a mixed"
- `packages/remnic-cli/src/index.ts:8084` — "// index. Each request carries only the manifest entries for the"
- `packages/remnic-cli/src/index.ts:8085` — "// generations it actually applies."
- `packages/remnic-cli/src/index.ts:8452` — "// 3-strikes policy (#1786): the watch loop already logged a single"
- `packages/remnic-cli/src/index.ts:8453` — "// warning when this path was retired; stay silent on later passes."
- `packages/remnic-cli/src/index.ts:8560` — "// Partial checkpoints do not recapture conflicted/deferred paths, so keep"
- `packages/remnic-cli/src/index.ts:8561` — "// the original capture time for safe fast-base reuse on the next run."
- `packages/remnic-cli/src/index.ts:8614` — "// 3-strikes skipped large files must be excluded here too — the"
- `packages/remnic-cli/src/index.ts:8615` — "// direct-push loop skips them, but without this line the changeset"
- `packages/remnic-cli/src/index.ts:8616` — "// path would still try to upsert them inline (Cursor review, PR"
- `packages/remnic-cli/src/index.ts:8617` — "// #1793, High severity)."
- `packages/remnic-cli/src/index.ts:8770` — "// Apply-side local view (#1793 review, High): must see node-local state"
- `packages/remnic-cli/src/index.ts:8771` — "// (state/lcm.sqlite etc.) or incoming upserts misclassify as"
- `packages/remnic-cli/src/index.ts:8772` — "// local_deleted_remote_modified. Never reuse the push-filtered snapshot"
- `packages/remnic-cli/src/index.ts:8773` — "// for apply."
- `packages/remnic-cli/src/index.ts:8792` — "// Oversized generation members cannot ride the inline base64 content"
- `packages/remnic-cli/src/index.ts:8793` — "// path: the base64 string of a near-512MiB legacy marker exceeds the V8"
- `packages/remnic-cli/src/index.ts:8794` — "// string ceiling. Fetch them chunk-wise into a private, secure-store-bound"
- `packages/remnic-cli/src/index.ts:8795` — "// staging root instead, and let the atomic generation transaction consume"
- `packages/remnic-cli/src/index.ts:8796` — "// the staged bytes via core's readIncomingFile apply callback. Live"
- `packages/remnic-cli/src/index.ts:8797` — "// marker/shard paths are only ever touched by the transaction."
- `packages/remnic-cli/src/index.ts:8814` — "// A staging failure after a successful push must still checkpoint the"
- `packages/remnic-cli/src/index.ts:8815` — "// advanced base — the same contract as direct-hydration failures below."
- `packages/remnic-cli/src/index.ts:9153` — "// Metadata-only pull (#3148 P1): a near-512MiB legacy marker cannot ride"
- `packages/remnic-cli/src/index.ts:9154` — "// the inline base64 snapshot content, so prepare fills content exactly"
- `packages/remnic-cli/src/index.ts:9155` — "// like sync — small files via base64 batches, oversized generation"
- `packages/remnic-cli/src/index.ts:9156` — "// members chunk-wise into a private staging root consumed by the atomic"
- `packages/remnic-cli/src/index.ts:9157` — "// generation transaction."
- `packages/remnic-cli/src/index.ts:9312` — "// Fold durable pending impression/lifecycle spills before summarizing so"
- `packages/remnic-cli/src/index.ts:9313` — "// `status` reports the same pending set a following `sync` would push"
- `packages/remnic-cli/src/index.ts:9314` — "// (#2033). runOfflineSyncOnce drains these queues before every snapshot; a"
- `packages/remnic-cli/src/index.ts:9315` — "// status that skipped them would undercount. A deferred/failed drain aborts"
- `packages/remnic-cli/src/index.ts:9316` — "// here for the same reason sync aborts — an accurate count beats a silent"
- `packages/remnic-cli/src/index.ts:9317` — "// undercount."
- `packages/remnic-cli/src/index.ts:12636` — "// Ensure parent directory exists before writing. Use atomic rename to"
- `packages/remnic-cli/src/index.ts:12637` — "// avoid partial-write corruption (CLAUDE.md #54: never delete before"
- `packages/remnic-cli/src/index.ts:12638` — "// successful write)."
