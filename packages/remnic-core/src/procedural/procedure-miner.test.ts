import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { recordCausalTrajectory, type CausalTrajectoryRecord } from "../causal-trajectory.js";
import type { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { runProcedureMining } from "./procedure-miner.js";

function makeConfig(): PluginConfig {
  return {
    procedural: {
      enabled: true,
      minOccurrences: 2,
      lookbackDays: 30,
      successFloor: 1,
      autoPromoteEnabled: false,
      autoPromoteOccurrences: 10,
    },
  } as PluginConfig;
}

function makeTrajectory(
  trajectoryId: string,
  entityRef: string,
): CausalTrajectoryRecord {
  return {
    schemaVersion: 1,
    trajectoryId,
    recordedAt: new Date().toISOString(),
    sessionKey: "session-procedure-miner",
    goal: "Build the same long-context workflow",
    actionSummary: "Confirm the requirements and prepare the working plan.",
    observationSummary: "The run produced a reusable sequence of actions.",
    outcomeKind: "success",
    outcomeSummary: "The workflow completed successfully with a reusable result.",
    entityRefs: [entityRef],
  };
}

test("procedure mining deduplicates by full cluster hash instead of truncated cluster text", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-procedure-miner-"));
  const written: Array<{ structuredAttributes: Record<string, string> }> = [];
  const storage = {
    async readAllMemories() {
      return written.map((entry, index) => ({
        id: `procedure-${index}`,
        content: "procedure body",
        frontmatter: {
          category: "procedure",
          structuredAttributes: entry.structuredAttributes,
        },
      }));
    },
    async writeMemory(
      _category: string,
      _body: string,
      options: { structuredAttributes?: Record<string, string> },
    ) {
      written.push({
        structuredAttributes: options.structuredAttributes ?? {},
      });
      return `procedure-${written.length}`;
    },
  } as unknown as StorageManager;

  try {
    const sharedPrefix = "entity-".repeat(90);
    await recordCausalTrajectory({
      memoryDir,
      record: makeTrajectory("cluster-a-1", `${sharedPrefix}alpha`),
    });
    await recordCausalTrajectory({
      memoryDir,
      record: makeTrajectory("cluster-a-2", `${sharedPrefix}alpha`),
    });
    await recordCausalTrajectory({
      memoryDir,
      record: makeTrajectory("cluster-b-1", `${sharedPrefix}bravo`),
    });
    await recordCausalTrajectory({
      memoryDir,
      record: makeTrajectory("cluster-b-2", `${sharedPrefix}bravo`),
    });

    const result = await runProcedureMining({
      memoryDir,
      storage,
      config: makeConfig(),
    });

    assert.equal(result.clustersProcessed, 2);
    assert.equal(result.proceduresWritten, 2);
    assert.equal(new Set(written.map((entry) => entry.structuredAttributes.procedure_cluster)).size, 1);
    assert.equal(new Set(written.map((entry) => entry.structuredAttributes.procedure_cluster_hash)).size, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("procedure mining serializes concurrent writes for the same cluster", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-procedure-miner-concurrent-"));
  const written: Array<{ structuredAttributes: Record<string, string> }> = [];
  const storage = {
    async readAllMemories() {
      return written.map((entry, index) => ({
        id: `procedure-${index}`,
        content: "procedure body",
        frontmatter: {
          category: "procedure",
          structuredAttributes: entry.structuredAttributes,
        },
      }));
    },
    async writeMemory(
      _category: string,
      _body: string,
      options: { structuredAttributes?: Record<string, string> },
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      written.push({
        structuredAttributes: options.structuredAttributes ?? {},
      });
      return `procedure-${written.length}`;
    },
  } as unknown as StorageManager;

  try {
    await recordCausalTrajectory({
      memoryDir,
      record: makeTrajectory("cluster-concurrent-1", "entity-concurrent"),
    });
    await recordCausalTrajectory({
      memoryDir,
      record: makeTrajectory("cluster-concurrent-2", "entity-concurrent"),
    });

    const [first, second] = await Promise.all([
      runProcedureMining({ memoryDir, storage, config: makeConfig() }),
      runProcedureMining({ memoryDir, storage, config: makeConfig() }),
    ]);

    assert.equal(written.length, 1);
    assert.equal(first.clustersProcessed, 1);
    assert.equal(second.clustersProcessed, 1);
    assert.equal(first.proceduresWritten + second.proceduresWritten, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
