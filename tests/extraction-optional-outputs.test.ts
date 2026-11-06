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
import type { BufferTurn, ExtractionResult, PluginConfig } from "@remnic/core/types";

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

// ---------------------------------------------------------------------------
// Fingerprinted runs through the real optional writers (#3227 review)
// ---------------------------------------------------------------------------

function fingerprintedTurns(content: string): BufferTurn[] {
  const timestamp = new Date(Date.now() - 3_600_000).toISOString();
  return [
    { role: "user", content: `Please remember: ${content}`, timestamp, persistProcessedFingerprint: true },
    { role: "assistant", content: `Noted: ${content}`, timestamp, persistProcessedFingerprint: true },
  ];
}

function runFingerprinted(orchestrator: Orchestrator, content: string) {
  return orchestrator.runExtraction(fingerprintedTurns(content), {
    skipCharThreshold: true,
    skipUserTurnThreshold: true,
    clearBufferAfterExtraction: false,
    bufferKey: content,
  });
}

/** Record when the run commits its processed fingerprint, in `events`. */
function spyFingerprintRecorder(orchestrator: Orchestrator, events: string[]): void {
  // `recordProcessedExtractionFingerprint` is the orchestrator method the
  // extraction coordinator calls through its deps at commit time.
  assert.ok(
    Reflect.set(orchestrator, "recordProcessedExtractionFingerprint", async () => {
      events.push("fingerprint");
    }),
  );
}

test("a fingerprinted reflection-only run writes the reflection before recording the fingerprint", async () => {
  const memoryDir = await makeMemoryDir("remnic-3227-reflection-order-");
  const orchestrator = new Orchestrator(makeConfig(memoryDir, { identityEnabled: true }));
  const events: string[] = [];
  const original = StorageManager.prototype.appendIdentityReflection;
  StorageManager.prototype.appendIdentityReflection = async function (reflection) {
    events.push("write");
    await original.call(this, reflection);
  };
  try {
    stubExtraction(orchestrator, { ...emptyResult(), identityReflection: "I should state uncertainty explicitly." });
    spyFingerprintRecorder(orchestrator, events);

    const result = await runFingerprinted(orchestrator, "state uncertainty explicitly");

    assert.equal(result.status, "completed");
    assert.deepEqual(events, ["write", "fingerprint"]);
    const reflections = await readFile(path.join(memoryDir, "identity", "reflections.md"), "utf-8");
    assert.match(reflections, /state uncertainty explicitly/);
  } finally {
    StorageManager.prototype.appendIdentityReflection = original;
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("a fingerprinted relationship-only run writes both directions before recording the fingerprint", async () => {
  const memoryDir = await makeMemoryDir("remnic-3227-relationship-order-");
  const orchestrator = new Orchestrator(makeConfig(memoryDir, { entityRelationshipsEnabled: true }));
  const events: string[] = [];
  const original = StorageManager.prototype.addEntityRelationship;
  StorageManager.prototype.addEntityRelationship = async function () {
    events.push("write");
  };
  try {
    stubExtraction(orchestrator, {
      ...emptyResult(),
      relationships: [{ source: "Alpha", target: "Beta", label: "depends on" }],
    });
    spyFingerprintRecorder(orchestrator, events);

    const result = await runFingerprinted(orchestrator, "Alpha depends on Beta");

    assert.equal(result.status, "completed");
    assert.deepEqual(events, ["write", "write", "fingerprint"]);
  } finally {
    StorageManager.prototype.addEntityRelationship = original;
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("a failed reflection write leaves the input retryable and a retry persists it", async () => {
  const memoryDir = await makeMemoryDir("remnic-3227-reflection-failure-");
  const orchestrator = new Orchestrator(makeConfig(memoryDir, { identityEnabled: true }));
  const events: string[] = [];
  const original = StorageManager.prototype.appendIdentityReflection;
  let failNext = true;
  StorageManager.prototype.appendIdentityReflection = async function (reflection) {
    if (failNext) {
      failNext = false;
      throw new Error("synthetic reflection I/O failure");
    }
    events.push("write");
    await original.call(this, reflection);
  };
  try {
    const extractCalls = stubExtraction(orchestrator, {
      ...emptyResult(),
      identityReflection: "I should state uncertainty explicitly.",
    });
    spyFingerprintRecorder(orchestrator, events);

    await assert.rejects(runFingerprinted(orchestrator, "retry the reflection"), /synthetic reflection I\/O failure/);
    assert.deepEqual(events, [], "a failed reflection write must not record the fingerprint");

    const retry = await runFingerprinted(orchestrator, "retry the reflection");
    assert.equal(retry.status, "completed");
    assert.equal(extractCalls(), 2, "the same input is extracted again, not short-circuited as processed");
    assert.deepEqual(events, ["write", "fingerprint"]);
    const reflections = await readFile(path.join(memoryDir, "identity", "reflections.md"), "utf-8");
    assert.match(reflections, /state uncertainty explicitly/);
  } finally {
    StorageManager.prototype.appendIdentityReflection = original;
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("a failed relationship write leaves the input retryable instead of recording the fingerprint", async () => {
  const memoryDir = await makeMemoryDir("remnic-3227-relationship-failure-");
  const orchestrator = new Orchestrator(makeConfig(memoryDir, { entityRelationshipsEnabled: true }));
  const events: string[] = [];
  const original = StorageManager.prototype.addEntityRelationship;
  let failNext = true;
  StorageManager.prototype.addEntityRelationship = async function () {
    if (failNext) {
      failNext = false;
      throw new Error("synthetic relationship I/O failure");
    }
    events.push("write");
  };
  try {
    const extractCalls = stubExtraction(orchestrator, {
      ...emptyResult(),
      relationships: [{ source: "Alpha", target: "Beta", label: "depends on" }],
    });
    spyFingerprintRecorder(orchestrator, events);

    await assert.rejects(runFingerprinted(orchestrator, "retry the relationship"), /synthetic relationship I\/O failure/);
    assert.deepEqual(events, [], "a failed relationship write must not record the fingerprint");

    const retry = await runFingerprinted(orchestrator, "retry the relationship");
    assert.equal(retry.status, "completed");
    assert.equal(extractCalls(), 2, "the same input is extracted again, not short-circuited as processed");
    assert.deepEqual(events, ["write", "write", "fingerprint"]);
  } finally {
    StorageManager.prototype.addEntityRelationship = original;
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});
