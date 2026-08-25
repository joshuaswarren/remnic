import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import { createConversationIndexBackend } from "@remnic/core/conversation-index/backend";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function makeOrchestrator(overrides: Record<string, unknown>): Promise<Orchestrator> {
  const memoryDir = tmpDir("engram-conv-index-int");
  const workspaceDir = path.join(memoryDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    sharedContextEnabled: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

test("conversation recall search uses qmd backend when configured", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "qmd",
  });

  let qmdCalls = 0;
  let faissCalls = 0;

  (orchestrator as any).conversationQmd = {
    isAvailable: () => true,
    probe: async () => true,
    ensureCollection: async () => "ready",
    search: async () => {
      qmdCalls += 1;
      return [{ path: "qmd/chunk-1", snippet: "QMD hit", score: 0.7 }];
    },
    update: async () => undefined,
    embed: async () => undefined,
    debugStatus: () => "ready",
  };
  (orchestrator as any).conversationFaiss = {
    searchChunks: async () => {
      faissCalls += 1;
      return [{ path: "faiss/chunk-1", snippet: "FAISS hit", score: 0.9 }];
    },
  };
  (orchestrator as any).conversationIndexBackend = createConversationIndexBackend({
    enabled: true,
    backend: "qmd",
    qmd: (orchestrator as any).conversationQmd,
    collectionDir: path.join(orchestrator.config.memoryDir, "conversation-index"),
  });

  const results = await (orchestrator as any).searchConversationRecallResults("query", 3);
  assert.equal(qmdCalls, 1);
  assert.equal(faissCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "qmd/chunk-1");
});

test("conversation recall search fail-opens for faiss backend errors", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
  });

  (orchestrator as any).conversationFaiss = {
    searchChunks: async () => {
      throw new Error("boom");
    },
  };

  const results = await (orchestrator as any).searchConversationRecallResults("query", 3);
  assert.deepEqual(results, []);
});

test("faiss backend contract preserves degraded status from sidecar diagnostics", async () => {
  const backend = createConversationIndexBackend({
    enabled: true,
    backend: "faiss",
    faiss: {
      async health() {
        return {
          ok: true,
          status: "degraded" as const,
          indexPath: "/tmp/faiss-index",
          message: "missing manifest",
        };
      },
      async inspect() {
        return {
          ok: true,
          status: "degraded" as const,
          indexPath: "/tmp/faiss-index",
          message: "missing manifest",
          metadata: {
            chunkCount: 0,
            hasIndex: false,
            hasMetadata: false,
            hasManifest: false,
          },
        };
      },
    } as any,
    collectionDir: "/tmp/conversation-index",
  });

  assert.ok(backend);
  const health = await backend.health();
  const inspection = await backend.inspect();
  const init = await backend.initialize();
  assert.equal(health.status, "degraded");
  assert.equal(inspection.status, "degraded");
  assert.equal(inspection.available, false);
  assert.equal(init.logLevel, "warn");
});

test("conversation recall search routes through the shared backend contract when present", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
  });

  let backendSearchCalls = 0;
  let qmdCalls = 0;
  let faissCalls = 0;

  (orchestrator as any).conversationIndexBackend = {
    kind: "faiss",
    async search(query: string, maxResults: number) {
      backendSearchCalls += 1;
      assert.equal(query, "query");
      assert.equal(maxResults, 3);
      return [{ path: "backend/chunk-1", snippet: "Backend hit", score: 0.95 }];
    },
    async update() {
      throw new Error("unused");
    },
    async rebuild() {
      throw new Error("unused");
    },
    async health() {
      throw new Error("unused");
    },
    async inspect() {
      throw new Error("unused");
    },
  };
  (orchestrator as any).conversationQmd = {
    isAvailable: () => true,
    search: async () => {
      qmdCalls += 1;
      return [];
    },
  };
  (orchestrator as any).conversationFaiss = {
    searchChunks: async () => {
      faissCalls += 1;
      return [];
    },
  };

  const results = await (orchestrator as any).searchConversationRecallResults("query", 3);
  assert.equal(backendSearchCalls, 1);
  assert.equal(qmdCalls, 0);
  assert.equal(faissCalls, 0);
  assert.equal(results[0]?.path, "backend/chunk-1");
});

