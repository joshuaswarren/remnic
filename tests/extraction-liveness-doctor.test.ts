/**
 * Tests for the `remnic doctor` extraction-liveness check (issue #2151).
 *
 * Verifies that `runOperatorDoctor` includes an `extraction_liveness` check and
 * that `summarizeExtractionLiveness` warns only when a non-empty buffer's
 * last-successful-extraction watermark is stale or absent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { StorageManager } from "../src/storage.js";
import { runOperatorDoctor, type OperatorToolkitOrchestrator } from "../src/operator-toolkit.js";
import { summarizeExtractionLiveness, type ExtractionBufferSource } from "../src/extraction-liveness.js";
import type { PluginConfig } from "../src/types.js";

async function makeFixture(
  opts: { overrides?: Record<string, unknown>; buffer?: ExtractionBufferSource } = {},
): Promise<{
  root: string;
  memoryDir: string;
  configPath: string;
  config: PluginConfig;
  storage: StorageManager;
  orchestrator: OperatorToolkitOrchestrator;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-extraction-liveness-doctor-"));
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
    ...(opts.overrides ?? {}),
  };
  const config = parseConfig(rawConfig);
  const configPath = path.join(root, "openclaw.json");
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { entries: { "openclaw-remnic": { config: rawConfig } } } }, null, 2),
    "utf-8",
  );
  const storage = new StorageManager(memoryDir);
  const orchestrator: OperatorToolkitOrchestrator = {
    config,
    storage,
    buffer: opts.buffer,
    qmd: {
      async probe() {
        return false;
      },
      isAvailable() {
        return false;
      },
      async ensureCollection() {
        return "skipped";
      },
      debugStatus() {
        return "disabled";
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
        return { chunks: 0, skipped: true, reason: "disabled", embedded: false, rebuilt: false };
      },
    },
  };
  return { root, memoryDir, configPath, config, storage, orchestrator };
}

const staleBuffer: ExtractionBufferSource = {
  async getBufferSnapshot() {
    return { bufferedSessionCount: 4, pendingTurnCount: 20, oldestTurnTimestamp: "2026-01-01T00:00:00.000Z" };
  },
};

// ── summarizeExtractionLiveness unit tests ───────────────────────────────────

test("summarizeExtractionLiveness: ok with the expected key when nothing is buffered", async () => {
  const fixture = await makeFixture();
  const check = await summarizeExtractionLiveness(fixture.config, fixture.storage, undefined);
  assert.equal(check.key, "extraction_liveness");
  assert.equal(check.status, "ok");
  assert.equal(check.remediation, undefined);
  const details = check.details as { degraded: boolean; bufferedSessionCount: number };
  assert.equal(details.degraded, false);
  assert.equal(details.bufferedSessionCount, 0);
});

test("summarizeExtractionLiveness: warns when a non-empty buffer's watermark is absent/stale", async () => {
  const fixture = await makeFixture({ overrides: { extractionLiveness: { staleWindowMs: 1000 } } });
  // No meta.json written → lastExtractionAt is null (never succeeded).
  const check = await summarizeExtractionLiveness(fixture.config, fixture.storage, staleBuffer);
  assert.equal(check.status, "warn");
  assert.ok(check.remediation && check.remediation.length > 0, "a warn carries a remediation hint");
  const details = check.details as { degraded: boolean; bufferedSessionCount: number; pendingTurnCount: number };
  assert.equal(details.degraded, true);
  assert.equal(details.bufferedSessionCount, 4);
  assert.equal(details.pendingTurnCount, 20);
});

test("summarizeExtractionLiveness: ok when the watermark is fresh even with a backlog", async () => {
  const fixture = await makeFixture({ overrides: { extractionLiveness: { staleWindowMs: 3_600_000 } } });
  const stateDir = path.join(fixture.memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "meta.json"),
    JSON.stringify({
      extractionCount: 1,
      lastExtractionAt: new Date().toISOString(),
      lastConsolidationAt: null,
      totalMemories: 0,
      totalEntities: 0,
    }),
    "utf-8",
  );
  const check = await summarizeExtractionLiveness(fixture.config, fixture.storage, staleBuffer);
  assert.equal(check.status, "ok");
});

test("summarizeExtractionLiveness: disabled gate never warns", async () => {
  const fixture = await makeFixture({ overrides: { extractionLiveness: { enabled: false, staleWindowMs: 1000 } } });
  const check = await summarizeExtractionLiveness(fixture.config, fixture.storage, staleBuffer);
  assert.equal(check.status, "ok");
});

// ── Integration: runOperatorDoctor includes extraction_liveness ──────────────

test("runOperatorDoctor: includes an extraction_liveness check reflecting the buffer", async () => {
  const savedToken = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  try {
    const fixture = await makeFixture({
      overrides: { extractionLiveness: { staleWindowMs: 1000 } },
      buffer: staleBuffer,
    });
    const report = await runOperatorDoctor({ orchestrator: fixture.orchestrator, configPath: fixture.configPath });
    const check = report.checks.find((c) => c.key === "extraction_liveness");
    assert.ok(check, "doctor report must include an extraction_liveness check");
    assert.equal(check.status, "warn");
    const details = check.details as { bufferedSessionCount: number; pendingTurnCount: number };
    assert.equal(details.bufferedSessionCount, 4);
    assert.equal(details.pendingTurnCount, 20);
  } finally {
    if (savedToken !== undefined) process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = savedToken;
  }
});
