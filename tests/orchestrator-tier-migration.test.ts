import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import { StorageManager } from "@remnic/core/storage";

function buildConfig(memoryDir: string, workspaceDir: string, enabled: boolean, autoBackfill = true) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    topicExtractionEnabled: false,
    summarizationEnabled: false,
    identityEnabled: false,
    entitySummaryEnabled: false,
    qmdTierMigrationEnabled: enabled,
    qmdTierDemotionMinAgeDays: 0,
    qmdTierDemotionValueThreshold: 1,
    qmdTierPromotionValueThreshold: 1,
    qmdTierAutoBackfillEnabled: autoBackfill,
  });
}

test("tier migration cycle demotes hot memory when enabled", async () => {
  StorageManager.clearAllStaticCaches();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-enabled-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-enabled-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage: StorageManager = orchestrator.storage;
    await storage.writeMemory("fact", "demote me", { source: "test" });

    await orchestrator.runTierMigrationCycle(storage, "extraction");

    const hot = await storage.readAllMemories();
    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();
    assert.equal(hot.length, 0);
    assert.equal(cold.length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("tier migration pins live passport cards but routes completed private records normally", async () => {
  StorageManager.clearAllStaticCaches();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-passport-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-passport-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage: StorageManager = orchestrator.storage;
    const cardAttributes = {
      "support-passport-category": "environment",
      "support-passport-namespace": "alice",
      "support-passport-owner": "a".repeat(64),
      "support-passport-title": "Quiet space",
      "support-passport-order": "0",
      "support-passport-review-by": "2026-09-01T12:00:00.000Z",
      "support-passport-source-ids": "source-1",
    };
    const active = await storage.writeMemory("preference", "Offer a quiet place.", {
      source: "support-passport",
      status: "active",
      tags: ["support-passport-card"],
      structuredAttributes: cardAttributes,
    });
    const rejected = await storage.writeMemory("preference", "Use a bright room.", {
      source: "support-passport",
      status: "rejected",
      tags: ["support-passport-card"],
      structuredAttributes: { ...cardAttributes, "support-passport-order": "1" },
    });
    const audit = await storage.writeMemory("fact", "Card review completed.", {
      source: "support-passport",
      tags: ["support-passport-audit"],
    });

    await orchestrator.runTierMigrationCycle(storage, "extraction");

    const hotIds = new Set((await storage.readAllMemories()).map((memory) => memory.frontmatter.id));
    const coldIds = new Set(
      (await new StorageManager(path.join(storage.dir, "cold")).readAllMemories()).map(
        (memory) => memory.frontmatter.id
      )
    );
    assert.equal(hotIds.has(active.id), true);
    assert.equal(coldIds.has(rejected.id), true);
    assert.equal(coldIds.has(audit.id), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("tier migration cycle is no-op when disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-disabled-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-disabled-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, false)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;
    await storage.writeMemory("fact", "stay hot", { source: "test" });

    await orchestrator.runTierMigrationCycle(storage, "extraction");

    const hot = await storage.readAllMemories();
    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();
    assert.equal(hot.length, 1);
    assert.equal(cold.length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("disabled extraction tier migration skips status state writes on hot path", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-disabled-status-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-disabled-status-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, false)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;
    await storage.writeMemory("fact", "stay hot", { source: "test" });

    await orchestrator.runTierMigrationCycle(storage, "extraction");

    const statusPath = path.join(memoryDir, "state", "tier-migration-status.json");
    await assert.rejects(() => access(statusPath));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("enabled extraction tier migration skips status writes when no memory changes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-noop-status-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-noop-status-workspace-"));
  try {
    const config = buildConfig(memoryDir, workspaceDir, true);
    (config as any).qmdTierDemotionMinAgeDays = 365000;
    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;
    await storage.writeMemory("fact", "keep hot and unchanged", { source: "test" });

    const summary = await orchestrator.runTierMigrationCycle(storage, "extraction");
    assert.equal(summary.migrated, 0);

    const statusPath = path.join(memoryDir, "state", "tier-migration-status.json");
    await assert.rejects(() => access(statusPath));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("dry-run migration does not throttle the next extraction cycle", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-dryrun-throttle-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-dryrun-throttle-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true, true)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;
    await storage.writeMemory("fact", "migrate-after-dry-run", { source: "test" });

    const preview = await orchestrator.runTierMigrationCycle(storage, "manual", {
      dryRun: true,
      limitOverride: 1,
      force: true,
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.migrated, 1);

    const applied = await orchestrator.runTierMigrationCycle(storage, "extraction", {
      limitOverride: 1,
    });
    assert.notEqual(applied.skipped, "min_interval");
    assert.equal(applied.migrated, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("tier migration cycle is bounded per maintenance pass", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-bounded-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-bounded-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true, true)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;
    for (let i = 0; i < 260; i += 1) {
      await storage.writeMemory("fact", `memory-${i}`, { source: "test" });
    }

    await orchestrator.runTierMigrationCycle(storage, "maintenance");

    const hot = await storage.readAllMemories();
    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();
    assert.equal(cold.length > 0, true);
    assert.equal(cold.length <= 200, true);
    assert.equal(hot.length + cold.length, 260);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("tier migration extraction scan prioritizes oldest hot memories for demotion", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-oldest-first-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-oldest-first-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true, true)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;

    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      ids.push((await storage.writeMemory("fact", `memory-${i}`, { source: "test" })).id);
    }

    // Backdating a standing revision is refused by the monotonic revision
    // clamp (#2813 P1) — a rewind is the receipt-reuse vector — so age the
    // recent records FORWARD instead; forward jumps are honored exactly and
    // the untouched first 12 remain the oldest for demotion ordering.
    const oldIds = ids.slice(0, 12);
    const recentIds = ids.slice(12);
    for (const id of recentIds) {
      await storage.updateMemoryFrontmatter(id, {
        updated: "2099-01-01T00:00:00.000Z",
      });
    }

    await orchestrator.runTierMigrationCycle(storage, "extraction");

    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();
    const movedIds = new Set(cold.map((m) => m.frontmatter.id));
    assert.equal(
      oldIds.some((id) => movedIds.has(id)),
      true
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("consolidation refreshes corpus after maintenance migration before archival", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-refresh-corpus-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-refresh-corpus-workspace-"));
  try {
    const config = buildConfig(memoryDir, workspaceDir, true, true);
    (config as any).factArchivalEnabled = true;
    (config as any).identityEnabled = false;
    (config as any).summarizationEnabled = false;
    (config as any).topicExtractionEnabled = false;
    (config as any).entitySummaryEnabled = false;
    const orchestrator = new Orchestrator(config) as any;
    const storage = orchestrator.storage;
    const { id: movedId } = await storage.writeMemory("fact", "migrate-before-archival", { source: "test" });
    for (let i = 0; i < 4; i += 1) {
      await storage.writeMemory("fact", `filler-${i}`, { source: "test" });
    }

    orchestrator.extraction = {
      consolidate: async () => ({ items: [], profileUpdates: [], entityUpdates: [] }),
    };
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };

    let archivalSawMoved = false;
    orchestrator.runFactArchival = async (memories: Array<{ frontmatter: { id: string } }>) => {
      archivalSawMoved = memories.some((m) => m.frontmatter.id === movedId);
      return 0;
    };

    await orchestrator.runConsolidationNow();
    assert.equal(archivalSawMoved, false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
