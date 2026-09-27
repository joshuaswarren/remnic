// Runtime-state generation rules for offline sync (issue #1786, #3146).
// Extracted from offline-sync.ts so the god-file line-count ratchet does not
// grow when the rules gain entries; behavior is unchanged.

export const EMBEDDING_SHARD_FILE_PATTERN = /^shard-\d{4}\.json$/;

export function isCanonicalRuntimeStatePath(parts: string[]): boolean {
  if (parts[0] === "state") return true;
  return parts[0] === "namespaces" && parts.length >= 4 && parts[2] === "state";
}

const REMOTE_AUTHORITATIVE_RUNTIME_STATE_FILES = new Set([
  ".artifact-write-version.log",
  ".memory-status-version.log",
  "buffer.json",
  "embeddings.json",
  "index_time.json",
  "last_intent.json",
  "last_qmd_recall.json",
  "last_recall.json",
  "lcm.sqlite-shm",
  "lcm.sqlite-wal",
  "memory-lifecycle-ledger.jsonl",
  "recall_impressions.jsonl",
]);

const ABSENT_INCOMING_RUNTIME_DELETE_FILES = new Set([
  "lcm.sqlite-shm",
  "lcm.sqlite-wal",
]);

// Sharded embedding index (#3146): remote-authoritative like embeddings.json.
function isRemoteAuthoritativeRuntimeShard(basename: string, parts: string[]): boolean {
  return EMBEDDING_SHARD_FILE_PATTERN.test(basename) && parts[parts.length - 2] === "embeddings";
}

export function shouldPreferIncomingOfflineRuntimeFile(relPosix: string): boolean {
  const parts = relPosix.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return isCanonicalRuntimeStatePath(parts) &&
    (REMOTE_AUTHORITATIVE_RUNTIME_STATE_FILES.has(basename) || isRemoteAuthoritativeRuntimeShard(basename, parts));
}

export function shouldDeleteAbsentIncomingOfflineRuntimeFile(relPosix: string): boolean {
  const parts = relPosix.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return isCanonicalRuntimeStatePath(parts) && ABSENT_INCOMING_RUNTIME_DELETE_FILES.has(basename);
}
