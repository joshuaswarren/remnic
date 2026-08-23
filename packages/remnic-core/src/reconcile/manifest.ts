import { createHash } from "node:crypto";
import { computeLegacyContentHash, normalizeLegacyContent } from "../content-hash.js";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { DEFAULT_CITATION_FORMAT, stripCitationForTemplate } from "../source-attribution.js";
import { ContentHashIndex, type ContentHashPathEntry } from "../storage/content-hash-index.js";
import { storedContentIdentityCandidates } from "../structured-attributes.js";
import type { MemoryFrontmatter, MemoryStatus } from "../types.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import {
  type ReconcileFileState,
  type ReconcilePlan,
  type ReconcilePlanEntry,
  type ReconcileSemanticAgreement,
  type ReconcileSemanticChange,
  compareReconcilePlanEntries,
  semanticAgreementKey,
  summarizeReconcilePlan,
} from "./plan.js";

export const RECONCILE_MANIFEST_FORMAT = "remnic-reconcile-manifest";
export const RECONCILE_MANIFEST_SCHEMA_VERSION = 1;
export const CONTENT_HASH_NORMALIZER_VERSION = 4;
/**
 * Version of the identity-resolution LOGIC (alias recovery, candidate
 * ordering), independent of the content normalizer: a cached manifest entry
 * written before an identity-resolution change carries an older value and is
 * reparsed even when its normalizerVersion still matches (issue #2367
 * review round 2). Bump when parsedMemoryIdentity's output shape or
 * semantics change.
 */
export const IDENTITY_RESOLUTION_VERSION = 2;

export interface ReconcileMemoryIdentity {
  id: string;
  category: string;
  contentHash: string;
  /**
   * Recovered current-normalizer identities for a record whose persisted hash
   * is ambiguous under the legacy normalizer (issue #2367). The persisted
   * hash stays primary; these participate in duplicate bucketing so a
   * replica carrying the current form of the same fact still collapses.
   */
  contentHashAliases?: readonly string[];
  /** See IDENTITY_RESOLUTION_VERSION; absent on pre-versioning cache entries. */
  normalizerVersion?: number;
  identityResolutionVersion?: number;
  status: MemoryStatus;
}

export interface ReconcileManifestFile extends ReconcileFileState {
  memory?: ReconcileMemoryIdentity;
}

type ActiveFactManifestFile = ReconcileManifestFile & { memory: ReconcileMemoryIdentity };

export interface ReconcileManifest {
  format: typeof RECONCILE_MANIFEST_FORMAT;
  schemaVersion: typeof RECONCILE_MANIFEST_SCHEMA_VERSION;
  files: ReconcileManifestFile[];
}

export type ReconcileMemoryParser = (raw: string) => { frontmatter: MemoryFrontmatter; content: string } | null;

