/**
 * Optional durable extraction outputs end to end (issue #3227).
 *
 * A result that carries only an identity reflection or only entity
 * relationships used to be judged empty, so persistence never ran and the
 * source turns were cleared. These tests drive the real orchestrator flush
 * path with a stubbed extraction client and assert the writes on disk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { Orchestrator } from "@remnic/core/orchestrator";
import { StorageManager } from "@remnic/core/storage";
import { parseConfig } from "@remnic/core/config";
import type { ExtractionResult, PluginConfig } from "@remnic/core/types";

function makeConfig(memoryDir: string, overrides: Record<string, unknown> = {}): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    triggerMode: "smart",
    bufferMaxTurns: 10,
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    consolidateEveryN: 50,
    initGateTimeoutMs: 1000,
    ...overrides,
  });
}

function stubExtraction(orchestrator: Orchestrator, result: ExtractionResult): () => number {
  let calls = 0;
  (orchestrator as any).extraction = {
    extract: async () => {
      calls += 1;
      return result;
    },
  };
  return () => calls;
}

async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

const REFLECTION = "I should state uncertainty explicitly.";

test("a reflection-only extraction writes the identity reflection to storage (#3227)", async () => {
  const memoryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-3227-reflection-")));
  await mkdir(path.join(memoryDir, "workspace"), { recursive: true });
  const orchestrator = new Orchestrator(makeConfig(memoryDir, { identityEnabled: true }));
  try {
    const extractCalls = stubExtraction(orchestrator, {
      facts: [],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
      identityReflection: REFLECTION,
    } as ExtractionResult);

    await orchestrator.processTurn("user", "Please be explicit when you are unsure.", "session-3227-reflection");
    await orchestrator.flushSession("session-3227-reflection", { reason: "session-command" });

    assert.equal(extractCalls(), 1);
    const reflections = await (orchestrator as any).storage.readIdentityReflections();
    assert.match(reflections ?? "", /state uncertainty explicitly/);
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("a relationship-only extraction sends both relationship directions to the entity writer (#3227)", async () => {
  const memoryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-3227-relationship-")));
  await mkdir(path.join(memoryDir, "workspace"), { recursive: true });
  const orchestrator = new Orchestrator(makeConfig(memoryDir, { entityRelationshipsEnabled: true }));
  // Record durable relationship writes at the storage chokepoint. The entity
  // file round trip itself is covered by the entity-store suites.
  const writes: Array<{ name: string; target: string; label: string }> = [];
  const original = StorageManager.prototype.addEntityRelationship;
  StorageManager.prototype.addEntityRelationship = async function (name, rel) {
    writes.push({ name, target: rel.target, label: rel.label });
  };
  try {
    const extractCalls = stubExtraction(orchestrator, {
      facts: [],
      entities: [],
      relationships: [{ source: "Alpha", target: "Beta", label: "depends on" }],
      questions: [],
      profileUpdates: [],
    } as ExtractionResult);

    await orchestrator.processTurn("user", "Alpha depends on Beta for queueing.", "session-3227-relationship");
    await orchestrator.flushSession("session-3227-relationship", { reason: "session-command" });

    assert.equal(extractCalls(), 1);
    assert.deepEqual(writes, [
      { name: "Alpha", target: "Beta", label: "depends on" },
      { name: "Beta", target: "Alpha", label: "depends on (reverse)" },
    ]);
  } finally {
    StorageManager.prototype.addEntityRelationship = original;
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});
