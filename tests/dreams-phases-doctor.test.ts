/**
 * Tests for the `remnic doctor` Dreams-phases section (issue #678 PR 2/4).
 *
 * Verifies that `runOperatorDoctor` includes a `dreams_phases` check and
 * that `summarizeDreamsPhases` returns the correct per-phase shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { StorageManager } from "@remnic/core/storage";
import {
  runOperatorDoctor,
  summarizeDreamsPhases,
  type OperatorToolkitOrchestrator,
} from "@remnic/core/operator-toolkit";

async function makeFixture(overrides: Record<string, unknown> = {}): Promise<{
  root: string;
  memoryDir: string;
  workspaceDir: string;
  configPath: string;
  config: ReturnType<typeof parseConfig>;
  orchestrator: OperatorToolkitOrchestrator;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-dreams-phases-doctor-"));
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
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        entries: { "openclaw-remnic": { config: rawConfig } },
      },
    }, null, 2),
    "utf-8",
  );
  const orchestrator: OperatorToolkitOrchestrator = {
    config,
    storage: new StorageManager(memoryDir),
    qmd: {
      async probe() { return false; },
      isAvailable() { return false; },
      async ensureCollection() { return "skipped"; },
      debugStatus() { return "disabled"; },
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
        return { chunks: 0, skipped: true, reason: "disabled", embedded: false, rebuilt: false };
      },
    },
  };
  return { root, memoryDir, workspaceDir, configPath, config, orchestrator };
}

// ── summarizeDreamsPhases unit tests ─────────────────────────────────────────

test("summarizeDreamsPhases: returns ok check with expected key", async () => {
  const fixture = await makeFixture();
  const check = await summarizeDreamsPhases(fixture.config);
  assert.equal(check.key, "dreams_phases");
  assert.equal(check.status, "ok");
});

test("summarizeDreamsPhases: details contains all three phase objects", async () => {
  const fixture = await makeFixture();
  const check = await summarizeDreamsPhases(fixture.config);
  assert.ok(check.details && typeof check.details === "object", "details must be an object");
  const details = check.details as Record<string, unknown>;
  assert.ok("lightSleep" in details, "details must have lightSleep");
  assert.ok("rem" in details, "details must have rem");
  assert.ok("deepSleep" in details, "details must have deepSleep");
});

test("summarizeDreamsPhases: lightSleep details include required threshold fields", async () => {
  const fixture = await makeFixture({
    lifecyclePolicyEnabled: true,
    lifecyclePromoteHeatThreshold: 0.6,
    lifecycleStaleDecayThreshold: 0.7,
    lifecycleArchiveDecayThreshold: 0.9,
  });
  const check = await summarizeDreamsPhases(fixture.config);
  const ls = (check.details as Record<string, Record<string, unknown>>)["lightSleep"];
  assert.equal(ls.enabled, true);
  assert.equal(ls.promoteHeatThreshold, 0.6);
  assert.equal(ls.staleDecayThreshold, 0.7);
  assert.equal(ls.archiveDecayThreshold, 0.9);
  assert.ok("lastRun" in ls, "lightSleep details must include lastRun");
});

test("summarizeDreamsPhases: rem details include cadenceMs and threshold fields", async () => {
  const fixture = await makeFixture({
    semanticConsolidationEnabled: true,
    semanticConsolidationIntervalHours: 24,
    semanticConsolidationThreshold: 0.82,
  });
  const check = await summarizeDreamsPhases(fixture.config);
  const rem = (check.details as Record<string, Record<string, unknown>>)["rem"];
  assert.equal(rem.enabled, true);
  assert.equal(rem.cadenceMs, 24 * 3_600_000);
  assert.equal(rem.similarityThreshold, 0.82);
  assert.ok("lastRun" in rem, "rem details must include lastRun");
});

test("summarizeDreamsPhases: deepSleep details include versioning fields", async () => {
  const fixture = await makeFixture({
    versioningEnabled: true,
    versioningMaxPerPage: 25,
  });
  const check = await summarizeDreamsPhases(fixture.config);
  const ds = (check.details as Record<string, Record<string, unknown>>)["deepSleep"];
  assert.equal(ds.enabled, true);
  assert.equal(ds.versioningEnabled, true);
  assert.equal(ds.versioningMaxPerPage, 25);
  assert.ok("lastRun" in ds, "deepSleep details must include lastRun");
});

test("summarizeDreamsPhases: lastRun is null before any maintenance runs", async () => {
  const fixture = await makeFixture();
  const check = await summarizeDreamsPhases(fixture.config);
  const details = check.details as Record<string, Record<string, unknown>>;
  assert.equal(details["lightSleep"].lastRun, null, "lightSleep lastRun null before extraction");
  assert.equal(details["rem"].lastRun, null, "rem lastRun null before consolidation");
  assert.equal(details["deepSleep"].lastRun, null, "deepSleep lastRun null before governance");
});

test("summarizeDreamsPhases: lastRun reflects meta.json when extraction has run", async () => {
  const fixture = await makeFixture();
  // Write a meta.json simulating prior extraction + consolidation.
  const stateDir = path.join(fixture.memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  const fakeExtraction = "2026-04-01T10:00:00.000Z";
  const fakeConsolidation = "2026-04-02T02:00:00.000Z";
  await writeFile(
    path.join(stateDir, "meta.json"),
    JSON.stringify({
      extractionCount: 5,
      lastExtractionAt: fakeExtraction,
      lastConsolidationAt: fakeConsolidation,
      totalMemories: 10,
      totalEntities: 2,
    }),
    "utf-8",
  );
  const check = await summarizeDreamsPhases(fixture.config);
  const details = check.details as Record<string, Record<string, unknown>>;
  assert.equal(details["lightSleep"].lastRun, fakeExtraction);
  assert.equal(details["rem"].lastRun, fakeConsolidation);
});

test("summarizeDreamsPhases: deepSleep lastRun reflects latest governance run manifest when present", async () => {
  const fixture = await makeFixture();
  // Codex P2 on PR 763: the doctor reads the latest governance run manifest
  // under state/memory-governance/runs/<runId>/manifest.json, picking the
  // newest by sorted runId (listMemoryGovernanceRuns returns newest-first).
  const runsDir = path.join(fixture.memoryDir, "state", "memory-governance", "runs");
  const olderRunId = "20260401T100000Z-abc123";
  const newerRunId = "20260403T030000Z-def456";
  const olderCreatedAt = "2026-04-01T10:00:00.000Z";
  const newerCreatedAt = "2026-04-03T03:00:00.000Z";
  await mkdir(path.join(runsDir, olderRunId), { recursive: true });
  await mkdir(path.join(runsDir, newerRunId), { recursive: true });
  await writeFile(
    path.join(runsDir, olderRunId, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, runId: olderRunId, createdAt: olderCreatedAt }),
    "utf-8",
  );
  await writeFile(
    path.join(runsDir, newerRunId, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, runId: newerRunId, createdAt: newerCreatedAt }),
    "utf-8",
  );
  const check = await summarizeDreamsPhases(fixture.config);
  const details = check.details as Record<string, Record<string, unknown>>;
  assert.equal(details["deepSleep"].lastRun, newerCreatedAt, "should pick newest by sorted runId");
});

test("summarizeDreamsPhases: warns when latest governance run manifest is unreadable", async () => {
  const fixture = await makeFixture();
  const runsDir = path.join(fixture.memoryDir, "state", "memory-governance", "runs");
  const runId = "20260403T030000Z-def456";
  await mkdir(path.join(runsDir, runId), { recursive: true });
  await writeFile(path.join(runsDir, runId, "manifest.json"), "{not-json", "utf-8");

  const check = await summarizeDreamsPhases(fixture.config);
  const details = check.details as Record<string, Record<string, unknown>>;
  assert.equal(check.status, "warn");
  assert.match(check.summary, /Could not read latest governance run manifest/);
  assert.match(String(details["deepSleep"].warning), /Could not read latest governance run manifest/);
  assert.equal(details["deepSleep"].lastRun, null);
});

test("summarizeDreamsPhases: new phase keys override legacy thresholds in details", async () => {
  const fixture = await makeFixture({
    lifecyclePromoteHeatThreshold: 0.5,
    dreams: {
      phases: {
        lightSleep: { promoteHeatThreshold: 0.77 },
      },
    },
  });
  const check = await summarizeDreamsPhases(fixture.config);
  const ls = (check.details as Record<string, Record<string, unknown>>)["lightSleep"];
  assert.equal(ls.promoteHeatThreshold, 0.77, "new phase key wins in doctor output");
});

test("summarizeDreamsPhases: summary string mentions all three phases", async () => {
  const fixture = await makeFixture();
  const check = await summarizeDreamsPhases(fixture.config);
  assert.ok(check.summary.includes("lightSleep"), "summary must mention lightSleep");
  assert.ok(check.summary.includes("rem"), "summary must mention rem");
  assert.ok(check.summary.includes("deepSleep"), "summary must mention deepSleep");
});

// ── Integration: runOperatorDoctor includes dreams_phases check ───────────────

test("runOperatorDoctor: includes dreams_phases check", async () => {
  const savedToken = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  try {
    const fixture = await makeFixture();
    const report = await runOperatorDoctor({
      orchestrator: fixture.orchestrator,
      configPath: fixture.configPath,
    });
    const dreamsCheck = report.checks.find((c) => c.key === "dreams_phases");
    assert.ok(dreamsCheck, "doctor report must include a dreams_phases check");
    assert.equal(dreamsCheck.status, "ok");
    assert.ok(
      dreamsCheck.details && typeof dreamsCheck.details === "object",
      "dreams_phases check must have details",
    );
  } finally {
    if (savedToken !== undefined) {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = savedToken;
    }
  }
});

test("runOperatorDoctor: reads encrypted meta through orchestrator storage", async () => {
  const savedToken = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  try {
    const fixture = await makeFixture();
    const key = Buffer.alloc(32, 0x7d);
    fixture.orchestrator.storage.setSecureStoreKey(key, true);
    await fixture.orchestrator.storage.saveMeta({
      extractionCount: 3,
      lastExtractionAt: "2026-04-28T00:00:00.000Z",
      lastConsolidationAt: null,
      totalMemories: 2,
      totalEntities: 1,
      processedExtractionFingerprints: [],
    });

    const report = await runOperatorDoctor({
      orchestrator: fixture.orchestrator,
      configPath: fixture.configPath,
    });
    const maintenance = report.checks.find((c) => c.key === "maintenance");
    assert.equal(maintenance?.status, "ok");
    const dreamsCheck = report.checks.find((c) => c.key === "dreams_phases");
    const details = dreamsCheck?.details as { lightSleep?: { lastRun?: string | null } } | undefined;
    assert.equal(details?.lightSleep?.lastRun, "2026-04-28T00:00:00.000Z");
  } finally {
    if (savedToken !== undefined) {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = savedToken;
    }
  }
});
