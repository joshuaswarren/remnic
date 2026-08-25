/**
 * Tests for the `remnic doctor` extraction-liveness check (issue #2151).
 *
 * Verifies that `runOperatorDoctor` includes an `extraction_liveness` check and
 * that `summarizeExtractionLiveness` warns only when a non-empty buffer's
 * last-successful-extraction watermark is stale or absent.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { StorageManager } from "@remnic/core/storage";
import {
  runOperatorDoctor,
  summarizeExtractionLiveness,
  type ExtractionBufferSource,
  type OperatorToolkitOrchestrator,
} from "@remnic/core/operator-toolkit";
import type { PluginConfig } from "@remnic/core/types";

const createdFixtureRoots: string[] = [];
afterEach(async () => {
  // Clean every temp fixture root created during a test (coderabbit review):
  // makeFixture() must not leave global filesystem state behind.
  for (const root of createdFixtureRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

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
  createdFixtureRoots.push(root);
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
  const check = await summarizeExtractionLiveness(
    fixture.config,
    { lastExtractionAt: null, readFailed: false },
    undefined,
  );
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
  const check = await summarizeExtractionLiveness(
    fixture.config,
    { lastExtractionAt: null, readFailed: false },
    staleBuffer,
  );
  assert.equal(check.status, "warn");
  assert.ok(check.remediation && check.remediation.length > 0, "a warn carries a remediation hint");
  const details = check.details as { degraded: boolean; bufferedSessionCount: number; pendingTurnCount: number };
  assert.equal(details.degraded, true);
  assert.equal(details.bufferedSessionCount, 4);
  assert.equal(details.pendingTurnCount, 20);
});

test("summarizeExtractionLiveness: ok when the watermark is fresh even with a backlog", async () => {
  const fixture = await makeFixture({ overrides: { extractionLiveness: { staleWindowMs: 3_600_000 } } });
  const check = await summarizeExtractionLiveness(
    fixture.config,
    { lastExtractionAt: new Date().toISOString(), readFailed: false },
    staleBuffer,
  );
  assert.equal(check.status, "ok");
});

test("summarizeExtractionLiveness: disabled gate never warns", async () => {
  const fixture = await makeFixture({ overrides: { extractionLiveness: { enabled: false, staleWindowMs: 1000 } } });
  const check = await summarizeExtractionLiveness(
    fixture.config,
    { lastExtractionAt: null, readFailed: false },
    staleBuffer,
  );
  assert.equal(check.status, "ok");
});

test("summarizeExtractionLiveness: warns naming the read failure when the buffer snapshot throws (§22)", async () => {
  // Fresh watermark → the ONLY fault is the unreadable buffer, not staleness.
  const fixture = await makeFixture({ overrides: { extractionLiveness: { staleWindowMs: 3_600_000 } } });
  const throwingBuffer: ExtractionBufferSource = {
    async getBufferSnapshot() {
      throw new Error("buffer file corrupt");
    },
  };
  const check = await summarizeExtractionLiveness(
    fixture.config,
    { lastExtractionAt: new Date().toISOString(), readFailed: false },
    throwingBuffer,
  );
  assert.notEqual(check.status, "ok", "an unreadable buffer is not a healthy pipeline");
  assert.equal(check.status, "warn");
  assert.match(check.summary, /unreadable/);
  assert.match(check.summary, /buffer file corrupt/);
  const details = check.details as { degraded: boolean; degradedReason: string | null };
  assert.equal(details.degraded, true);
});

test("summarizeExtractionLiveness: warns naming an aggregate watermark read failure (§22)", async () => {
  const fixture = await makeFixture({ overrides: { extractionLiveness: { staleWindowMs: 3_600_000 } } });
  // Empty buffer: proves the meta-read failure alone drives the degradation.
  const emptyBuffer: ExtractionBufferSource = {
    async getBufferSnapshot() {
      return { bufferedSessionCount: 0, pendingTurnCount: 0, oldestTurnTimestamp: null };
    },
  };
  const check = await summarizeExtractionLiveness(
    fixture.config,
    { lastExtractionAt: null, readFailed: true, readError: "meta.json unreadable" },
    emptyBuffer,
  );
  assert.notEqual(check.status, "ok", "an unreadable watermark is not a healthy pipeline");
  assert.equal(check.status, "warn");
  assert.match(check.summary, /watermark unreadable/);
  assert.match(check.summary, /meta\.json unreadable/);
  const details = check.details as { degraded: boolean };
  assert.equal(details.degraded, true);
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
