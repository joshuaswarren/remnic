import path from "node:path";
import { coerceBool } from "./connectors/coerce.js";

export const EXTERNAL_WIKI_COLLECTION_PREFIX = "external-wiki-";

export function isExternalWikiCollectionName(collection: string): boolean {
  return collection.startsWith(EXTERNAL_WIKI_COLLECTION_PREFIX);
}

export function parseExternalWikiRecallGuard(config: Record<string, unknown>): {
  wikiMergeIntoRecall: false;
  qmdCollection: string;
  qmdColdCollection: string;
} {
  const rawMerge = config.wikiMergeIntoRecall;
  const merge = rawMerge == null ? false : coerceBool(rawMerge);
  if (merge === undefined) {
    throw new Error(
      `wikiMergeIntoRecall must be a boolean-like value (true/false/1/0/yes/no/on/off); got ${JSON.stringify(rawMerge)}`,
    );
  }
  if (merge) {
    throw new Error(
      "wikiMergeIntoRecall=true is not supported; external wiki content is available only through on-demand search",
    );
  }

  const qmdCollection =
    typeof config.qmdCollection === "string"
      ? config.qmdCollection
      : "openclaw-engram";
  const qmdColdCollection =
    typeof config.qmdColdCollection === "string" && config.qmdColdCollection.length > 0
      ? config.qmdColdCollection
      : "openclaw-engram-cold";
  if (isExternalWikiCollectionName(qmdCollection)) {
    throw new Error(
      "qmdCollection must be a memory collection; external wiki collections are on-demand only",
    );
  }
  if (isExternalWikiCollectionName(qmdColdCollection)) {
    throw new Error(
      "qmdColdCollection must be a memory collection; external wiki collections are on-demand only",
    );
  }
  return { wikiMergeIntoRecall: false, qmdCollection, qmdColdCollection };
}

export function assertExternalWikiRootOutsideMemoryDir(memoryDir: string, rootDir: string): void {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const relativeRoot = path.relative(resolvedMemoryDir, path.resolve(rootDir));
  const isInsideMemoryDir =
    relativeRoot === "" ||
    (!path.isAbsolute(relativeRoot) && relativeRoot !== ".." && !relativeRoot.startsWith(`..${path.sep}`));
  if (isInsideMemoryDir) {
    throw new Error(`external wiki rootDir must be outside memoryDir: ${rootDir}`);
  }
}
