import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import {
  resolveCuratedIncludeFilesStatePath,
  resolveNativeKnowledgeStatePath,
  resolveOpenClawWorkspaceStatePath,
} from "@remnic/core/native-knowledge";
import { StorageManager } from "@remnic/core/storage";
import {
  runBenchmarkRecall,
  runOperatorConfigReview,
  runOperatorDoctor,
  runOperatorInventory,
  runOperatorRepair,
  runOperatorSetup,
  type OperatorToolkitOrchestrator,
} from "@remnic/core/operator-toolkit";

function openclawConfigDocument(pluginConfig: Record<string, unknown>): string {
  return JSON.stringify({
    plugins: {
      entries: {
        "openclaw-remnic": {
          config: pluginConfig,
        },
      },
    },
  }, null, 2);
}

async function makeFixture(overrides: Record<string, unknown> = {}): Promise<{
  root: string;
  memoryDir: string;
  workspaceDir: string;
  configPath: string;
  config: ReturnType<typeof parseConfig>;
  orchestrator: OperatorToolkitOrchestrator;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-operator-toolkit-"));
  const memoryDir = path.join(root, "memory");
  const workspaceDir = path.join(root, "workspace");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const rawConfig = {
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    sharedContextEnabled: false,
    captureMode: "implicit",
    ...overrides,
  };
  const config = parseConfig(rawConfig);
  const configPath = path.join(root, "openclaw.json");
  await writeFile(configPath, openclawConfigDocument(rawConfig), "utf-8");
  const orchestrator: OperatorToolkitOrchestrator = {
    config,
    storage: new StorageManager(memoryDir),
    qmd: {
      async probe() {
        return config.qmdEnabled;
      },
      isAvailable() {
        return config.qmdEnabled;
      },
      async ensureCollection() {
        return config.qmdEnabled ? "present" : "skipped";
      },
      debugStatus() {
        return config.qmdEnabled ? "available" : "disabled";
      },
    },
    conversationIndexCoordinator: {
      async getHealth() {
        return {
          enabled: false,
          backend: "qmd" as const,
          status: "disabled" as const,
          chunkDocCount: 0,
          lastUpdateAt: null,
        };
      },
      async rebuild() {
        return {
          chunks: 0,
          skipped: true,
          reason: "disabled",
          embedded: false,
          rebuilt: false,
        };
      },
    },
  };
  return { root, memoryDir, workspaceDir, configPath, config, orchestrator };
}

test("operator setup scaffolds directories and optional capture instructions", async () => {
  const fixture = await makeFixture({ captureMode: "explicit" });

  const report = await runOperatorSetup({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
    installCaptureInstructions: true,
  });

  assert.equal(report.config.parsed, true);
  assert.equal(report.explicitCapture.enabled, true);
  assert.equal(report.explicitCapture.memoryDocInstalled, true);
  assert.equal(report.directories.some((entry) => entry.path.endsWith("/entities") && entry.exists), true);
  const memoryDoc = await readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf-8");
  assert.match(memoryDoc, /explicit memory capture/i);
});

test("operator setup previews and removes managed capture instructions", async () => {
  const fixture = await makeFixture({ captureMode: "explicit" });

  const preview = await runOperatorSetup({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
    captureInstructionsMode: "preview",
  });
  assert.match(preview.explicitCapture.preview ?? "", /BEGIN ENGRAM EXPLICIT CAPTURE INSTRUCTIONS/);

  await runOperatorSetup({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
    captureInstructionsMode: "install",
  });
  const memoryDocPath = path.join(fixture.workspaceDir, "MEMORY.md");
  const installed = await readFile(memoryDocPath, "utf-8");
  assert.match(installed, /BEGIN ENGRAM EXPLICIT CAPTURE INSTRUCTIONS/);

  const removed = await runOperatorSetup({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
    captureInstructionsMode: "remove",
  });
  assert.equal(removed.explicitCapture.memoryDocRemoved, true);
  await assert.rejects(() => readFile(memoryDocPath, "utf-8"), /ENOENT/);
});

