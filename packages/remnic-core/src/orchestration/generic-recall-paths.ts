import path from "node:path";
import type { QmdSearchResult } from "../types.js";
import { isExternalWikiCollectionName } from "../external-wiki-guard.js";
export { isExternalWikiCollectionName } from "../external-wiki-guard.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";
import {
  isActivityDigestPath,
  isArtifactMemoryPath,
  isLocationDayPath,
  isMeetingRecordPath,
} from "./orchestrator-helpers.js";
import { isJournalDayPath } from "../activity/journal.js";
import { DIRECTORY_SIDECAR_BASENAME } from "../directory-sidecars.js";
import { OKF_RESERVED_BASENAMES } from "../okf/type-mapping.js";


export interface GenericRecallPathPolicy {
  readonly memoryDir?: string;
  readonly qmdCollection?: string;
  readonly qmdColdCollection?: string;
  /**
   * The collection THIS request named, when it named one. A caller may select
   * a custom collection whose name is also a memory category, which the
   * configured names alone cannot disambiguate.
   */
  readonly requestedCollection?: string;
}

type GenericRecallPathSource = "filesystem" | "qmd";

const CATEGORY_MEMORY_ROOTS: Record<string, true> = Object.fromEntries(
  ALL_CATEGORY_DIRS.map((directory) => [directory, true]),
);
const RESERVED_ARCHIVE_ROOTS: Record<string, true> = { archive: true, namespaces: true };

function isQmdCollectionPrefix(
  prefix: string,
  collection: string | undefined,
  source: GenericRecallPathSource,
): boolean {
  if (typeof collection !== "string" || collection.length === 0) return false;
  if (prefix.startsWith(`${collection}--`)) return true;
  if (prefix !== collection) return false;
  if (source === "qmd") return true;
  return (
    !Object.hasOwn(CATEGORY_MEMORY_ROOTS, prefix) &&
    !Object.hasOwn(RESERVED_ARCHIVE_ROOTS, prefix)
  );
}

function normalizeQmdUriPath(relativePath: string, source: GenericRecallPathSource): string {
  if (source !== "qmd" || !relativePath.startsWith("qmd://")) return relativePath;
  try {
    const parsed = new URL(relativePath);
    if (parsed.protocol !== "qmd:" || !parsed.hostname) return relativePath;
    const collection = decodeURIComponent(parsed.hostname);
    const pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    return pathname ? `${collection}/${pathname}` : collection;
  } catch {
    return relativePath;
  }
}

function stripQmdCollectionPrefix(
  relativePath: string,
  policy: GenericRecallPathPolicy,
  source: GenericRecallPathSource,
): string {
  const normalized = path.posix.normalize(normalizeQmdUriPath(relativePath, source).replace(/\\/g, "/"));
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return normalized;

  const prefix = normalized.slice(0, slashIndex);
  const matchesHotCollection = isQmdCollectionPrefix(prefix, policy.qmdCollection, source);
  const matchesColdCollection = isQmdCollectionPrefix(prefix, policy.qmdColdCollection, source);
  return matchesHotCollection || matchesColdCollection
    ? normalized.slice(slashIndex + 1)
    : normalized;
}

export function isTopLevelArchivePath(
  filePath: string,
  policy: GenericRecallPathPolicy = {},
  source: GenericRecallPathSource = "filesystem",
): boolean {
  const isAbsolutePath = path.isAbsolute(filePath);
  const relative =
    policy.memoryDir && isAbsolutePath
      ? path.relative(policy.memoryDir, path.resolve(filePath))
      : filePath;
  const normalized = !isAbsolutePath
    ? stripQmdCollectionPrefix(relative, policy, source)
    : relative;
  return /^(?:archive|namespaces[\\/][^\\/]+[\\/]archive)(?:[\\/]|$)/i.test(normalized);
}

function isExternalWikiQmdPath(
  filePath: string,
  source: GenericRecallPathSource,
): boolean {
  if (source !== "qmd") return false;
  const normalized = normalizeQmdUriPath(filePath, source).replace(/\\/g, "/");
  const slashIndex = normalized.indexOf("/");
  const collection = slashIndex === -1 ? normalized : normalized.slice(0, slashIndex);
  return isExternalWikiCollectionName(collection);
}

