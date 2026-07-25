import path from "node:path";
import type { QmdSearchResult } from "../types.js";
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

function stripQmdCollectionPrefix(
  relativePath: string,
  policy: GenericRecallPathPolicy,
  source: GenericRecallPathSource,
): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return relativePath;

  const prefix = normalized.slice(0, slashIndex);
  const matchesHotCollection = isQmdCollectionPrefix(prefix, policy.qmdCollection, source);
  const matchesColdCollection = isQmdCollectionPrefix(prefix, policy.qmdColdCollection, source);
  return matchesHotCollection || matchesColdCollection
    ? normalized.slice(slashIndex + 1)
    : relativePath;
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

export function isGenericRecallExcludedPath(
  filePath: string,
  policy: GenericRecallPathPolicy = {},
  source: GenericRecallPathSource = "filesystem",
): boolean {
  return (
    isArtifactMemoryPath(filePath) ||
    isActivityDigestPath(filePath, policy.memoryDir) ||
    isTopLevelArchivePath(filePath, policy, source) ||
    isMeetingRecordPath(filePath)
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
