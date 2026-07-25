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

const RESERVED_GENERIC_RECALL_ROOTS: Record<string, true> = Object.fromEntries(
  ["archive", "namespaces", ...ALL_CATEGORY_DIRS].map((directory) => [directory, true]),
);

function isQmdCollectionPrefix(prefix: string, collection: string | undefined): boolean {
  return (
    typeof collection === "string" &&
    collection.length > 0 &&
    ((prefix === collection && !Object.hasOwn(RESERVED_GENERIC_RECALL_ROOTS, prefix)) ||
      prefix.startsWith(`${collection}--`))
  );
}


function stripQmdCollectionPrefix(
  relativePath: string,
  policy: GenericRecallPathPolicy,
): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return relativePath;

  const prefix = normalized.slice(0, slashIndex);
  const matchesHotCollection = isQmdCollectionPrefix(prefix, policy.qmdCollection);
  const matchesColdCollection = isQmdCollectionPrefix(prefix, policy.qmdColdCollection);
  return matchesHotCollection || matchesColdCollection
    ? normalized.slice(slashIndex + 1)
    : relativePath;
}

export function isTopLevelArchivePath(
  filePath: string,
  policy: GenericRecallPathPolicy = {},
): boolean {
  const relative = policy.memoryDir
    ? path.relative(policy.memoryDir, path.resolve(policy.memoryDir, filePath))
    : filePath;
  return /^(?:archive|namespaces[\\/][^\\/]+[\\/]archive)(?:[\\/]|$)/i.test(
    stripQmdCollectionPrefix(relative, policy),
  );
}

export function isGenericRecallExcludedPath(
  filePath: string,
  policy: GenericRecallPathPolicy = {},
): boolean {
  return (
    isArtifactMemoryPath(filePath) ||
    isActivityDigestPath(filePath, policy.memoryDir) ||
    isTopLevelArchivePath(filePath, policy) ||
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
    .filter((r) => !isGenericRecallExcludedPath(r.path, pathPolicy))
    .slice(0, Math.max(0, options.limit));
}
