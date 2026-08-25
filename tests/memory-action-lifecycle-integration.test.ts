import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

test("memory-action priors influence lifecycle scores without circular amplification", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memact-lifecycle-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memact-workspace-"));
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
      lifecycleMetricsEnabled: false,
      lifecyclePromoteHeatThreshold: 0.5,
      lifecycleStaleDecayThreshold: 0.6,
      lifecycleArchiveDecayThreshold: 0.85,
      lifecycleProtectedCategories: ["decision", "principle", "commitment", "preference"],
    });

    const orchestrator = new Orchestrator(config) as any;
    const storage = orchestrator.storage;
    orchestrator.extraction = {
      consolidate: async () => ({ items: [], profileUpdates: [], entityUpdates: [] }),
    };

    const { id: penalizedId } = await storage.writeMemory("fact", "penalized", { source: "test" });
    const { id: boostedId } = await storage.writeMemory("fact", "boosted", { source: "test" });
    const baselineTs = "2026-01-01T00:00:00.000Z";
    await storage.updateMemoryFrontmatter(penalizedId, {
      updated: baselineTs,
      lastAccessed: baselineTs,
      confidenceTier: "inferred",
    });
    await storage.updateMemoryFrontmatter(boostedId, {
      updated: baselineTs,
      lastAccessed: baselineTs,
      confidenceTier: "inferred",
    });

    const nowIso = new Date().toISOString();
    await storage.appendMemoryActionEvents([
      {
        timestamp: nowIso,
        action: "discard",
        outcome: "skipped",
        namespace: "default",
        memoryId: penalizedId,
        policyDecision: "deny",
        reason: "policy:deny | high_importance_requires_manual_review",
      },
      {
        timestamp: nowIso,
        action: "store_note",
        outcome: "applied",
        namespace: "default",
        memoryId: boostedId,
        policyDecision: "allow",
        reason: "policy:allow | accepted",
      },
    ]);

    const priors = await orchestrator.lifecyclePolicyCoordinator.buildLifecycleActionPriors();
    assert.ok((priors.get(penalizedId) ?? 0) < 0);
    assert.ok((priors.get(boostedId) ?? 0) > 0);

    await orchestrator.runConsolidationNow();
    const afterFirstPass = await storage.readAllMemories();
    const penalizedFirst = afterFirstPass.find((m: any) => m.frontmatter.id === penalizedId);
    const boostedFirst = afterFirstPass.find((m: any) => m.frontmatter.id === boostedId);
    assert.ok(penalizedFirst);
    assert.ok(boostedFirst);

    const firstPenalizedHeat = penalizedFirst!.frontmatter.heatScore ?? 0;
    const firstBoostedHeat = boostedFirst!.frontmatter.heatScore ?? 0;

    await orchestrator.runConsolidationNow();
    const afterSecondPass = await storage.readAllMemories();
    const penalizedSecond = afterSecondPass.find((m: any) => m.frontmatter.id === penalizedId);
    const boostedSecond = afterSecondPass.find((m: any) => m.frontmatter.id === boostedId);
    assert.ok(penalizedSecond);
    assert.ok(boostedSecond);

    // Re-running lifecycle with the same bounded priors should not create runaway score drift.
    assert.ok(Math.abs((penalizedSecond!.frontmatter.heatScore ?? 0) - firstPenalizedHeat) < 0.02);
    assert.ok(Math.abs((boostedSecond!.frontmatter.heatScore ?? 0) - firstBoostedHeat) < 0.02);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("lifecycle action prior cap keeps newest per-memory events", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memact-prior-cap-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memact-prior-cap-workspace-"));
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
      lifecycleMetricsEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    const storage = orchestrator.storage;
    const { id: memoryId } = await storage.writeMemory("fact", "prior-cap-memory", { source: "test" });

    const base = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const events = Array.from({ length: 10 }, (_, idx) => {
      const recentFail = idx >= 8;
      return {
        timestamp: new Date(base + idx * 60_000).toISOString(),
        action: recentFail ? "discard" : "store_note",
        outcome: recentFail ? "failed" : "applied",
        namespace: "default",
        memoryId,
        policyDecision: recentFail ? "deny" : "allow",
      };
    });
    await storage.appendMemoryActionEvents(events);

    const priors = await orchestrator.lifecyclePolicyCoordinator.buildLifecycleActionPriors();
    assert.ok((priors.get(memoryId) ?? 0) < 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