test("conversation recall section formatting stays backend-agnostic", async () => {
  const orchestrator = await makeOrchestrator({ conversationIndexEnabled: true });

  const rows = [
    { path: "chunk/one.md", snippet: "  first snippet  ", score: 0.81234 },
    { path: "chunk/two.md", snippet: "second snippet", score: 0.5 },
  ];

  const formatted = (orchestrator as any).formatConversationRecallSection(rows, 10_000);
  assert.ok(formatted);
  assert.match(formatted, /## Semantic Recall \(Past Conversations\)/);
  assert.match(formatted, /### chunk\/one\.md/);
  assert.match(formatted, /Score: 0\.812/);
  assert.match(formatted, /first snippet/);
  assert.match(formatted, /### chunk\/two\.md/);
  assert.match(formatted, /Score: 0\.500/);
});

test("updateConversationIndex routes writes through FAISS backend when selected", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
    conversationIndexEmbedOnUpdate: true,
  });

  let upsertCalls = 0;
  let qmdCalls = 0;

  (orchestrator as any).transcript = {
    readRecent: async () => [
      {
        timestamp: "2026-02-27T00:00:00.000Z",
        role: "user",
        content: "hello from transcript",
      },
    ],
  };

  const faiss = (orchestrator as any).conversationFaiss;
  assert.ok(faiss);
  faiss.upsertChunks = async (chunks: unknown[]) => {
    upsertCalls += 1;
    return (chunks as unknown[]).length;
  };
  (orchestrator as any).conversationIndexBackend = createConversationIndexBackend({
    enabled: true,
    backend: "faiss",
    faiss,
    collectionDir: path.join(orchestrator.config.memoryDir, "conversation-index"),
  });

  (orchestrator as any).conversationQmd = {
    isAvailable: () => true,
    update: async () => {
      qmdCalls += 1;
    },
    embed: async () => {
      qmdCalls += 1;
    },
  };

  const result = await orchestrator.conversationIndexCoordinator.update("session-a", 24, {
    enforceMinInterval: false,
  });

  assert.equal(upsertCalls, 1);
  assert.equal(qmdCalls, 0);
  assert.equal(result.skipped, false);
  assert.equal(result.embedded, false);
  assert.equal(result.chunks > 0, true);
});

test("updateConversationIndex routes writes through the shared backend contract when present", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
    conversationIndexEmbedOnUpdate: true,
  });

  let backendUpdateCalls = 0;
  let qmdCalls = 0;
  let faissCalls = 0;

  (orchestrator as any).transcript = {
    readRecent: async () => [
      {
        timestamp: "2026-02-27T00:00:00.000Z",
        role: "user",
        content: "hello from transcript",
      },
    ],
  };

  (orchestrator as any).conversationIndexBackend = {
    kind: "faiss",
    async update(chunks: unknown[], options: { embed: boolean }) {
      backendUpdateCalls += 1;
      assert.equal(Array.isArray(chunks), true);
      assert.equal(chunks.length > 0, true);
      assert.equal(options.embed, true);
      return { embedded: false };
    },
    async rebuild() {
      throw new Error("unused");
    },
    async search() {
      throw new Error("unused");
    },
    async health() {
      throw new Error("unused");
    },
    async inspect() {
      throw new Error("unused");
    },
  };
  (orchestrator as any).conversationQmd = {
    isAvailable: () => true,
    update: async () => {
      qmdCalls += 1;
    },
    embed: async () => {
      qmdCalls += 1;
    },
  };
  (orchestrator as any).conversationFaiss = {
    upsertChunks: async () => {
      faissCalls += 1;
      return 1;
    },
  };

  const result = await orchestrator.conversationIndexCoordinator.update("session-b", 24, {
    enforceMinInterval: false,
  });

  assert.equal(backendUpdateCalls, 1);
  assert.equal(qmdCalls, 0);
  assert.equal(faissCalls, 0);
  assert.equal(result.skipped, false);
  assert.equal(result.embedded, false);
});

