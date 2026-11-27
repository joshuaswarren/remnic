import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resetExtractionLlmHealthForTests } from "./extraction-llm-health.js";
import { Orchestrator } from "./orchestrator.js";
import type { StorageManager } from "./storage.js";
import {
  cleanupDir,
  harmonicNodeStoreStatus,
  makeHarmonicLifecycleConfig,
  mkTempMemoryDir,
} from "./testing/orchestrator-lite.js";
import type { ExtractionResult } from "./types.js";

const EARLIER = "Prefers terse queue names for background jobs in Project Gamma.";

type BranchCase = {
  label: string;
  config?: Parameters<typeof makeHarmonicLifecycleConfig>[1];
  later: Partial<ExtractionResult>;
  inject: (orchestrator: Orchestrator, storage: StorageManager, memoryDir: string) => Promise<Error>;
  committedBeforeFailure?: (storage: StorageManager) => Promise<string>;
};

async function assertEarlierFactFinalized(branch: BranchCase): Promise<void> {
  const memoryDir = await mkTempMemoryDir(`persist-branch-${branch.label}`);
  const config = makeHarmonicLifecycleConfig(memoryDir, {
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
    factDeduplicationEnabled: true,
    extractionMinImportanceLevel: "trivial",
    entityActivityLogEnabled: false,
    queryAwareIndexingEnabled: true,
    ...branch.config,
  });
  const orchestrator = new Orchestrator(config);
  const storage = await orchestrator.getStorageForNamespace();
  const temporalIdBatches: string[][] = [];
  const temporalUpdates: Promise<void>[] = [];
  const originalTemporal = orchestrator["updateTemporalTagIndexes"].bind(orchestrator);
  orchestrator["updateTemporalTagIndexes"] = (target, persistedIds) => {
    temporalIdBatches.push([...persistedIds]);
    const update = originalTemporal(target, persistedIds);
    temporalUpdates.push(update);
    return update;
  };
  let qmdMaintenanceCalls = 0;
  const originalQmd = orchestrator.requestQmdMaintenance.bind(orchestrator);
  orchestrator.requestQmdMaintenance = () => {
    qmdMaintenanceCalls += 1;
    originalQmd();
  };
  try {
    await storage.ensureDirectories();
    const failure = await branch.inject(orchestrator, storage, memoryDir);
    const result: ExtractionResult = {
      entities: [],
      questions: [],
      profileUpdates: [],
      ...branch.later,
      facts: [
        { content: EARLIER, category: "preference", confidence: 0.95, tags: ["queue-naming"] },
        ...(branch.later.facts ?? []),
      ],
    };

    await assert.rejects(
      orchestrator.persistExtraction(result, storage, null, { sessionKey: `session:${branch.label}` }),
      (error: Error) => error === failure,
      "the branch failure must reach the caller unchanged",
    );
    const branchWriteId = await branch.committedBeforeFailure?.(storage);

    const earlier = (await storage.readAllMemories()).filter((m) => m.frontmatter.category === "preference");
    assert.equal(earlier.length, 1, "the earlier fact must stay durable");
    const factId = earlier[0]!.frontmatter.id;
    assert.ok(
      (await storage.readBehaviorSignals(50)).some(
        (s) => s.memoryId === factId && s.signalType === "preference_affinity",
      ),
      "the earlier fact's behavior signal must land before the rethrow",
    );
    const harmonicSources = (await harmonicNodeStoreStatus(memoryDir)).latestNode?.sourceMemoryIds ?? [];
    for (const id of branchWriteId ? [factId, branchWriteId] : [factId]) {
      assert.ok(harmonicSources.includes(id), `the harmonic node must cover durable write ${id} before the rethrow`);
      assert.ok(
        temporalIdBatches.some((ids) => ids.includes(id)),
        `the temporal/tag index update must cover durable write ${id} before the rethrow`,
      );
    }
    assert.ok(qmdMaintenanceCalls > 0, "the partial batch must still schedule QMD maintenance");
  } finally {
    await Promise.allSettled(temporalUpdates);
    orchestrator.requestQmdMaintenance = originalQmd;
    orchestrator["updateTemporalTagIndexes"] = originalTemporal;
    try {
      await orchestrator.destroy();
    } finally {
      resetExtractionLlmHealthForTests();
      await cleanupDir(memoryDir);
    }
  }
}

