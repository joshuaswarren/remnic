import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

test("runConsolidation applies lifecycle policy metadata and writes metrics", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-lifecycle-policy-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-lifecycle-workspace-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      topicExtractionEnabled: false,
      summarizationEnabled: false,
      identityEnabled: false,
      entitySummaryEnabled: false,
      lifecyclePolicyEnabled: true,
      lifecycleMetricsEnabled: true,
      lifecyclePromoteHeatThreshold: 0.5,
      lifecycleStaleDecayThreshold: 0.6,
      lifecycleArchiveDecayThreshold: 0.85,
      lifecycleProtectedCategories: ["decision", "principle", "commitment", "preference"],
    });

    const orchestrator = new Orchestrator(config) as any;
    const storage = orchestrator.storage;

    // Avoid LLM consolidation calls in this integration test.
    orchestrator.extraction = {
      consolidate: async () => ({ items: [], profileUpdates: [], entityUpdates: [] }),
    };

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id: id } = await storage.writeMemory("fact", `memory-${i}`, { source: "test" });
      ids.push(id);
    }

    // Force one very old memory to validate stale/archived scoring behavior.
    await storage.updateMemoryFrontmatter(ids[0], {
      updated: "2010-01-01T00:00:00.000Z",
      lastAccessed: "2010-01-01T00:00:00.000Z",
      confidenceTier: "speculative",
    });
    await storage.updateMemoryFrontmatter(ids[3], {
      status: "archived",
      archivedAt: "2026-04-25T00:00:00.000Z",
    });
    await storage.updateMemoryFrontmatter(ids[4], {
      status: "superseded",
    });

    await orchestrator.runConsolidationNow();

    const memories = await storage.readAllMemories();
    assert.equal(memories.length >= 5, true);
    const superseded = memories.find((m: any) => m.frontmatter.id === ids[4]);
    assert.ok(superseded);
    assert.equal(superseded.frontmatter.status, "superseded");
    assert.equal(superseded.frontmatter.lifecycleState, undefined);

    const evaluated = memories.filter((m: any) => m.frontmatter.status !== "superseded");
    assert.equal(evaluated.every((m: any) => typeof m.frontmatter.lifecycleState === "string"), true);
    assert.equal(evaluated.every((m: any) => typeof m.frontmatter.lastValidatedAt === "string"), true);
    assert.equal(evaluated.every((m: any) => typeof m.frontmatter.heatScore === "number"), true);
    assert.equal(evaluated.every((m: any) => typeof m.frontmatter.decayScore === "number"), true);

    const metricsRaw = await readFile(path.join(memoryDir, "state", "lifecycle-metrics.json"), "utf-8");
    const metrics = JSON.parse(metricsRaw) as any;
    assert.equal(metrics.memoriesEvaluated, evaluated.length);
    assert.equal(typeof metrics.memoriesUpdated, "number");
    assert.equal(typeof metrics.countsByLifecycleState, "object");
    assert.equal(metrics.countsByLifecycleState.archived >= 1, true);
    assert.equal(typeof metrics.staleRatio, "number");
    assert.equal(typeof metrics.disputedRatio, "number");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