/**
 * Paths an EXPLICIT ranked search must not return.
 *
 * Narrower than {@link isGenericRecallExcludedPath} on purpose. Recall
 * injection also drops archived memories because they are cold by definition,
 * but archive is explicitly reserved for "explicit read or search surfaces"
 * (docs/architecture/memory-lifecycle.md) — hiding it from `memory_search`
 * would remove the only way to find it. Everything else stays excluded: those
 * paths flow through their own dedicated surfaces, never a generic search.
 */
export function isSearchExcludedPath(
  filePath: string,
  policy: GenericRecallPathPolicy = {},
  source: GenericRecallPathSource = "filesystem",
): boolean {
  if (isExternalWikiQmdPath(filePath, source)) return true;
  // A QMD transport hands back collection-qualified paths
  // (`qmd://<collection>/activity/<date>.md`, or `<collection>/activity/…`),
  // and the collection is not always one this policy knows: a caller may name
  // a custom one, and global search spans every collection. The activity
  // predicate is ROOT-AWARE — it matches only the top-level
  // `activity/<date>.md` so a nested ordinary memory stays recallable — so an
  // un-stripped prefix reads as a nested path and the digest would be served.
  //
  // Both spellings are therefore tested. Widening is safe in this direction
  // and only here: a leading segment is dropped ONLY to re-test the dedicated
  // surface shapes, never to decide anything else, and a segment that names a
  // memory CATEGORY (`facts/proj/activity/…`) is never treated as a
  // collection, so ordinary nested memories stay searchable.
  for (const candidate of collectionSpellings(filePath, policy, source)) {
    if (
      isArtifactMemoryPath(candidate) ||
      isNamespacedActivityDigestPath(candidate, policy.memoryDir) ||
      isNamespacedLocationDayPath(candidate, policy.memoryDir) ||
      isNamespacedJournalDayPath(candidate, policy.memoryDir) ||
      isMeetingRecordPath(candidate)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The activity check, applied against the NAMESPACE root a hit came from.
 *
 * `isActivityDigestPath` is root-aware — the digest must sit directly under
 * the root it is given — but a namespaced search rewrites hits to absolute
 * paths beneath `…/namespaces/<ns>/`, and only the global `memoryDir` is
 * available here. Measured against that root, a real digest at
 * `<memoryDir>/namespaces/team/activity/<date>.md` reads as nested and is
 * served. Re-measuring against the namespace's own root closes that.
 */
function isNamespacedActivityDigestPath(candidate: string, memoryDir?: string): boolean {
  if (isActivityDigestPath(candidate, memoryDir)) return true;
  if (memoryDir === undefined || memoryDir.length === 0) return false;
  const relative = path.relative(memoryDir, path.resolve(memoryDir, candidate));
  const namespaced = /^namespaces[\\/]([^\\/]+)[\\/](.*)$/.exec(relative);
  if (namespaced === null) return false;
  return isActivityDigestPath(namespaced[2] ?? "", memoryDir);
}

/**
 * The location day-file check, applied against the NAMESPACE root a hit came
 * from — same rationale as `isNamespacedActivityDigestPath`: a namespaced
 * search rewrites hits to absolute paths beneath `…/namespaces/<ns>/`, so the
 * root-aware predicate is re-measured against the namespace's own root.
 */
function isNamespacedLocationDayPath(candidate: string, memoryDir?: string): boolean {
  if (isLocationDayPath(candidate, memoryDir)) return true;
  if (memoryDir === undefined || memoryDir.length === 0) return false;
  const relative = path.relative(memoryDir, path.resolve(memoryDir, candidate));
  const namespaced = /^namespaces[\\/]([^\\/]+)[\\/](.*)$/.exec(relative);
  if (namespaced === null) return false;
  return isLocationDayPath(namespaced[2] ?? "", memoryDir);
}

function isNamespacedJournalDayPath(candidate: string, memoryDir?: string): boolean {
  if (isJournalDayPath(candidate, memoryDir)) return true;
  if (memoryDir === undefined || memoryDir.length === 0) return false;
  const relative = path.relative(memoryDir, path.resolve(memoryDir, candidate));
  const namespaced = /^namespaces[\\/]([^\\/]+)[\\/](.*)$/.exec(relative);
  if (namespaced === null) return false;
  return isJournalDayPath(namespaced[2] ?? "", memoryDir);
}

/** A path as given, plus its form with a leading COLLECTION segment removed. */
function collectionSpellings(
  filePath: string,
  policy: GenericRecallPathPolicy,
  source: GenericRecallPathSource,
): string[] {
  if (path.isAbsolute(filePath)) return [filePath];
  // A `qmd://<collection>/<path>` URI states its collection UNAMBIGUOUSLY in
  // the authority, so the leading segment of its normalized form is never a
  // memory category — strip it outright rather than guessing.
  if (source === "qmd" && filePath.startsWith("qmd://")) {
    const normalized = path.posix.normalize(normalizeQmdUriPath(filePath, source).replace(/\\/g, "/"));
    const slashIndex = normalized.indexOf("/");
    return slashIndex <= 0 || slashIndex >= normalized.length - 1
      ? [normalized]
      : [normalized, normalized.slice(slashIndex + 1)];
  }
  const normalized = path.posix.normalize(
    normalizeQmdUriPath(filePath, source).replace(/\\/g, "/"),
  );
  const stripped = stripQmdCollectionPrefix(filePath, policy, source);
  const spellings = [stripped];
  // If the AUTHORITATIVE strip already fired — the prefix matched a configured
  // collection — stop. Removing a second segment would take a real directory
  // with it: `memories/projects/activity/<date>.md` would become
  // `activity/<date>.md` and an ordinary nested memory would read as a
  // top-level digest, vanishing from search AND recall.
  if (stripped !== normalized) return spellings;
  const slashIndex = stripped.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= stripped.length - 1) return spellings;
  const prefix = stripped.slice(0, slashIndex);
  // The CALLER's own collection is authoritative: a request for
  // `collection: "facts"` means that segment is the collection, whatever it is
  // also the name of. Otherwise a category-shaped prefix stays part of the
  // path, so an ordinary `facts/proj/activity/<date>.md` memory is searchable.
  const requested = policy.requestedCollection;
  if (
    prefix !== requested &&
    (Object.hasOwn(CATEGORY_MEMORY_ROOTS, prefix) || Object.hasOwn(RESERVED_ARCHIVE_ROOTS, prefix))
  ) {
    return spellings;
  }
  spellings.push(stripped.slice(slashIndex + 1));
  return spellings;
}

export function isGenericRecallExcludedPath(
  filePath: string,
  policy: GenericRecallPathPolicy = {},
  source: GenericRecallPathSource = "filesystem",
): boolean {
  return (
    isSearchExcludedPath(filePath, policy, source) ||
    isTopLevelArchivePath(filePath, policy, source) ||
    OKF_RESERVED_BASENAMES[path.basename(filePath)] === true ||
    // Derived per-directory sidecars (#2977): recall-excluded like OKF index
    // files, still searchable. Basename-only, the same accepted tradeoff.
    path.basename(filePath) === DIRECTORY_SIDECAR_BASENAME
  );
}

export function filterRecallCandidates(
  candidates: QmdSearchResult[],
  options: {
    namespacesEnabled: boolean;
    recallNamespaces: string[];
    resolveNamespace: (path: string) => string;
    limit: number;
    pathPolicy?: GenericRecallPathPolicy;
    memoryRoot?: string;
  },
): QmdSearchResult[] {
  const pathPolicy =
    options.pathPolicy ??
    (options.memoryRoot === undefined ? undefined : { memoryDir: options.memoryRoot });
  const scopedByNamespace = options.namespacesEnabled
    ? candidates.filter((r) =>
        options.recallNamespaces.includes(r.namespace ?? options.resolveNamespace(r.path)),
      )
    : candidates;
  return scopedByNamespace
    .filter((r) => !isGenericRecallExcludedPath(r.path, pathPolicy, "qmd"))
    .slice(0, Math.max(0, options.limit));
}
