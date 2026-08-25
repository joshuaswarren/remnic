/**
 * Recognition-tier swap at fetchQmdMemoryResultsWithArtifactTopUp (issue #2975).
 *
 * Off-path (recallRecognitionTier !== true): original fetch only — no index
 * load, no model call. On-path: namespaces whose index is at or under
 * recognitionIndexMaxEntries go through one recognizer call; the rest keep
 * vector search. A failing recognizer degrades that namespace to vector search.
 */
import path from "node:path";

import { log } from "../logger.js";
import { dedupeResultsByNamespace } from "../recall-memory-map.js";
import {
  decideRecognitionTier,
  loadRecognitionIndex,
  runRecognitionTier,
  type RecognitionIndex,
} from "../recall-recognition-tier.js";
import type { QmdSearchResult } from "../types.js";
import { throwIfRecallAborted } from "./orchestrator-helpers.js";
import type { RecallInternalDeps } from "./recall-internal-deps.js";

export type RecognitionSearchDeps = Pick<
  RecallInternalDeps,
  "config" | "storageRouter" | "fastLlmForRerank" | "fetchQmdMemoryResultsWithArtifactTopUp"
>;

type ArtifactTopUpOptions = Parameters<
  RecognitionSearchDeps["fetchQmdMemoryResultsWithArtifactTopUp"]
>[3];

type RecognitionStorage = {
  dir: string;
  findExistingMemoryPaths(ids: string[]): Promise<Map<string, string[]>>;
};

export async function fetchQmdMemoryResultsWithRecognitionSwap(
  deps: RecognitionSearchDeps,
  prompt: string,
  qmdFetchLimit: number,
  qmdHybridFetchLimit: number,
  options: ArtifactTopUpOptions,
): Promise<QmdSearchResult[]> {
  if (
    deps.config.recallRecognitionTier !== true ||
    options.collection ||
    options.namespacesEnabled !== true
  ) {
    return deps.fetchQmdMemoryResultsWithArtifactTopUp(
      prompt,
      qmdFetchLimit,
      qmdHybridFetchLimit,
      options,
    );
  }

  const namespaces = options.recallNamespaces.filter(Boolean);
  if (namespaces.length === 0) {
    return deps.fetchQmdMemoryResultsWithArtifactTopUp(
      prompt,
      qmdFetchLimit,
      qmdHybridFetchLimit,
      options,
    );
  }

  throwIfRecallAborted(options.abortSignal);
  const maxEntries = deps.config.recognitionIndexMaxEntries;
  const recognitionNs: Array<{ namespace: string; storage: RecognitionStorage; index: RecognitionIndex }> = [];
  const vectorNs: string[] = [];

  for (const namespace of namespaces) {
    throwIfRecallAborted(options.abortSignal);
    const storage = (await deps.storageRouter.storageFor(namespace)) as RecognitionStorage;
    const index = await loadRecognitionIndex(storage.dir);
    const decision = decideRecognitionTier(index, { maxEntries });
    if (index !== null && decision.tier === "recognition") {
      recognitionNs.push({ namespace, storage, index });
    } else {
      vectorNs.push(namespace);
    }
  }

  if (recognitionNs.length === 0) {
    return deps.fetchQmdMemoryResultsWithArtifactTopUp(
      prompt,
      qmdFetchLimit,
      qmdHybridFetchLimit,
      options,
    );
  }

  const recognize = async (recognitionPrompt: string): Promise<string | null | undefined> => {
    const reply = await deps.fastLlmForRerank.chatCompletion(
      [{ role: "user", content: recognitionPrompt }],
      { operation: "recognition-tier", priority: "recall-critical" },
    );
    return reply?.content;
  };

  const recognized: QmdSearchResult[] = [];
  for (const { namespace, storage, index } of recognitionNs) {
    throwIfRecallAborted(options.abortSignal);
    try {
      const run = await runRecognitionTier(prompt, index.entries, recognize);
      recognized.push(
        ...(await hitsFromIds(namespace, storage, index, run.ids)),
      );
    } catch (err) {
      log.warn(
        `recognition tier degraded to vector search: recognizer failed${
          err instanceof Error ? ` (${err.message})` : ""
        }`,
      );
      vectorNs.push(namespace);
    }
  }

  const vectorResults =
    vectorNs.length === 0
      ? []
      : await deps.fetchQmdMemoryResultsWithArtifactTopUp(
          prompt,
          qmdFetchLimit,
          qmdHybridFetchLimit,
          { ...options, recallNamespaces: vectorNs },
        );

  return dedupeResultsByNamespace(
    [...recognized, ...vectorResults],
    options.resolveNamespace,
    qmdFetchLimit,
  );
}

async function hitsFromIds(
  namespace: string,
  storage: RecognitionStorage,
  index: RecognitionIndex,
  ids: readonly string[],
): Promise<QmdSearchResult[]> {
  if (ids.length === 0) return [];
  const pathsById = await storage.findExistingMemoryPaths([...ids]);
  const descriptionById = new Map(index.entries.map((entry) => [entry.id, entry.description]));
  const hits: QmdSearchResult[] = [];
  for (const [offset, id] of ids.entries()) {
    const absPath = pathsById.get(id)?.[0];
    if (!absPath) continue;
    const rel = path.relative(storage.dir, absPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    hits.push({
      docid: `${namespace}:${rel}`,
      namespace,
      path: rel,
      score: ids.length - offset,
      snippet: descriptionById.get(id) ?? id,
    });
  }
  return hits;
}
