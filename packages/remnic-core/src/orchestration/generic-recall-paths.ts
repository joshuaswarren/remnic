import path from "node:path";
import type { QmdSearchResult } from "../types.js";
import { isExternalWikiCollectionName } from "../external-wiki-guard.js";
export { isExternalWikiCollectionName } from "../external-wiki-guard.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";
import {
  isActivityDigestPath,
  isArtifactMemoryPath,
  isMeetingRecordPath,
} from "./orchestrator-helpers.js";

export interface GenericRecallPathPolicy {
  readonly memoryDir?: string;
  readonly qmdCollection?: string;
  readonly qmdColdCollection?: string;
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
  return (
    isExternalWikiQmdPath(filePath, source) ||
    isArtifactMemoryPath(filePath) ||
    isActivityDigestPath(filePath, policy.memoryDir) ||
    isMeetingRecordPath(filePath)
  );
}

export function isGenericRecallExcludedPath(
  filePath: string,
  policy: GenericRecallPathPolicy = {},
  source: GenericRecallPathSource = "filesystem",
): boolean {
  return (
    isSearchExcludedPath(filePath, policy, source) ||
    // Recall-only: archived memories are cold, but an explicit search is one
    // of the surfaces they remain reachable through.
    isTopLevelArchivePath(filePath, policy, source)
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
