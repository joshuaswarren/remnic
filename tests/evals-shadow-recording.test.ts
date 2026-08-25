import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import { getEvalHarnessStatus, recordEvalShadowRecall, type EvalShadowRecallRecord } from "@remnic/core/evals";

async function waitForShadowCount(options: {
  memoryDir: string;
  evalStoreDir: string;
  enabled: boolean;
  shadowModeEnabled: boolean;
  baselineSnapshotsEnabled?: boolean;
  count: number;
}): Promise<Awaited<ReturnType<typeof getEvalHarnessStatus>>> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const status = await getEvalHarnessStatus({
      memoryDir: options.memoryDir,
      evalStoreDir: options.evalStoreDir,
      enabled: options.enabled,
      shadowModeEnabled: options.shadowModeEnabled,
      baselineSnapshotsEnabled: options.baselineSnapshotsEnabled,
    });
    if (status.shadows.total >= options.count || Date.now() >= deadline) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function makeShadowRecord(overrides: Partial<EvalShadowRecallRecord> = {}): EvalShadowRecallRecord {
  return {
    schemaVersion: 1,
    traceId: "trace-001",
    recordedAt: "2026-03-06T10:03:00.000Z",
    sessionKey: "agent:main",
    promptHash: "prompt-hash",
    promptLength: 42,
    retrievalQueryHash: "query-hash",
    retrievalQueryLength: 19,
    recallMode: "full",
    recallResultLimit: 8,
    source: "hot_qmd",
    recalledMemoryCount: 1,
    injected: true,
    contextChars: 120,
    memoryIds: ["mem-1"],
    durationMs: 12,
    ...overrides,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

test("shadow recall recording stays off when eval shadow mode is disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-shadow-off-"));
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: false,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const { id: memoryId } = await orchestrator.storage.writeMemory("fact", "shadow-disabled memory");
  const memory = await orchestrator.storage.getMemoryById(memoryId);
  assert.ok(memory);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: memory!.frontmatter.id,
        path: memory!.path,
        snippet: "shadow-disabled memory",
        score: 0.9,
      },
    ],
    search: async () => [],
  };

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "session-shadow-disabled",
  );
  assert.match(context, /shadow-disabled memory/);

  const status = await waitForShadowCount({
    memoryDir,
    evalStoreDir: cfg.evalStoreDir,
    enabled: cfg.evalHarnessEnabled,
    shadowModeEnabled: cfg.evalShadowModeEnabled,
    baselineSnapshotsEnabled: false,
    count: 0,
  });

  assert.equal(status.shadows.total, 0);
  assert.equal(status.shadows.invalid, 0);
  assert.equal(status.latestShadow, undefined);
});

test("shadow recall recording writes live recall decisions without changing injected context", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-shadow-on-"));
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const { id: memoryId } = await orchestrator.storage.writeMemory("fact", "shadow-recorded memory");
  const memory = await orchestrator.storage.getMemoryById(memoryId);
  assert.ok(memory);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: memory!.frontmatter.id,
        path: memory!.path,
        snippet: "shadow-recorded memory",
        score: 0.9,
      },
    ],
    search: async () => [],
  };

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "session-shadow-recorded",
  );
  assert.match(context, /shadow-recorded memory/);

  const status = await waitForShadowCount({
    memoryDir,
    evalStoreDir: cfg.evalStoreDir,
    enabled: cfg.evalHarnessEnabled,
    shadowModeEnabled: cfg.evalShadowModeEnabled,
    baselineSnapshotsEnabled: false,
    count: 1,
  });

  assert.equal(status.shadows.total, 1);
  assert.equal(status.shadows.invalid, 0);
  assert.equal(status.shadows.latestSessionKey, "session-shadow-recorded");
  assert.ok(status.latestShadow);
  assert.equal(status.latestShadow?.recalledMemoryCount, 1);
  assert.equal(status.latestShadow?.injected, true);
  assert.deepEqual(status.latestShadow?.memoryIds, [memory!.frontmatter.id]);
});

test("shadow recall recording includes no_recall decisions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-shadow-norecall-"));
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const context = await (orchestrator as any).recallInternal(
    "ok",
    "session-shadow-no-recall",
  );
  assert.equal(context, "");

  const status = await waitForShadowCount({
    memoryDir,
    evalStoreDir: cfg.evalStoreDir,
    enabled: cfg.evalHarnessEnabled,
    shadowModeEnabled: cfg.evalShadowModeEnabled,
    baselineSnapshotsEnabled: false,
    count: 1,
  });

  assert.equal(status.shadows.total, 1);
  assert.ok(status.latestShadow);
  assert.equal(status.latestShadow?.sessionKey, "session-shadow-no-recall");
  assert.equal(status.latestShadow?.recallMode, "no_recall");
  assert.equal(status.latestShadow?.source, "none");
  assert.equal(status.latestShadow?.injected, false);
  assert.deepEqual(status.latestShadow?.memoryIds, []);
});

test("recordEvalShadowRecall writes valid records under the dated shadow directory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-shadow-safe-"));
  const evalStoreDir = path.join(memoryDir, "evals");

  const targetPath = await recordEvalShadowRecall({
    memoryDir,
    evalStoreDir,
    record: makeShadowRecord(),
  });

  assert.equal(targetPath, path.join(evalStoreDir, "shadow", "2026-03-06", "trace-001.json"));
  const written = JSON.parse(await readFile(targetPath, "utf8")) as EvalShadowRecallRecord;
  assert.equal(written.traceId, "trace-001");
  assert.equal(written.recordedAt, "2026-03-06T10:03:00.000Z");
});

test("recordEvalShadowRecall rejects path traversal in shadow path components", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-shadow-traversal-"));
  const evalStoreDir = path.join(memoryDir, "evals");
  const escapePath = path.join(memoryDir, "escape.json");

  await assert.rejects(
    () =>
      recordEvalShadowRecall({
        memoryDir,
        evalStoreDir,
        record: makeShadowRecord({ traceId: "../escape" }),
      }),
    /traceId must be a safe path segment/,
  );
  assert.equal(await pathExists(escapePath), false);

  await assert.rejects(
    () =>
      recordEvalShadowRecall({
        memoryDir,
        evalStoreDir,
        record: makeShadowRecord({ recordedAt: "../../escape" }),
      }),
    /recordedAt must be a valid ISO timestamp/,
  );
  assert.equal(await pathExists(path.join(memoryDir, "escape", "trace-001.json")), false);
});
