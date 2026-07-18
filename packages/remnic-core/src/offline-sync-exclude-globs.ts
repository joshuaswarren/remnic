// Issue #1786: node-local runtime state that each node rebuilds from synced
// records. Pushing these wastes bandwidth, corrupts the remote's live state
// dir, and trips the large-file push retry loop on a live SQLite database.
// Extracted from offline-sync.ts (issue #1995) so the god-file line-count
// ratchet does not grow when the list gains entries; behavior is unchanged.
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
  // archives are node-local and never pushed/hashed.
  "**/state/recall_impressions.jsonl.*",
];