export interface BuildReconcileManifestOptions {
  files: Iterable<ReconcileFileState>;
  readFile: (file: ReconcileFileState) => Promise<Buffer | string | null>;
  parseMemory: ReconcileMemoryParser;
  cachedFiles?: Iterable<ReconcileManifestFile>;
  citationTemplate?: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MEMORY_DIRS = new Set(RECALL_FALLBACK_DIRS);

function isMemoryPath(filePath: string): boolean {
  if (!filePath.endsWith(".md")) return false;
  const segments = filePath.split("/");
  let index = 0;
  if (segments[index] === "cold" || segments[index] === "archive") index += 1;
  return MEMORY_DIRS.has(segments[index] ?? "");
}

function parsedMemoryIdentity(
  filePath: string,
  raw: Buffer | string,
  parseMemory: ReconcileMemoryParser,
  citationTemplate: string
): ReconcileMemoryIdentity | undefined {
  if (!isMemoryPath(filePath)) return undefined;
  const parsed = parseMemory(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  if (!parsed?.frontmatter.id) return undefined;

  const storedHash =
    parsed.frontmatter.contentHash && SHA256_PATTERN.test(parsed.frontmatter.contentHash)
      ? parsed.frontmatter.contentHash.toLowerCase()
      : undefined;
  const candidates = storedContentIdentityCandidates(parsed.content, (content) =>
    stripCitationForTemplate(content, citationTemplate)
  );
  const bodyHash = ContentHashIndex.computeHash(candidates[0] ?? "");
  const currentMatch = candidates.find((content) => ContentHashIndex.computeHash(content) === storedHash);
  const legacyMatch = [...candidates].reverse().find((content) => computeLegacyContentHash(content) === storedHash);
  let contentHash: string;
  let contentHashAliases: string[] | undefined;
  if (currentMatch) {
    contentHash = ContentHashIndex.computeHash(currentMatch);
  } else if (legacyMatch && normalizeLegacyContent(legacyMatch).length > 0) {
    // A non-empty legacy equality is ambiguous (issue #2367): the persisted
    // hash may be an explicit contentHashSource identity that merely collides
    // with the body's ASCII skeleton under the lossy legacy normalizer, and
    // nothing in the record proves which it is. Keep the persisted hash as
    // the primary identity and expose the recovered current identity as an
    // alias so replicas carrying either form still collapse.
    contentHash = storedHash ?? bodyHash;
    const recovered = ContentHashIndex.computeHash(legacyMatch);
    if (recovered !== contentHash) contentHashAliases = [recovered];
  } else {
    // An EMPTY legacy skeleton identifies nothing (every non-ASCII body maps
    // to it), so preserving it would collapse unrelated records. Recovering
    // the current identity here is repair, not replacement.
    contentHash = legacyMatch ? ContentHashIndex.computeHash(legacyMatch) : (storedHash ?? bodyHash);
  }

  return {
    id: parsed.frontmatter.id,
    category: parsed.frontmatter.category,
    contentHash,
    ...(contentHashAliases ? { contentHashAliases } : {}),
    normalizerVersion: CONTENT_HASH_NORMALIZER_VERSION,
    identityResolutionVersion: IDENTITY_RESOLUTION_VERSION,
    status: inferMemoryStatus(parsed.frontmatter, filePath),
  };
}

/**
 * Stable fingerprint of the citation template that `parsedMemoryIdentity` uses
 * to strip inline attribution before hashing. A persisted identity cache is
 * only reusable while this matches: identical file content under a different
 * template yields a different `contentHash`, which would silently change
 * duplicate and conflict decisions on a warm plan.
 */
export function citationTemplateFingerprint(citationTemplate?: string): string {
  return createHash("sha256")
    .update(citationTemplate ?? DEFAULT_CITATION_FORMAT)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Structural guard for identities read back from an on-disk cache. A cache file
 * is untrusted JSON: without this an entry carrying `memory: null` survives the
 * loader's cast and then throws when the hit path dereferences
 * `memory.normalizerVersion`, aborting a manifest build that should instead
 * fall back to a cold parse.
 */
export function isReconcileMemoryIdentity(value: unknown): value is ReconcileMemoryIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const memory = value as Record<string, unknown>;
  if (typeof memory.id !== "string") return false;
  if (typeof memory.category !== "string") return false;
  if (typeof memory.contentHash !== "string") return false;
  if (typeof memory.status !== "string") return false;
  if (memory.normalizerVersion !== undefined && typeof memory.normalizerVersion !== "number") return false;
  if (memory.identityResolutionVersion !== undefined && typeof memory.identityResolutionVersion !== "number") {
    return false;
  }
  if (
    memory.contentHashAliases !== undefined &&
    (!Array.isArray(memory.contentHashAliases) || memory.contentHashAliases.some((alias) => typeof alias !== "string"))
  ) {
    return false;
  }
  return true;
}

export async function buildReconcileManifestFile(
  file: ReconcileFileState,
  readFile: (file: ReconcileFileState) => Promise<Buffer | string | null>,
  parseMemory: ReconcileMemoryParser,
  citationTemplate = DEFAULT_CITATION_FORMAT
): Promise<ReconcileManifestFile> {
  let raw: Buffer | string | null = null;
  if (isMemoryPath(file.path)) {
    try {
      raw = await readFile(file);
    } catch {
      raw = null;
    }
  }
  if (raw !== null && createHash("sha256").update(raw).digest("hex") !== file.sha256.toLowerCase()) {
    raw = null;
  }
  const memory = raw === null ? undefined : parsedMemoryIdentity(file.path, raw, parseMemory, citationTemplate);
  return { ...file, ...(memory ? { memory } : {}) };
}

/** Read-batch size for manifest builds. Uncached files are independent (a
 * per-file read + sha256 + frontmatter parse); processing them in bounded
 * batches amortizes the per-file promise/async-hook overhead that dominates
 * boot-scale corpus builds (measured: ~66% of CPU in async_hooks._propagate +
 * GC at ~100k files) and overlaps IO waits, while the bound keeps memory flat.
 * Order is preserved: results land in input order regardless of completion
 * order, so the manifest output is byte-identical to the sequential form. */
const MANIFEST_BUILD_BATCH_SIZE = 50;

export async function buildReconcileManifest(options: BuildReconcileManifestOptions): Promise<ReconcileManifest> {
  const cachedByPath = new Map<string, ReconcileManifestFile>();
  for (const cached of options.cachedFiles ?? []) {
    cachedByPath.set(cached.path, cached);
  }

  const files: ReconcileManifestFile[] = [];
  // Cache hits stay on a synchronous fast path (no promise allocation, no
  // Promise.all — a fully-cached rebuild must not regress); only the uncached
  // entries ride the bounded batches. Order is preserved by index.
  const uncached: Array<{ index: number; file: ReconcileFileState }> = [];
  const allFiles = [...options.files];
  for (let i = 0; i < allFiles.length; i += 1) {
    const file = allFiles[i]!;
    const cached = cachedByPath.get(file.path);
    if (
      cached !== undefined &&
      cached.sha256.toLowerCase() === file.sha256.toLowerCase() &&
      (cached.memory === undefined ||
        (cached.memory.normalizerVersion === CONTENT_HASH_NORMALIZER_VERSION &&
          cached.memory.identityResolutionVersion === IDENTITY_RESOLUTION_VERSION))
    ) {
      files.push({ ...file, ...(cached.memory ? { memory: cached.memory } : {}) });
    } else {
      uncached.push({ index: i, file });
    }
  }
  for (let i = 0; i < uncached.length; i += MANIFEST_BUILD_BATCH_SIZE) {
    const batch = uncached.slice(i, i + MANIFEST_BUILD_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(({ file }) =>
        buildReconcileManifestFile(file, options.readFile, options.parseMemory, options.citationTemplate)
      )
    );
    for (let j = 0; j < batch.length; j += 1) {
      files[batch[j]!.index] = results[j]!;
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    format: RECONCILE_MANIFEST_FORMAT,
    schemaVersion: RECONCILE_MANIFEST_SCHEMA_VERSION,
    files,
  };
}

function activeFactByPath(manifest: ReconcileManifest | undefined): Map<string, ActiveFactManifestFile> {
  const result = new Map<string, ActiveFactManifestFile>();
  for (const file of manifest?.files ?? []) {
    if (file.memory?.category === "fact" && file.memory.status === "active") {
      result.set(file.path, file as ActiveFactManifestFile);
    }
  }
  return result;
}

function memoryIdentityHashes(memory: ReconcileMemoryIdentity): string[] {
  return [memory.contentHash, ...(memory.contentHashAliases ?? [])];
}

function contentHashRows(files: Iterable<ActiveFactManifestFile>, contentHash: string): ContentHashPathEntry[] {
  const rows: ContentHashPathEntry[] = [];
  for (const file of files) {
    rows.push({ path: file.path, contentHash });
  }
  return rows;
}

function classifySemanticChange(
  current: ReconcileSemanticAgreement,
  prior: ReconcileSemanticAgreement | undefined
): ReconcileSemanticChange {
  if (!prior) return "unchanged";
  const localChanged = current.local.sha256 !== prior.local.sha256;
  const peerChanged = current.peer.sha256 !== prior.peer.sha256;
  if (localChanged && peerChanged) return "both_modified";
  if (localChanged) return "local_changed";
  if (peerChanged) return "peer_changed";
  return "unchanged";
}

export function collapseActiveFactDuplicates(
  plan: ReconcilePlan,
  localManifests: ReadonlyMap<string, ReconcileManifest>,
  peerManifests: ReadonlyMap<string, ReconcileManifest>,
  priorSemanticAgreements?: ReadonlyMap<string, readonly ReconcileSemanticAgreement[]>
): ReconcilePlan {
  const entriesByNamespace = new Map<string, ReconcilePlanEntry[]>();
  for (const entry of plan.entries) {
    const entries = entriesByNamespace.get(entry.namespace) ?? [];
    entries.push({ ...entry });
    entriesByNamespace.set(entry.namespace, entries);
  }

  let changed = false;
  for (const namespace of new Set([...localManifests.keys(), ...peerManifests.keys()])) {
    const entries = entriesByNamespace.get(namespace) ?? [];
    const localManifest = localManifests.get(namespace);
    const peerManifest = peerManifests.get(namespace);
    const localByPath = activeFactByPath(localManifest);
    const peerByPath = activeFactByPath(peerManifest);
    const localFilesByPath = new Map((localManifest?.files ?? []).map((file) => [file.path, file]));
    const peerFilesByPath = new Map((peerManifest?.files ?? []).map((file) => [file.path, file]));
    const priorSemanticByPathPair = new Map(
      (priorSemanticAgreements?.get(namespace) ?? []).map((agreement) => [semanticAgreementKey(agreement), agreement])
    );
    const localByHash = new Map<string, ActiveFactManifestFile[]>();
    const peerByHash = new Map<string, ActiveFactManifestFile[]>();

    for (const file of localByPath.values()) {
      for (const hash of memoryIdentityHashes(file.memory)) {
        const bucket = localByHash.get(hash) ?? [];
        bucket.push(file);
        localByHash.set(hash, bucket);
      }
    }
    for (const file of peerByPath.values()) {
      for (const hash of memoryIdentityHashes(file.memory)) {
        const bucket = peerByHash.get(hash) ?? [];
        bucket.push(file);
        peerByHash.set(hash, bucket);
      }
    }

    const removed = new Set<ReconcilePlanEntry>();
    const replacements: ReconcilePlanEntry[] = [];
    const processedPathPairs = new Set<string>();
    for (const hash of new Set([...localByHash.keys(), ...peerByHash.keys()])) {
      const localCandidates = (localByHash.get(hash) ?? []).filter((file) => {
        const opposite = peerFilesByPath.get(file.path);
        const activeOpposite = peerByPath.get(file.path);
        return (
          opposite === undefined ||
          (activeOpposite !== undefined && memoryIdentityHashes(activeOpposite.memory).includes(hash))
        );
      });
      const peerCandidates = (peerByHash.get(hash) ?? []).filter((file) => {
        const opposite = localFilesByPath.get(file.path);
        const activeOpposite = localByPath.get(file.path);
        return (
          opposite === undefined ||
          (activeOpposite !== undefined && memoryIdentityHashes(activeOpposite.memory).includes(hash))
        );
      });
      const localPath = ContentHashIndex.resolvePathByHash(hash, contentHashRows(localCandidates, hash));
      const peerPath = ContentHashIndex.resolvePathByHash(hash, contentHashRows(peerCandidates, hash));

      if (localPath && peerPath && localPath !== peerPath) {
        const pathPair = `${localPath}\0${peerPath}`;
        if (processedPathPairs.has(pathPair)) continue;
        processedPathPairs.add(pathPair);
        const localFile = localByPath.get(localPath);
        const peerFile = peerByPath.get(peerPath);
        if (!localFile || !peerFile) continue;
        const duplicatePaths = new Set([
          ...localCandidates.map((file) => file.path),
          ...peerCandidates.map((file) => file.path),
        ]);
        const authoritativeSamePathEntries = new Set(
          entries.filter(
            (entry) =>
              duplicatePaths.has(entry.path) &&
              localFilesByPath.has(entry.path) &&
              peerFilesByPath.has(entry.path) &&
              entry.action !== "identical"
          )
        );
        if (authoritativeSamePathEntries.size > 0) {
          for (const entry of entries) {
            if (
              duplicatePaths.has(entry.path) &&
              !authoritativeSamePathEntries.has(entry) &&
              (entry.action === "pull" || entry.action === "push" || entry.action === "identical")
            ) {
              removed.add(entry);
              changed = true;
            }
          }
          continue;
        }
        const unsafeEntry = entries.some(
          (entry) => duplicatePaths.has(entry.path) && (entry.action === "suppress" || entry.action === "conflict")
        );
        if (unsafeEntry) continue;
        for (const entry of entries) {
          if (
            duplicatePaths.has(entry.path) &&
            (entry.action === "pull" || entry.action === "push" || entry.action === "identical")
          ) {
            removed.add(entry);
          }
        }
        const semanticAgreement: ReconcileSemanticAgreement = {
          local: { path: localPath, sha256: localFile.sha256 },
          peer: { path: peerPath, sha256: peerFile.sha256 },
        };
        replacements.push({
          path: localPath < peerPath ? localPath : peerPath,
          namespace,
          action: "identical",
          reason: "semantic_duplicate",
          semanticAgreement,
          semanticChange: classifySemanticChange(
            semanticAgreement,
            priorSemanticByPathPair.get(semanticAgreementKey(semanticAgreement))
          ),
        });
        changed = true;
        continue;
      }

      const sameSideEntries = entries.filter((entry) => {
        if (localPath && entry.reason === "local_only") {
          return localCandidates.some((file) => file.path === entry.path);
        }
        if (peerPath && entry.reason === "peer_only") {
          return peerCandidates.some((file) => file.path === entry.path);
        }
        return false;
      });
      const canonicalPath = localPath ?? peerPath;
      const hasSharedCanonical = localPath !== undefined && localPath === peerPath;
      if (!canonicalPath || sameSideEntries.length === 0 || (!hasSharedCanonical && sameSideEntries.length < 2)) {
        continue;
      }
      for (const entry of sameSideEntries) {
        if (entry.path !== canonicalPath) {
          removed.add(entry);
          changed = true;
        }
      }
    }

    if (removed.size > 0 || replacements.length > 0) {
      entriesByNamespace.set(
        namespace,
        [...entries.filter((entry) => !removed.has(entry)), ...replacements].sort(compareReconcilePlanEntries)
      );
    }
  }

  if (!changed) return plan;
  const entries = [...entriesByNamespace.values()].flat().sort(compareReconcilePlanEntries);
  return {
    entries,
    byNamespace: summarizeReconcilePlan(entries),
    converged: entries.every((entry) => entry.action === "identical"),
  };
}
