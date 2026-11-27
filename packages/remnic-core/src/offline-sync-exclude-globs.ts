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
  "**/state/*.sqlite",
  "**/state/*.sqlite-*",
  "**/state/index_tags.json",
  "**/state/entity-mention-index.json",
  "**/state/memory-governance/runs/**",
  "**/state/recall_impressions.jsonl.*",
  "**/state/recall_impressions.jsonl.pending.d/**",
  "**/state/memory-lifecycle-ledger.jsonl.pending.d/**",
  "**/state/memory-lifecycle-ledger.jsonl.lock",
  "**/.remnic-offline-decrypt-*/**",
  "**/state/embeddings.pre-replace.tmp/**",
  "**/state/embeddings.staging.tmp-*/**",
  "**/state/embeddings.json.pre-migration.tmp-*",
  "**/namespaces/*/state/embeddings.pre-replace.tmp/**",
  "**/namespaces/*/state/embeddings.staging.tmp-*/**",
  "**/namespaces/*/state/embeddings.json.pre-migration.tmp-*",
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
  return /(?:^|\/)state\/embeddings\.generation$/i.test(normalized);
}

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
  compileOfflineSyncExcludeGlobs(globs);
  return globs;
}
