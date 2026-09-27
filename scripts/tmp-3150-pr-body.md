Fixes #3150

## Problem

`applyOfflineSyncChangeset` wrote changeset records one-by-one. A sharded embedding generation carried by an inline changeset could span apply requests (the sender chunker split changes per request purely by byte budget), exposing a mixed generation or leaving a partial update behind on a mid-apply failure. The snapshot apply has been atomic since #3148; the changeset path had none of that machinery.

Verified premise correction: node→daemon changeset builders push-filter runtime state (#1786), so the CLI's own builder never emits shard changes — but the daemon apply surface accepts shard-bearing changesets from other senders (namespace replication, migrations, API clients), and that is where the one-by-one hazard was real. This PR fixes the receiver contract and hardens the sender tooling for any changeset that does carry generation members.

## Receiver: atomic generation application

- New optional changeset field `embeddingGenerations`: complete post-change membership (`{ shardDir, members: [{ path, sha256, bytes }] }`) for every generation the changeset touches. Inline changesets are diffs, so the manifest is what lets the receiver assemble a COMPLETE generation: changed shards ride inline; unchanged shards carry over from local bytes hash-verified against the manifest under the generation lock; removed shards are swept by the swap.
- Generation changes now route through the shared locked atomic transaction (`applyEmbeddingGenerationTransaction`) — stage, verify staged bytes, single backup-swap publish — exactly like the snapshot path.
- Delete semantics: a manifest with deletes shrinks the generation through the same swap; a manifest-less tombstone set that covers EVERY local member removes the whole generation atomically (`applyEmbeddingGenerationRemoval`); incomplete manifest-less deletion evidence defers the whole dir as conflicts — the complete published generation survives and is never broken apart by independent shard deletes. Only non-generation files keep per-file deletes.
- Deferrals are CONFLICTS, never silent skips: `embedding_generation_manifest_required` (legacy sender, shard upserts without a manifest) and `embedding_generation_diverged` (under-lock census divergence: concurrent daemon rewrite, remote-only member). The push side therefore cannot checkpoint a deferred generation as applied.
- Fail-closed staging rule mirrored from the snapshot apply: custom storage IO without both `writeStagingFile`/`readStagingFile` refuses generation changesets before any publication (no plaintext-downgrade of staged generations). The daemon's support-passport storage wiring now passes the staging pair.

## Sender: generation-coherent batching

`chunkOfflineChangesetApplyBatches` groups all changes of one embedding generation into ONE request (never split), trims each request's manifest to the generations it actually carries, and counts manifest bytes in the budget. An over-budget generation now fails closed BEFORE any request with an honest message naming the staged-chunk-transport policy — replacing the old "retry after direct-push threshold is lowered" advice, which was wrong for generation members (they are excluded from direct push by design).

## >8MiB generations: explicit fail-closed policy (design, not implemented)

A generation whose request encoding exceeds `OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES` cannot ride an inline changeset and is NOT uploaded file-by-file to final paths (that would defeat generation atomicity). The push fails closed with the policy in the error message. The designed follow-up transport (pull side already has one in `offline-generation-staging.ts`): chunk-upload members into a receiver-private secure staging root AAD-bound to their final paths, then a finalize call that consumes the staged bytes through the same atomic generation swap. Not implemented here; oversized generations currently require shrinking the index below the request budget.

## Test evidence

- New `packages/remnic-core/src/offline-sync-changeset-generations.test.ts` (17 tests): atomic apply with carry-over, manifest shrink, whole-generation tombstone removal, manifest-less partial deletion defers as conflicts with the complete generation preserved byte-for-byte, legacy deferral as conflicts, cross-layout marker migration, divergence and remote-only-member deferrals, staging fail-closed, mid-stage crash leaves bytes identical, idempotent re-apply, concurrent applies serialize into one complete generation, manifest builder (complete membership + filter-to-omit), builder push-filter regression, normalize rejection matrix, end-to-end sender→receiver census equality.
- `tests/offline-sync-cli-batching.test.ts`: generation-coherent batching and over-budget fail-closed cases (33 existing tests unchanged).
- Regression preservation: `offline-sync.test.ts` 77/77, `offline-sync-embedding-generation.test.ts` 55/55 (snapshot extraction is behavior-preserving), `access-http.test.ts` 101/101, workspace `check-test-types` OK, `check:pre-push` green.
