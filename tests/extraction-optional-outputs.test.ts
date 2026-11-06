/**
 * Optional durable extraction outputs end to end (issue #3227).
 *
 * A result that carries only an identity reflection or only entity
 * relationships used to be judged empty, so persistence never ran and the
 * source turns were cleared. These tests drive the real orchestrator flush
 * path with a stubbed extraction client and assert the durable writes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { Orchestrator } from "@remnic/core/orchestrator";
import { StorageManager } from "@remnic/core/storage";
import { parseConfig } from "@remnic/core/config";
import type { ExtractionResult, PluginConfig } from "@remnic/core/types";

interface OptionalOutputFlags {
  identityEnabled?: boolean;
  entityRelationshipsEnabled?: boolean;
}

function makeConfig(memoryDir: string, flags: OptionalOutputFlags): PluginConfig {
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
    ...flags,
  });
}

function stubExtraction(orchestrator: Orchestrator, result: ExtractionResult): () => number {
  let calls = 0;
  const stub = {
    extract: async () => {
      calls += 1;
      return result;
    },
  };
  // `extraction` is the orchestrator's private LLM client field, the
  // established offline seam (see orchestrator-characterization.test.ts). The
  // stub implements the only method the extraction run calls.
  assert.ok(Reflect.set(orchestrator, "extraction", stub));
  return () => calls;
}

async function makeMemoryDir(prefix: string): Promise<string> {
  // realpath: Windows hands out 8.3 short temp paths that the storage
  // containment checks compare against resolved paths.
  const memoryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  await mkdir(path.join(memoryDir, "workspace"), { recursive: true });
  return memoryDir;
}

async function cleanupDir(dir: string): Promise<void> {
  // Background best-effort writers can still be finishing while rm runs.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function emptyResult(): ExtractionResult {
  return { facts: [], entities: [], relationships: [], questions: [], profileUpdates: [] };
}

test("a reflection-only extraction writes the identity reflection to storage (#3227)", async () => {
  const memoryDir = await makeMemoryDir("remnic-3227-reflection-");
  const orchestrator = new Orchestrator(makeConfig(memoryDir, { identityEnabled: true }));
  try {
    const extractCalls = stubExtraction(orchestrator, {
      ...emptyResult(),
      identityReflection: "I should state uncertainty explicitly.",
    });

    await orchestrator.processTurn("user", "Please be explicit when you are unsure.", "session-3227-reflection");
    await orchestrator.flushSession("session-3227-reflection", { reason: "session-command" });

    assert.equal(extractCalls(), 1);
    const reflections = await readFile(path.join(memoryDir, "identity", "reflections.md"), "utf-8");
    assert.match(reflections, /state uncertainty explicitly/);
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("a relationship-only extraction sends both relationship directions to the entity writer (#3227)", async () => {
  const memoryDir = await makeMemoryDir("remnic-3227-relationship-");
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
      ...emptyResult(),
      relationships: [{ source: "Alpha", target: "Beta", label: "depends on" }],
    });

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
