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
  // Embedding-index transaction leftovers (issue #3146, PR #3148). The
  // identity-replacement backup (`embeddings.pre-replace.tmp`) can hold a
  // full obsolete generation and `embeddings.staging.tmp-*` holds a
  // partially staged one; both are node-local recovery state that must
  // never be enumerated into a snapshot. The demoted legacy recovery file
  // (`embeddings.json.pre-migration.tmp-*`) is likewise node-local.
  "**/state/embeddings.pre-replace.tmp/**",
  "**/state/embeddings.staging.tmp-*/**",
  "**/state/embeddings.json.pre-migration.tmp-*",
  "**/namespaces/*/state/embeddings.pre-replace.tmp/**",
  "**/namespaces/*/state/embeddings.staging.tmp-*/**",
  "**/namespaces/*/state/embeddings.json.pre-migration.tmp-*",
  // The warm-cache generation marker (PR #3176) is node-local coherence
  // state: a synced copy — worse, a captured `in-flight` value — would make
  // the receiving node's stamp probes unique forever and force a full index
  // reload on every search. Exclude on both sides: never snapshotted, and
  // an incoming (old or hostile) marker never overwrites or deletes the
  // local one.
  "**/state/embeddings.generation",
  "**/namespaces/*/state/embeddings.generation",
];


const DEFAULT_OFFLINE_SYNC_EXCLUDE_REGEXPS: readonly RegExp[] =
  DEFAULT_OFFLINE_SYNC_EXCLUDE_GLOBS.map((glob) => globToRegExp(glob));

/**
 * The warm-cache generation marker is the one default-excluded path that
 * must ALSO be refused on apply (push-side default excludes like the live
 * LCM sqlite are deliberately apply-accepted for first-sync bootstrapping).
 * Node-local on both sides: never snapshotted, never overwritten by an
 * incoming old or hostile copy.
 */
export function isEmbeddingGenerationMarkerPath(relPosix: string): boolean {
  const normalized = relPosix.includes("\\") ? relPosix.replaceAll("\\", "/") : relPosix;
  // Case-insensitive: on APFS/NTFS a differently cased path resolves to the
  // same file, so `state/Embeddings.Generation` must be refused like the
  // canonical spelling.
  return /(?:^|\/)state\/embeddings\.generation$/i.test(normalized);
}

/**
 * Precompiled-once default-exclude check for the snapshot enumeration hot
 * path (Kilo review, PR #1793). Moved here from offline-sync.ts with the
 * glob list so the two can never drift (issue #1995).
 */
export function matchesOfflineSyncDefaultExclude(relPosix: string): boolean {
  for (const regexp of DEFAULT_OFFLINE_SYNC_EXCLUDE_REGEXPS) {
    if (regexp.test(relPosix)) return true;
  }
  return false;
}

export function globToRegExp(glob: string): RegExp {
  if (typeof glob !== "string" || glob.length === 0) {
    throw new Error("offlineSyncExcludes entry must be a non-empty string");
  }
  if (glob.includes("\0")) {
    throw new Error("offlineSyncExcludes entry must not contain NUL bytes");
  }
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` is cross-segment wherever it appears:
        //   leading `**/`  -> zero or more whole segments
        //   `/**` at end   -> everything under the directory
        //   `a/**/b`       -> any depth between segments
        // (Cursor review on PR #1793: trailing `scratch/**` must match
        // nested `scratch/a/b.md`, matching the offline-mode guide.)
        if (glob[i + 2] === "/") {
          source += "(?:[\\s\\S]*/)?";
          i += 2;
          continue;
        }
        source += "[\\s\\S]*";
        i += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    if (ch === "/") {
      source += "/";
      continue;
    }
    source += ch.replace(/[\\^$.+()|{}\[\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Match relative POSIX paths: `*` stays within a segment; `**` crosses separators and matches every path alone. */
export function compileOfflineSyncExcludeGlobs(
  globs: readonly unknown[],
): RegExp[] {
  const out: RegExp[] = [];
  for (const entry of globs) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("offlineSyncExcludes must contain only non-empty strings");
    }
    out.push(globToRegExp(entry));
  }
  return out;
}

/**
 * Validate the operator-supplied offline-sync exclude list (#1786).
 * Rejects loudly instead of silently defaulting (CLAUDE.md rule 39):
 * a misspelled key value must fail config parse, not be ignored.
 * Lives next to the glob compiler so config.ts only carries the call.
 */
export function parseOfflineSyncExcludes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `offlineSyncExcludes must be an array of non-empty glob strings; got ${typeof raw}`,
    );
  }
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        "offlineSyncExcludes must contain only non-empty glob strings",
      );
    }
  }
  const globs = raw.map((entry) => (entry as string).trim());
  // Compile-check every glob now so a bad pattern fails at parse time
  // rather than mid-sync. compileOfflineSyncExcludeGlobs throws with a
  // per-entry message.
  compileOfflineSyncExcludeGlobs(globs);
  return globs;
}
