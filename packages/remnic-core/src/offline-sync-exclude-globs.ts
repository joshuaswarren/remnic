// Issue #1786: node-local runtime state that each node rebuilds from synced
// records. Pushing these wastes bandwidth, corrupts the remote's live state
// dir, and trips the large-file push retry loop on a live SQLite database.
// Extracted from offline-sync.ts (issue #1995) so the god-file line-count
// ratchet does not grow when the list gains entries; behavior is unchanged.
/**
 * Directory-name prefix for the transient plaintext staging dir the CLI offline
 * decrypt path (`offline-storage-io.ts`) creates under the memory root when it
 * must materialize a decrypted secure-store file before hashing/pushing (#2033
 * P1). Shared here so the hard-exclude glob below and the CLI's `mkdtemp` prefix
 * can never drift apart: a crash-orphaned staging dir must NEVER be enumerated
 * into an offline snapshot, or decrypted secure-store plaintext would leak into
 * the remote push.
 */
export const OFFLINE_DECRYPT_STAGING_DIR_PREFIX = ".remnic-offline-decrypt-";

export const DEFAULT_OFFLINE_SYNC_EXCLUDE_GLOBS: readonly string[] = [
  // Leading `**/` matches zero or more segments, so each pattern covers both
  // the root `state/` dir AND per-namespace `namespaces/<ns>/state/` dirs
  // (Cursor review on PR #1793: multi-namespace deployments previously kept
  // pushing their namespaced live sqlite files).
  "**/state/*.sqlite",
  "**/state/*.sqlite-*",
  "**/state/index_tags.json",
  "**/state/entity-mention-index.json",
  "**/state/memory-governance/runs/**",
  // Rotated recall-impression archives (issue #1910). The active
  // recall_impressions.jsonl stays remote-authoritative; only the .1..N
  // archives and the .lock are node-local and never pushed/hashed.
  "**/state/recall_impressions.jsonl.*",
  // Durable recall-impression pending spill directory (issue #2033). Node-local:
  // an impression spills a per-event file here when its rotation lock cannot be
  // acquired, and the next lock holder folds them back into the synced active
  // recall_impressions.jsonl. The `.*` glob above matches the directory name but
  // not its children, so exclude the contents explicitly.
  "**/state/recall_impressions.jsonl.pending.d/**",
  // Durable lifecycle-append pending spill directory (issue #2033). Node-local:
  // an append spills a per-event file here when it cannot get the ledger lock,
  // and the next lock holder folds them back into the synced
  // memory-lifecycle-ledger.jsonl. Pushing them would duplicate rows remotely.
  // The offline-sync snapshot entrypoints drain this queue first (access-service
  // `drainPendingLifecycleForSync` -> `StorageManager.drainPendingMemoryLifecycleEventsForSync`),
  // aborting the snapshot when durable rows cannot be folded, so excluding the
  // dir never silently drops append-only lifecycle history (promotions/imports).
  "**/state/memory-lifecycle-ledger.jsonl.pending.d/**",
  // The active lifecycle ledger lock is node-local and must never be
  // transferred to another node during an offline snapshot.
  "**/state/memory-lifecycle-ledger.jsonl.lock",
  // Transient plaintext decrypt staging (issue #2033 P1). The CLI offline
  // decrypt path materializes a decrypted secure-store file under an owner-only
  // `<OFFLINE_DECRYPT_STAGING_DIR_PREFIX>*` dir before hashing/pushing, removing
  // it in a `finally`. A hard crash between create and cleanup would otherwise
  // let a later snapshot walk `<prefix>*/content` and push decrypted secure-store
  // plaintext to the remote. Exclude the dir and its contents unconditionally so
  // a crash-orphan can never be enumerated into a snapshot; the leading `**/`
  // matches the root-level dir (zero segments) and any nested placement.
  "**/.remnic-offline-decrypt-*/**",
];
