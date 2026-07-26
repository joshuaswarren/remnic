import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

function buildConfig(
  memoryDir: string,
  workspaceDir: string,
  nightlyGovernanceCronAutoRegister: boolean,
) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    daySummaryEnabled: false,
    nightlyGovernanceCronAutoRegister,
    factDeduplicationEnabled: false,
    knowledgeIndexEnabled: false,
    conversationIndexEnabled: false,
    localLlmEnabled: false,
  });
}

function stubInitializeDependencies(orchestrator: any) {
  orchestrator.storage = {
    ensureDirectories: async () => {},
    loadAliases: async () => {},
    readAllMemories: async () => [],
    readAllEntityFiles: async () => [],
  };
  orchestrator.relevance = { load: async () => {} };
  orchestrator.negatives = { load: async () => {} };
  orchestrator.lastRecall = { load: async () => {} };
  orchestrator.tierMigrationStatus = { load: async () => {} };
  orchestrator.sessionObserver = { load: async () => {} };
  orchestrator.policyRuntime = { loadRuntimeValues: async () => null };
  orchestrator.transcript = { initialize: async () => {} };
  orchestrator.summarizer = { initialize: async () => {} };
  orchestrator.qmd = {
    probe: async () => false,
    isAvailable: () => false,
    debugStatus: () => "disabled",
  };
  orchestrator.buffer = { load: async () => {} };
}

test("initialize loads aliases before running storage migration", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-alias-before-migration-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-alias-before-migration-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, false));
    stubInitializeDependencies(orchestrator);
    const order: string[] = [];
    orchestrator.storage = {
      ensureDirectories: async () => {
        order.push("ensureDirectories");
      },
      loadAliases: async () => {
        order.push("loadAliases");
      },
      readAllMemories: async () => [],
      readAllEntityFiles: async () => [],
    };

    await orchestrator.initialize();
    await orchestrator.deferredReady;

    assert.deepEqual(order.slice(0, 2), ["loadAliases", "ensureDirectories"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("initialize skips nightly governance cron auto-register unless explicitly enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-nightly-governance-config-off-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-nightly-governance-config-off-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, false));
    stubInitializeDependencies(orchestrator);

    let nightlyCalls = 0;
    orchestrator.maintenanceScheduler.autoRegisterNightlyGovernanceCron = () => {
      nightlyCalls += 1;
      return Promise.resolve();
    };

    await orchestrator.initialize();
    await orchestrator.deferredReady;

    assert.equal(nightlyCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("initialize triggers nightly governance cron auto-register when explicitly enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-nightly-governance-config-on-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-nightly-governance-config-on-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true));
    stubInitializeDependencies(orchestrator);

    let nightlyCalls = 0;
    orchestrator.maintenanceScheduler.autoRegisterNightlyGovernanceCron = () => {
      nightlyCalls += 1;
      return Promise.resolve();
    };

    await orchestrator.initialize();
    await orchestrator.deferredReady;

    assert.equal(nightlyCalls, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("abortDeferredInit stops deferred initialization before cron registration", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-abort-deferred-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-abort-deferred-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true));
    stubInitializeDependencies(orchestrator);

    let nightlyCalls = 0;
    orchestrator.maintenanceScheduler.autoRegisterNightlyGovernanceCron = () => {
      nightlyCalls += 1;
      return Promise.resolve();
    };

    await orchestrator.initialize();
    orchestrator.abortDeferredInit();
    await orchestrator.deferredReady;

    assert.equal(nightlyCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