test("conversation index health routes through the shared backend contract when present", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
  });

  let backendHealthCalls = 0;
  (orchestrator as any).conversationIndexBackend = {
    kind: "faiss",
    async health() {
      backendHealthCalls += 1;
      return {
        enabled: true,
        backend: "faiss",
        status: "ok",
        qmdAvailable: undefined,
        faiss: {
          ok: true,
          status: "ok",
          indexPath: "/tmp/faiss-index",
          message: undefined,
        },
      };
    },
    async search() {
      throw new Error("unused");
    },
    async update() {
      throw new Error("unused");
    },
    async rebuild() {
      throw new Error("unused");
    },
    async inspect() {
      throw new Error("unused");
    },
  };
  (orchestrator as any).conversationFaiss = {
    async health() {
      throw new Error("should not call raw faiss health");
    },
  };

  const health = await orchestrator.conversationIndexCoordinator.getHealth();
  assert.equal(backendHealthCalls, 1);
  assert.equal(health.enabled, true);
  assert.equal(health.backend, "faiss");
  assert.equal(health.status, "ok");
  assert.equal(health.faiss?.indexPath, "/tmp/faiss-index");
});

test("conversation index inspect routes through the shared backend contract when present", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
  });

  let inspectCalls = 0;
  (orchestrator as any).conversationIndexBackend = {
    kind: "faiss",
    async inspect() {
      inspectCalls += 1;
      return {
        backend: "faiss",
        status: "ok",
        available: true,
        indexPath: "/tmp/faiss-index",
        supportsIncrementalUpdate: true,
        metadata: {
          chunkCount: 4,
          hasIndex: true,
          hasMetadata: true,
          hasManifest: true,
        },
      };
    },
    async search() {
      throw new Error("unused");
    },
    async update() {
      throw new Error("unused");
    },
    async rebuild() {
      throw new Error("unused");
    },
    async health() {
      throw new Error("unused");
    },
  };

  const inspection = await orchestrator.conversationIndexCoordinator.inspect();
  assert.equal(inspectCalls, 1);
  assert.equal(inspection.enabled, true);
  assert.equal(inspection.indexPath, "/tmp/faiss-index");
  assert.equal(inspection.metadata.chunkCount, 4);
});

test("rebuildConversationIndex routes through the shared backend contract when present", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
  });

  let rebuildCalls = 0;
  (orchestrator as any).transcript = {
    readRecent: async () => [
      {
        timestamp: "2026-02-27T00:00:00.000Z",
        role: "user",
        content: "rebuild me",
      },
    ],
  };
  (orchestrator as any).conversationIndexBackend = {
    kind: "faiss",
    async rebuild(chunks: unknown[], options: { embed: boolean }) {
      rebuildCalls += 1;
      assert.equal(Array.isArray(chunks), true);
      assert.equal(chunks.length > 0, true);
      assert.equal(options.embed, false);
      return { embedded: false, rebuilt: true };
    },
    async search() {
      throw new Error("unused");
    },
    async update() {
      throw new Error("unused");
    },
    async health() {
      throw new Error("unused");
    },
    async inspect() {
      throw new Error("unused");
    },
  };

  const result = await orchestrator.conversationIndexCoordinator.rebuild(undefined, 24, { embed: false });
  assert.equal(rebuildCalls, 1);
  assert.equal(result.skipped, false);
  assert.equal(result.rebuilt, true);
});
