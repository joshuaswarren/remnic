import type {
  MemoryFile,
  Orchestrator,
  RecallXraySnapshot,
} from "@remnic/core";
import {
  DEFAULT_ATTRIBUTION_THRESHOLD,
  lexicalSimilarity,
} from "../attribution.js";
import type { TaskAttributionWitness } from "../types.js";
import type {
  BenchAttributionRetrieval,
  BenchRecallAttribution,
} from "./types.js";

async function readCoreMemories(orchestrator: Orchestrator): Promise<MemoryFile[]> {
  return [
    ...await orchestrator.storage.readAllMemories(),
    ...await orchestrator.storage.readAllColdMemories(),
  ];
}

async function canonicalizeMemoryIds(
  orchestrator: Orchestrator,
  results: ReadonlyArray<{ path: string; namespace?: string }>,
): Promise<string[] | null> {
  const memories = await Promise.all(
    results.map((result) =>
      orchestrator.qmdResultResolver.readQmdResultMemory(
        result.path,
        orchestrator.storage,
        [],
        result.namespace,
      )),
  );
  if (memories.some((memory) => memory === null)) return null;
  return memories.map((memory) => memory!.frontmatter.id);
}

export async function captureRecallAttribution(
  orchestrator: Orchestrator,
  sessionId: string,
  snapshot: RecallXraySnapshot,
): Promise<BenchRecallAttribution | undefined> {
  const [atCapMemoryIds, headroomMemoryIds] = await Promise.all([
    canonicalizeMemoryIds(orchestrator, snapshot.appliedResults),
    canonicalizeMemoryIds(orchestrator, snapshot.headroomResults),
  ]);
  if (atCapMemoryIds === null || headroomMemoryIds === null) return undefined;
  return {
    sessionId,
    appliedCap: snapshot.appliedResultLimit,
    atCapMemoryIds,
    headroomMemoryIds,
  };
}

export async function captureTaskAttributionWitness(options: {
  orchestrator: Orchestrator;
  qmdCollection: string;
  qmdIndex: string;
  goldMemories: string[];
  retrievals: BenchAttributionRetrieval[];
}): Promise<TaskAttributionWitness> {
  const qmdMaxResults = options.orchestrator.config.qmdMaxResults;
  let storedMemories: MemoryFile[] | null;
  try {
    storedMemories = await readCoreMemories(options.orchestrator);
  } catch {
    storedMemories = null;
  }

  const golds = await Promise.all(
    options.goldMemories.map(async (goldMemory) => {
      const storeMemoryIds = storedMemories === null
        ? null
        : [
            ...new Set(
              storedMemories
                .filter((memory) => lexicalSimilarity(goldMemory, memory.content) >= 0.6)
                .map((memory) => memory.frontmatter.id),
            ),
          ];
      let oracleMemoryIds: string[] | null = null;
      if (qmdMaxResults > 0) {
        try {
          const oracleResults = await options.orchestrator.searchAcrossNamespaces({
            query: goldMemory,
            maxResults: qmdMaxResults,
            mode: "search",
          });
          const canonicalIds = await canonicalizeMemoryIds(
            options.orchestrator,
            oracleResults,
          );
          oracleMemoryIds = canonicalIds === null
            ? null
            : [...new Set(canonicalIds)];
        } catch {
          oracleMemoryIds = null;
        }
      }
      return { goldMemory, storeMemoryIds, oracleMemoryIds };
    }),
  );

  return {
    schemaVersion: 1,
    runtime: {
      qmdCollection: options.qmdCollection,
      qmdIndex: options.qmdIndex,
      qmdMaxResults,
      attributionThreshold: DEFAULT_ATTRIBUTION_THRESHOLD,
    },
    golds,
    retrievals: options.retrievals.map((retrieval) => ({
      sessionId: retrieval.sessionId,
      appliedCap: retrieval.appliedCap,
      atCapMemoryIds:
        retrieval.atCapMemoryIds === null ? null : [...retrieval.atCapMemoryIds],
      headroomMemoryIds:
        retrieval.headroomMemoryIds === null ? null : [...retrieval.headroomMemoryIds],
    })),
  };
}