test("#3288: a chunk write failure after the chunked parent is durable finalizes the earlier fact", async () => {
  await assertEarlierFactFinalized({
    label: "chunk-write",
    config: {
      chunkingEnabled: true,
      chunkingTargetTokens: 12,
      chunkingMinTokens: 10,
      chunkingOverlapSentences: 0,
    },
    later: {
      facts: [
        {
          content:
            "Project Gamma runs its nightly export on a dedicated worker pool. " +
            "The export writes compressed archives to the cold storage bucket. " +
            "Each archive is verified against a checksum manifest before upload. " +
            "Failed uploads are retried three times with exponential backoff.",
          category: "fact",
          confidence: 0.9,
          tags: ["export"],
        },
      ],
    },
    inject: async (_orchestrator, storage) => {
      const failure = new Error("synthetic chunk write failure");
      storage.writeChunk = async () => {
        throw failure;
      };
      return failure;
    },
    committedBeforeFailure: async (storage) => {
      const parents = (await storage.readAllMemories()).filter((m) => m.frontmatter.tags?.includes("chunked"));
      assert.equal(parents.length, 1, "the chunked parent must be durable before the chunk write throws");
      return parents[0]!.frontmatter.id;
    },
  });
});

const MERGE_TARGET_ID = "merge-target-gamma";
const MERGE_SEED = "The Project Gamma billing service deploys on a Tuesday cadence.";
const MERGE_INCOMING = "The Project Gamma billing service deploys at 09:00 UTC sharp.";

async function armSemanticMerge(orchestrator: Orchestrator, memoryDir: string): Promise<void> {
  const created = new Date(Date.now() - 3600_000).toISOString();
  const seededDir = path.join(memoryDir, "facts", created.slice(0, 10));
  await mkdir(seededDir, { recursive: true });
  await writeFile(
    path.join(seededDir, `${MERGE_TARGET_ID}.md`),
    [
      "---",
      `id: ${MERGE_TARGET_ID}`,
      "category: fact",
      `created: ${created}`,
      `updated: ${created}`,
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: active",
      "importanceScore: 0.9",
      "importanceLevel: high",
      "---",
      "",
      MERGE_SEED,
      "",
    ].join("\n"),
    "utf8",
  );
  const embeddings = orchestrator.embeddingFallback;
  embeddings.isAvailable = async () => true;
  embeddings.search = async (query) => (query === MERGE_INCOMING ? [{ id: MERGE_TARGET_ID, score: 0.85, path: "" }] : []);
  embeddings.indexFile = async () => {};
  embeddings.removeFromIndex = async () => {};
  orchestrator.localLlm.chatCompletion = async (messages) =>
    messages[0]?.role === "system" && messages[0].content.startsWith("You maintain a long-term memory store")
      ? {
          content: JSON.stringify({
            decision: "merge",
            targetId: MERGE_TARGET_ID,
            mergedContent: `${MERGE_SEED} ${MERGE_INCOMING}`,
            reason: "deterministic judge for the merge-branch failure test",
          }),
        }
      : null;
}

test("#3288: a semantic-merge post-effect failure after the merge commits finalizes the earlier fact", async () => {
  await assertEarlierFactFinalized({
    label: "semantic-merge",
    config: {
      embeddingFallbackEnabled: true,
      versioningEnabled: true,
      semanticMerge: { enabled: true },
      multiGraphMemoryEnabled: true,
    },
    later: {
      facts: [{ content: MERGE_INCOMING, category: "fact", confidence: 0.9, tags: [] }],
    },
    inject: async (orchestrator, _storage, memoryDir) => {
      await armSemanticMerge(orchestrator, memoryDir);
      const failure = new Error("synthetic graph index failure");
      orchestrator["graphIndexFor"] = () => {
        throw failure;
      };
      return failure;
    },
    committedBeforeFailure: async (storage) => {
      const target = await storage.getMemoryByIdIncludingArchived(MERGE_TARGET_ID);
      assert.ok(target?.content.includes(MERGE_INCOMING), "the merge must be committed before the post effect throws");
      return MERGE_TARGET_ID;
    },
  });
});

test("#3288: a profile append failure after an earlier fact is durable finalizes that fact", async () => {
  await assertEarlierFactFinalized({
    label: "profile-append",
    later: { profileUpdates: ["Works mostly on the Project Gamma export pipeline."] },
    inject: async (_orchestrator, storage) => {
      const failure = new Error("synthetic profile append failure");
      storage.appendToProfile = async () => {
        throw failure;
      };
      return failure;
    },
  });
});

test("#3288: a question write failure after an earlier fact is durable finalizes that fact", async () => {
  await assertEarlierFactFinalized({
    label: "question-write",
    later: {
      questions: [{ question: "Which bucket holds the Project Gamma archives?", context: "export pipeline", priority: 0.5 }],
    },
    inject: async (_orchestrator, storage) => {
      const failure = new Error("synthetic question write failure");
      storage.writeQuestion = async () => {
        throw failure;
      };
      return failure;
    },
  });
});