test("operator setup can remove managed capture instructions after captureMode is switched back to implicit", async () => {
  const fixture = await makeFixture({ captureMode: "explicit" });

  await runOperatorSetup({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
    captureInstructionsMode: "install",
  });
  fixture.orchestrator.config.captureMode = "implicit";

  const removed = await runOperatorSetup({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
    captureInstructionsMode: "remove",
  });

  assert.equal(removed.explicitCapture.enabled, false);
  assert.equal(removed.explicitCapture.memoryDocRemoved, true);
  await assert.rejects(() => readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf-8"), /ENOENT/);
});

test("operator doctor surfaces auth and qmd problems", async () => {
  // Clear env var so authToken falls back to undefined (test expects "error" status)
  const savedToken = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  try {
    const fixture = await makeFixture({
      qmdEnabled: true,
      agentAccessHttp: { enabled: true, port: 8765 },
      fileHygiene: {
        enabled: true,
        lintEnabled: true,
        lintPaths: ["MEMORY.md"],
        lintBudgetBytes: 100,
        lintWarnRatio: 0.5,
      },
    });
    await writeFile(path.join(fixture.workspaceDir, "MEMORY.md"), "x".repeat(80), "utf-8");
    fixture.orchestrator.qmd = {
      async probe() {
        return false;
      },
      isAvailable() {
        return false;
      },
      async ensureCollection() {
        return "missing";
      },
      debugStatus() {
        return "cli=false";
      },
    };
    fixture.orchestrator.conversationIndexCoordinator.getHealth = async () => ({
      enabled: true,
      backend: "qmd",
      status: "degraded",
      chunkDocCount: 0,
      lastUpdateAt: null,
      qmdAvailable: false,
    });

    const report = await runOperatorDoctor({
      orchestrator: fixture.orchestrator,
      configPath: fixture.configPath,
    });

    assert.equal(report.ok, false);
    assert.ok(report.summary.error >= 1);
    assert.equal(report.checks.some((check) => check.key === "access_http_auth" && check.status === "error"), true);
    assert.equal(report.checks.some((check) => check.key === "qmd" && check.status === "error"), true);
    assert.equal(report.checks.some((check) => check.key === "conversation_index" && check.status === "error"), true);
    assert.equal(report.checks.some((check) => check.key === "file_hygiene" && check.status === "warn"), true);
  } finally {
    if (savedToken !== undefined) process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = savedToken;
    else delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  }
});

test("operator doctor treats unreachable qmd as an error even when collection state is unknown", async () => {
  const fixture = await makeFixture({
    qmdEnabled: true,
  });
  fixture.orchestrator.qmd = {
    async probe() {
      return false;
    },
    isAvailable() {
      return false;
    },
    async ensureCollection() {
      return "unknown";
    },
    debugStatus() {
      return "missing-binary";
    },
  };

  const report = await runOperatorDoctor({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  assert.equal(report.checks.some((check) => check.key === "qmd" && check.status === "error"), true);
});

test("operator doctor warns when file hygiene linting is disabled", async () => {
  const fixture = await makeFixture({
    fileHygiene: {
      enabled: true,
      lintEnabled: false,
      lintPaths: ["MEMORY.md"],
      lintBudgetBytes: 100,
      lintWarnRatio: 0.5,
    },
  });

  const report = await runOperatorDoctor({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  assert.equal(report.checks.some((check) => check.key === "file_hygiene" && check.status === "warn"), true);
});

test("operator config review recommends balanced baseline improvements and workspace recall helpers", async () => {
  const fixture = await makeFixture({
    qmdEnabled: true,
  });
  await writeFile(path.join(fixture.workspaceDir, "IDENTITY.md"), "# Identity\n", "utf-8");

  const report = await runOperatorConfigReview({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  assert.equal(report.summary.problem, 0);
  assert.equal(report.summary.recommend > 0, true);
  assert.equal(report.findings.some((finding) => finding.key === "balanced_preset" && finding.status === "recommend"), true);
  assert.equal(report.findings.some((finding) => finding.key === "file_hygiene_enabled" && finding.status === "recommend"), true);
  assert.equal(report.findings.some((finding) => finding.key === "native_knowledge_enabled" && finding.status === "recommend"), true);
});

test("operator config review does not second-guess the conservative preset", async () => {
  const fixture = await makeFixture({
    qmdEnabled: true,
    memoryOsPreset: "conservative",
  });

  const report = await runOperatorConfigReview({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  assert.equal(report.findings.some((finding) => finding.key === "balanced_preset"), false);
});

test("operator config review flags search and tier mismatches as problems", async () => {
  const fixture = await makeFixture({
    qmdEnabled: false,
    qmdTierMigrationEnabled: true,
    conversationIndexEnabled: true,
    conversationIndexBackend: "qmd",
  });

  const report = await runOperatorConfigReview({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  assert.equal(report.summary.problem >= 3, true);
  assert.equal(report.findings.some((finding) => finding.key === "qmd_search_backend_disabled" && finding.status === "problem"), true);
  assert.equal(report.findings.some((finding) => finding.key === "qmd_tier_migration_requires_cold_tier" && finding.status === "problem"), true);
  assert.equal(report.findings.some((finding) => finding.key === "conversation_index_qmd_requires_qmd" && finding.status === "problem"), true);
});

test("operator config review flags qmd search backend disabled even without extra feature toggles", async () => {
  const fixture = await makeFixture({
    qmdEnabled: false,
  });

  const report = await runOperatorConfigReview({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  assert.equal(report.findings.some((finding) => finding.key === "qmd_search_backend_disabled" && finding.status === "problem"), true);
});

test("operator doctor includes config review problems in health output", async () => {
  const fixture = await makeFixture({
    qmdEnabled: false,
    qmdTierMigrationEnabled: true,
    conversationIndexEnabled: true,
    conversationIndexBackend: "qmd",
  });

  const report = await runOperatorDoctor({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  const configReviewCheck = report.checks.find((check) => check.key === "config_review");
  assert.equal(report.ok, false);
  assert.ok(configReviewCheck);
  assert.equal(configReviewCheck?.status, "error");
});

test("operator doctor warns on config discovery misses when the runtime config is otherwise healthy", async () => {
  const fixture = await makeFixture({
    qmdEnabled: true,
  });
  const originalConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = path.join(os.tmpdir(), "missing-openclaw-config.json");

  try {
    const report = await runOperatorDoctor({
      orchestrator: fixture.orchestrator,
    });

    const configCheck = report.checks.find((check) => check.key === "config");
    const configReviewCheck = report.checks.find((check) => check.key === "config_review");
    assert.equal(report.ok, true);
    assert.ok(configCheck);
    assert.ok(configReviewCheck);
    assert.equal(configCheck?.status, "warn");
    assert.equal(configReviewCheck?.status, "warn");
  } finally {
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = originalConfigPath;
    }
  }
});

test("operator doctor omits qmd and auth remediation when those checks are healthy", async () => {
  const fixture = await makeFixture({
    qmdEnabled: true,
    agentAccessHttp: { enabled: true, authToken: "token", port: 8765 },
  });
  fixture.orchestrator.qmd = {
    async probe() {
      return true;
    },
    isAvailable() {
      return true;
    },
    async ensureCollection() {
      return "present";
    },
    debugStatus() {
      return "available";
    },
  };

  const report = await runOperatorDoctor({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  const qmdCheck = report.checks.find((check) => check.key === "qmd");
  const authCheck = report.checks.find((check) => check.key === "access_http_auth");
  assert.ok(qmdCheck);
  assert.ok(authCheck);
  assert.equal(qmdCheck?.status, "ok");
  assert.equal(qmdCheck?.remediation, undefined);
  assert.equal(authCheck?.status, "ok");
  assert.equal(authCheck?.remediation, undefined);
});

test("operator doctor surfaces native knowledge sync state counts", async () => {
  const fixture = await makeFixture({
    nativeKnowledge: {
      enabled: true,
      includeFiles: ["MEMORY.md"],
      obsidianVaults: [{ vaultId: "ops", rootDir: "/vaults/ops" }],
      openclawWorkspace: {
        enabled: true,
        bootstrapFiles: ["IDENTITY.md"],
        handoffGlobs: ["handoffs/**/*.md"],
        dailySummaryGlobs: ["summaries/**/*.md"],
        automationNoteGlobs: ["automations/**/*.md"],
        workspaceDocGlobs: ["docs/**/*.md"],
        excludeGlobs: [],
        sharedSafeGlobs: [],
      },
    },
  });
  const nativeKnowledge = fixture.config.nativeKnowledge;
  assert(nativeKnowledge, "expected nativeKnowledge config");

  const obsidianStatePath = resolveNativeKnowledgeStatePath(fixture.memoryDir, nativeKnowledge);
  const curatedStatePath = resolveCuratedIncludeFilesStatePath(fixture.memoryDir, nativeKnowledge);
  await mkdir(path.dirname(curatedStatePath), { recursive: true });
  await writeFile(curatedStatePath, JSON.stringify({
    version: 1,
    updatedAt: "2026-03-10T09:55:00.000Z",
    files: {
      "MEMORY.md": { deleted: false, chunks: [{ id: 1 }] },
    },
  }, null, 2), "utf-8");
  await mkdir(path.dirname(obsidianStatePath), { recursive: true });
  await writeFile(obsidianStatePath, JSON.stringify({
    version: 1,
    updatedAt: "2026-03-10T10:00:00.000Z",
    vaults: {
      ops: {
        vaultId: "ops",
        rootDir: "/vaults/ops",
        syncedAt: "2026-03-10T10:00:00.000Z",
        notes: {
          "Launch.md": { deleted: false, chunks: [{ id: 1 }, { id: 2 }] },
          "Old.md": { deleted: true, chunks: [] },
        },
      },
    },
  }, null, 2), "utf-8");

  const openclawStatePath = resolveOpenClawWorkspaceStatePath(fixture.memoryDir, nativeKnowledge);
  await writeFile(openclawStatePath, JSON.stringify({
    version: 1,
    updatedAt: "2026-03-10T10:05:00.000Z",
    files: {
      "handoffs/api-rollout.md": { deleted: false, chunks: [{ id: 1 }] },
      "handoffs/old.md": { deleted: true, chunks: [] },
    },
  }, null, 2), "utf-8");

  const report = await runOperatorDoctor({
    orchestrator: fixture.orchestrator,
    configPath: fixture.configPath,
  });

  const nativeKnowledgeCheck = report.checks.find((check) => check.key === "native_knowledge");
  assert.ok(nativeKnowledgeCheck);
  assert.equal(nativeKnowledgeCheck?.status, "ok");
  assert.match(nativeKnowledgeCheck?.summary ?? "", /4 active chunks/);
  assert.equal((nativeKnowledgeCheck?.details as any).curatedIncludeSync.fileCount, 1);
  assert.equal((nativeKnowledgeCheck?.details as any).obsidianSync.vaultCount, 1);
  assert.equal((nativeKnowledgeCheck?.details as any).openclawWorkspaceSync.deletedFileCount, 1);
});

test("operator inventory summarizes stored memories and profile footprint", async () => {
  const fixture = await makeFixture();
  const storage = new StorageManager(fixture.memoryDir);
  await storage.ensureDirectories();
  await storage.writeProfile("# Profile\n\nPrefers concise responses.\n");
  await storage.writeMemory("fact", "API limit is 1000 rpm.", { tags: ["api"] });
  await storage.writeMemory("decision", "Use FAISS for local conversation index.", { tags: ["search"] });
  const memories = await storage.readAllMemories();
  const fact = memories.find((memory) => memory.frontmatter.category === "fact");
  assert.ok(fact);
  await storage.writeMemoryFrontmatter(fact!, {
    status: "pending_review",
    updated: "2026-03-10T00:00:00.000Z",
  });
  await storage.writeEntity("project openclaw", "project", ["Tracks roadmap progress."]);

  const report = await runOperatorInventory({ orchestrator: fixture.orchestrator });

  assert.equal(report.totals.memories, 2);
  assert.equal(report.totals.entities, 1);
  assert.equal(report.categories.fact, 1);
  assert.equal(report.categories.decision, 1);
  assert.equal(report.statuses.pending_review, 1);
  assert.equal(report.profile.exists, true);
  assert.ok(report.storageFootprint.bytes > 0);
});

test("operator inventory includes native knowledge sync counts", async () => {
  const fixture = await makeFixture({
    nativeKnowledge: {
      enabled: true,
      includeFiles: ["MEMORY.md"],
      openclawWorkspace: {
        enabled: true,
        bootstrapFiles: ["IDENTITY.md"],
        handoffGlobs: ["handoffs/**/*.md"],
        dailySummaryGlobs: ["summaries/**/*.md"],
        automationNoteGlobs: ["automations/**/*.md"],
        workspaceDocGlobs: ["docs/**/*.md"],
        excludeGlobs: [],
        sharedSafeGlobs: [],
      },
    },
  });
  const nativeKnowledge = fixture.config.nativeKnowledge;
  assert(nativeKnowledge, "expected nativeKnowledge config");

  const openclawStatePath = resolveOpenClawWorkspaceStatePath(fixture.memoryDir, nativeKnowledge);
  const curatedStatePath = resolveCuratedIncludeFilesStatePath(fixture.memoryDir, nativeKnowledge);
  await mkdir(path.dirname(openclawStatePath), { recursive: true });
  await writeFile(curatedStatePath, JSON.stringify({
    version: 1,
    updatedAt: "2026-03-10T10:55:00.000Z",
    files: {
      "MEMORY.md": { deleted: false, chunks: [{ id: 1 }] },
      "IDENTITY.shared.md": { deleted: true, chunks: [] },
    },
  }, null, 2), "utf-8");
  await writeFile(openclawStatePath, JSON.stringify({
    version: 1,
    updatedAt: "2026-03-10T11:00:00.000Z",
    files: {
      "handoffs/api-rollout.md": { deleted: false, chunks: [{ id: 1 }, { id: 2 }] },
      "handoffs/old.md": { deleted: true, chunks: [] },
    },
  }, null, 2), "utf-8");

  const report = await runOperatorInventory({ orchestrator: fixture.orchestrator });

  assert.equal(report.nativeKnowledge.enabled, true);
  assert.equal(report.nativeKnowledge.curatedIncludeSync.exists, true);
  assert.equal(report.nativeKnowledge.curatedIncludeSync.activeChunkCount, 1);
  assert.equal(report.nativeKnowledge.curatedIncludeSync.deletedFileCount, 1);
  assert.equal(report.nativeKnowledge.openclawWorkspaceSync.exists, true);
  assert.equal(report.nativeKnowledge.openclawWorkspaceSync.activeChunkCount, 2);
  assert.equal(report.nativeKnowledge.openclawWorkspaceSync.deletedFileCount, 1);
});

test("operator inventory fail-opens when a top-level storage directory is unreadable", async () => {
  const fixture = await makeFixture();
  const storage = new StorageManager(fixture.memoryDir);
  await storage.ensureDirectories();
  const artifactDir = path.join(fixture.memoryDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, "kept.txt"), "artifact", "utf-8");
  await chmod(artifactDir, 0o000);

  try {
    const report = await runOperatorInventory({ orchestrator: fixture.orchestrator });
    assert.equal(report.storageFootprint.byTopLevel.artifacts ?? 0, 0);
  } finally {
    await chmod(artifactDir, 0o755);
  }
});

test("operator inventory fail-opens when the latest governance run artifacts are incomplete", async () => {
  const fixture = await makeFixture();
  const brokenRunDir = path.join(
    fixture.memoryDir,
    "state",
    "memory-governance",
    "runs",
    "gov-2026-03-10T00-00-00-000Z",
  );
  await mkdir(brokenRunDir, { recursive: true });
  await writeFile(path.join(brokenRunDir, "summary.json"), "{\"schemaVersion\":1}", "utf-8");

  const report = await runOperatorInventory({ orchestrator: fixture.orchestrator });

  assert.equal(report.totals.reviewQueue, 0);
});

test("benchmark recall validates benchmark packs through the grouped operator flow", async () => {
  const fixture = await makeFixture({ evalHarnessEnabled: true });
  const packDir = path.join(fixture.root, "benchmark-pack");
  await mkdir(packDir, { recursive: true });
  await writeFile(path.join(packDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    benchmarkId: "ama-memory",
    title: "AMA memory pack",
    cases: [
      {
        id: "case-1",
        prompt: "Recover the last deployment decision.",
      },
    ],
  }, null, 2), "utf-8");

  const report = await runBenchmarkRecall({
    config: {
      memoryDir: fixture.config.memoryDir,
      evalStoreDir: fixture.config.evalStoreDir,
      evalHarnessEnabled: fixture.config.evalHarnessEnabled,
      evalShadowModeEnabled: fixture.config.evalShadowModeEnabled,
      benchmarkBaselineSnapshotsEnabled: fixture.config.benchmarkBaselineSnapshotsEnabled,
      benchmarkDeltaReporterEnabled: fixture.config.benchmarkDeltaReporterEnabled,
      memoryRedTeamBenchEnabled: fixture.config.memoryRedTeamBenchEnabled,
    },
    validatePath: packDir,
  });

  assert.equal(report.mode, "validate");
  assert.equal(report.validate?.benchmarkId, "ama-memory");
  assert.equal(report.validate?.totalCases, 1);
});

test("operator repair aggregates dry-run session repair and graph guidance", async () => {
  const fixture = await makeFixture({
    transcriptEnabled: true,
    entityGraphEnabled: true,
  });
  const transcriptDir = path.join(fixture.memoryDir, "transcripts", "main", "default");
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, "2026-03-10.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        timestamp: "2026-03-10T00:00:00.000Z",
        role: "user",
        content: "hello",
        sessionKey: "agent:main",
        turnId: "turn-1",
      }),
      "not-json",
    ].join("\n"),
    "utf-8",
  );

  const report = await runOperatorRepair({
    config: {
      memoryDir: fixture.config.memoryDir,
      entityGraphEnabled: fixture.config.entityGraphEnabled,
      timeGraphEnabled: fixture.config.timeGraphEnabled,
      causalGraphEnabled: fixture.config.causalGraphEnabled,
      multiGraphMemoryEnabled: fixture.config.multiGraphMemoryEnabled,
      graphWriteSessionAdjacencyEnabled: fixture.config.graphWriteSessionAdjacencyEnabled,
    },
    dryRun: true,
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.sessionRepairApply.applied, false);
  assert.ok(report.sessionRepairPlan.actions.length > 0);
  const after = await readFile(transcriptPath, "utf-8");
  assert.match(after, /not-json/);
});

test("operator doctor warns when security mitigations are disabled", async () => {
  const fixture = await makeFixture();
  const report = await runOperatorDoctor({
    configPath: fixture.configPath,
    orchestrator: fixture.orchestrator,
  });
  const sec = report.checks.find((c) => c.key === "security_mitigations");
  assert.ok(sec, "security_mitigations check should exist");
  assert.equal(sec.status, "warn");
  assert.match(sec.summary, /disabled/);
  assert.ok(sec.remediation, "should have remediation guidance");
});

test("operator doctor reports ok when security mitigations are enabled", async () => {
  const fixture = await makeFixture({
    recallCrossNamespaceBudgetEnabled: true,
    recallAuditAnomalyDetectionEnabled: true,
  });
  const report = await runOperatorDoctor({
    configPath: fixture.configPath,
    orchestrator: fixture.orchestrator,
  });
  const sec = report.checks.find((c) => c.key === "security_mitigations");
  assert.ok(sec, "security_mitigations check should exist");
  assert.equal(sec.status, "ok");
  assert.match(sec.summary, /config enabled/);
  const details = sec.details as Record<string, unknown>;
  assert.equal(details.budgetEnabled, true);
  assert.equal(details.anomalyDetectionEnabled, true);
  assert.equal(details.configOnly, true, "should indicate this is config-only, not enforcement");
  assert.ok(details.budgetConfig, "should include budget config");
  assert.ok(details.anomalyConfig, "should include anomaly config");
});
