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

function stripQmdCollectionPrefix(
  relativePath: string,
  policy: GenericRecallPathPolicy,
): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return relativePath;

  const prefix = normalized.slice(0, slashIndex);
  const matchesHotCollection =
    typeof policy.qmdCollection === "string" &&
    policy.qmdCollection.length > 0 &&
    ((prefix === policy.qmdCollection && !ALL_CATEGORY_DIRS.includes(prefix)) ||
      prefix.startsWith(`${policy.qmdCollection}--`));
  const matchesColdCollection =
    typeof policy.qmdColdCollection === "string" &&
    policy.qmdColdCollection.length > 0 &&
    ((prefix === policy.qmdColdCollection && !ALL_CATEGORY_DIRS.includes(prefix)) ||
      prefix.startsWith(`${policy.qmdColdCollection}--`));
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
  },
): QmdSearchResult[] {
  const scopedByNamespace = options.namespacesEnabled
    ? candidates.filter((r) =>
        options.recallNamespaces.includes(r.namespace ?? options.resolveNamespace(r.path)),
      )
    : candidates;
  return scopedByNamespace
    .filter((r) => !isGenericRecallExcludedPath(r.path, options.pathPolicy))
    .slice(0, Math.max(0, options.limit));
}
