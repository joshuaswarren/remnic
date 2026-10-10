/**
 * Synthetic ~100k-fact store. Skipped unless REMNIC_ENTITY_INDEX_BENCH=1 so
 * CI does not scan a hundred thousand files. Numbers from a run are
 * VM-measured, not production-disk measurements.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parseConfig } from "@remnic/core/config";
import { buildEntityRecallSection } from "@remnic/core/entity-retrieval";
import { StorageManager } from "@remnic/core/storage";
import type { PluginConfig } from "@remnic/core/types";
import {
  dropEntityMentionIndexCache,
  entityMentionIndexScopeKeys,
  settleEntityMentionIndex,
} from "../packages/remnic-core/src/entity-mention-index-cache.js";

const FACT_COUNT = 100_000;
const SHARD_SIZE = 1_000;
const enabled = process.env.REMNIC_ENTITY_INDEX_BENCH === "1";

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function writeCorpus(memoryDir: string, count: number): Promise<void> {
  const shards = Math.ceil(count / SHARD_SIZE);
  for (let shard = 0; shard < shards; shard += 1) {
    const dir = path.join(memoryDir, "facts", `shard-${String(shard).padStart(3, "0")}`);
    await mkdir(dir, { recursive: true });
    const start = shard * SHARD_SIZE;
    const end = Math.min(count, start + SHARD_SIZE);
    await Promise.all(
      Array.from({ length: end - start }, (_, offset) => {
        const n = start + offset;
        const body = `---
id: fact-bench-${n}
category: fact
created: 2026-01-01T00:00:00.000Z
updated: 2026-01-01T00:00:00.000Z
source: extraction
confidence: 0.8
---

Synthetic bench fact ${n}.
`;
        return writeFile(path.join(dir, `fact-${n}.md`), body);
      }),
    );
  }
}

async function recall(config: PluginConfig, storage: StorageManager): Promise<string | null> {
  return buildEntityRecallSection({
    config,
    storage,
    namespaceStorage: async () => storage,
    recallNamespaces: ["local"],
    query: "Who is Bench Anchor?",
    recentTurns: 4,
    maxHints: 1,
    maxSupportingFacts: 2,
    maxRelatedEntities: 1,
    maxChars: 1200,
    transcriptEntries: [],
  });
}

async function timeRecall(config: PluginConfig, storage: StorageManager): Promise<number> {
  const started = performance.now();
  const section = await recall(config, storage);
  const elapsed = performance.now() - started;
  assert.match(section ?? "", /Bench Anchor/);
  return elapsed;
}

test(
  "entity retrieval latency on a 100k-fact store during writes",
  { skip: !enabled, timeout: 600_000 },
  async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-entity-bench-memory-"));
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-entity-bench-workspace-"));
    try {
      const config = parseConfig({
        openaiApiKey: "sk-test",
        memoryDir,
        workspaceDir,
        qmdEnabled: false,
        namespacesEnabled: true,
        defaultNamespace: "local",
        sharedContextEnabled: false,
        hourlySummariesEnabled: false,
        transcriptEnabled: false,
        nativeKnowledge: {
          enabled: false,
          includeFiles: [],
          maxChunkChars: 200,
          maxResults: 1,
          maxChars: 400,
          stateDir: "state/native-knowledge",
          obsidianVaults: [],
        },
      });
      const storage = new StorageManager(memoryDir, config.entitySchemas);
      await storage.ensureDirectories();
      await writeCorpus(memoryDir, FACT_COUNT);
      const canonical = await storage.writeEntity("Bench Anchor", "project", [
        "Bench Anchor is the synthetic entity for the mention-index benchmark.",
      ]);
      const linked = await storage.writeMemory(
        "fact",
        "Bench Anchor keeps the benchmark marker phrase bench-marker-100.",
        { entityRef: canonical },
      );
      await recall(config, storage);
      const scopeKey = entityMentionIndexScopeKeys().find((key) => key.includes(path.resolve(storage.dir)));
      assert.ok(scopeKey);
      const originalReadAllMemories = storage.readAllMemories.bind(storage);
      let scannedMemories = 0;
      storage.readAllMemories = async (options) => {
        const memories = await originalReadAllMemories(options);
        scannedMemories = memories.length;
        return memories;
      };

      const before: number[] = [];
      for (let sample = 0; sample < 3; sample += 1) {
        dropEntityMentionIndexCache(scopeKey);
        await storage.writeMemoryFrontmatter(linked.memory, {
          heatScore: 0.2 + sample / 100,
          decayScore: 0.05,
          lastValidatedAt: `2026-10-10T00:00:0${sample}.000Z`,
          lifecycleState: "active",
        });
        before.push(await timeRecall(config, storage));
      }

      const afterMetadata: number[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        await storage.writeMemoryFrontmatter(linked.memory, {
          heatScore: 0.5 + sample / 100,
          decayScore: 0.08,
          lastValidatedAt: `2026-10-10T01:00:0${sample}.000Z`,
          lifecycleState: "validated",
        });
        afterMetadata.push(await timeRecall(config, storage));
      }

      const afterContent: number[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        await storage.writeMemory(
          "fact",
          `Bench Anchor noted content write ${sample} during the benchmark.`,
          { entityRef: canonical },
        );
        afterContent.push(await timeRecall(config, storage));
      }

      const report = {
        label: "VM-measured",
        facts: FACT_COUNT,
        memoriesScannedOnRebuild: scannedMemories,
        beforeFullRebuildMs: { p50: percentile(before, 50), max: Math.max(...before), samples: before },
        afterMetadataHitMs: {
          p50: percentile(afterMetadata, 50),
          max: Math.max(...afterMetadata),
          samples: afterMetadata,
        },
        afterContentStaleHitMs: {
          p50: percentile(afterContent, 50),
          max: Math.max(...afterContent),
          samples: afterContent,
        },
      };
      console.log(JSON.stringify(report));
      assert.ok(report.memoriesScannedOnRebuild >= FACT_COUNT);
      assert.ok(report.afterMetadataHitMs.p50 < 1000);
      assert.ok(report.afterContentStaleHitMs.p50 < 1000);
      assert.ok(report.beforeFullRebuildMs.p50 > report.afterMetadataHitMs.p50);
      await settleEntityMentionIndex(scopeKey);
    } finally {
      await Promise.all([
        rm(memoryDir, { recursive: true, force: true }),
        rm(workspaceDir, { recursive: true, force: true }),
      ]);
    }
  },
);
