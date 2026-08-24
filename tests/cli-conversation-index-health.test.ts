import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import {
  runConversationIndexHealthCliCommand,
  runConversationIndexInspectCliCommand,
  runConversationIndexRebuildCliCommand,
} from "@remnic/core/cli";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("conversation-index-health CLI wrapper returns orchestrator health payload", async () => {
  const expected = {
    enabled: true,
    backend: "qmd" as const,
    status: "ok" as const,
    chunkDocCount: 12,
    lastUpdateAt: "2026-02-27T18:00:00.000Z",
    qmdAvailable: true,
  };

  const result = await runConversationIndexHealthCliCommand({
    conversationIndexCoordinator: {
      async getHealth() {
        return expected;
      },
      async inspect() {
        throw new Error("unused");
      },
      async rebuild() {
        throw new Error("unused");
      },
    },
  });

  assert.deepEqual(result, expected);
});

test("conversation-index-inspect CLI wrapper returns orchestrator inspection payload", async () => {
  const expected = {
    enabled: true,
    backend: "faiss" as const,
    status: "ok" as const,
    available: true,
    indexPath: "/tmp/faiss-index",
    supportsIncrementalUpdate: true,
    chunkDocCount: 3,
    lastUpdateAt: "2026-02-27T18:00:00.000Z",
    metadata: {
      chunkCount: 3,
      hasIndex: true,
      hasMetadata: true,
      hasManifest: true,
    },
  };

  const result = await runConversationIndexInspectCliCommand({
    conversationIndexCoordinator: {
      async getHealth() {
        throw new Error("unused");
      },
      async inspect() {
        return expected;
      },
      async rebuild() {
        throw new Error("unused");
      },
    },
  });

  assert.deepEqual(result, expected);
});

test("conversation-index-rebuild CLI wrapper forwards options", async () => {
  const calls: Array<{ sessionKey?: string; hours?: number; opts?: { embed?: boolean } }> = [];
  const result = await runConversationIndexRebuildCliCommand({
    conversationIndexCoordinator: {
      async getHealth() {
        throw new Error("unused");
      },
      async inspect() {
        throw new Error("unused");
      },
      async rebuild(sessionKey?: string, hours?: number, opts?: { embed?: boolean }) {
        calls.push({ sessionKey, hours, opts });
        return { chunks: 7, skipped: false, embedded: false, rebuilt: true };
      },
    },
  }, {
    sessionKey: "agent:test:main",
    hours: 12,
    embed: true,
  });

  assert.deepEqual(calls, [{
    sessionKey: "agent:test:main",
    hours: 12,
    opts: { embed: true },
  }]);
  assert.deepEqual(result, { chunks: 7, skipped: false, embedded: false, rebuilt: true });
});

async function makeOrchestrator(overrides: Record<string, unknown>): Promise<Orchestrator> {
  const memoryDir = tmpDir("engram-conv-health");
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

test("orchestrator conversation index health reports qmd backend availability", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "qmd",
  });

  (orchestrator as any).conversationQmd = {
    isAvailable: () => true,
  };

  const health = await orchestrator.conversationIndexCoordinator.getHealth();

  assert.equal(health.enabled, true);
  assert.equal(health.backend, "qmd");
  assert.equal(health.status, "ok");
  assert.equal(health.qmdAvailable, true);
  assert.equal(typeof health.chunkDocCount, "number");
});

test("orchestrator conversation index health probes qmd when availability is unknown", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "qmd",
  });

  let probed = 0;
  (orchestrator as any).conversationQmd = {
    isAvailable: () => false,
    async probe() {
      probed += 1;
      return true;
    },
  };

  const health = await orchestrator.conversationIndexCoordinator.getHealth();

  assert.equal(probed, 1);
  assert.equal(health.enabled, true);
  assert.equal(health.backend, "qmd");
  assert.equal(health.status, "ok");
  assert.equal(health.qmdAvailable, true);
});

test("orchestrator conversation index health reports faiss degradation fail-open", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
  });

  (orchestrator as any).conversationFaiss = {
    async health() {
      throw new Error("sidecar unavailable");
    },
  };

  const health = await orchestrator.conversationIndexCoordinator.getHealth();

  assert.equal(health.enabled, true);
  assert.equal(health.backend, "faiss");
  assert.equal(health.status, "degraded");
  assert.equal(health.faiss?.ok, false);
});

test("orchestrator conversation index health reports disabled state", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: false,
    conversationIndexBackend: "qmd",
  });

  const health = await orchestrator.conversationIndexCoordinator.getHealth();

  assert.equal(health.enabled, false);
  assert.equal(health.status, "disabled");
  assert.equal(health.backend, "qmd");
});
