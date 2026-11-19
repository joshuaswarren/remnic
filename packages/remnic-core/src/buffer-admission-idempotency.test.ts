import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scopeObserveBufferAdmissionIdempotencyKey } from "./buffer-admission-idempotency.js";
import { SmartBuffer } from "./buffer.js";
import type { BufferStorage } from "./buffer-persistence.js";
import { BufferSessionFiles } from "./storage/buffer-session-files.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./orchestration/turn-ingestion.js";

function plainIo() {
  return {
    read: async (filePath: string) => readFileSync(filePath, "utf8"),
    write: async (filePath: string, content: string) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    },
    append: async (filePath: string, content: string) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      appendFileSync(filePath, content);
    },
  };
}
import { ExtractionQueueCoordinator } from "./orchestration/extraction-queue-coordinator.js";
import { SessionObserverState } from "./session-observer-state.js";
import { TranscriptManager } from "./transcript.js";
import { parseConfig } from "./config.js";
import type { BufferState, BufferTurn, PluginConfig } from "./types.js";
import type { ReplayTurn } from "./replay/types.js";

class FakeStorage {
  saved: BufferState | null = null;
  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.saved ?? { turns: [], lastExtractionAt: null, extractionCount: 0 });
  }
  async saveBuffer(state: BufferState): Promise<void> {
    this.saved = structuredClone(state);
  }
}

function makeConfig(memoryDir: string): PluginConfig {
  return parseConfig({ memoryDir, bufferSaveDebounceMs: 0, bufferMaxSessions: 8, bufferMaxTurnsPerSession: 20 });
}

function turn(content: string, sessionKey = "s1"): BufferTurn {
  return { role: "user", content, timestamp: "2026-11-19T00:00:00.000Z", sessionKey };
}

function depsFor(buffer: SmartBuffer, memoryDir: string): TurnIngestionDeps {
  const unreachable = (n: string): never => { throw new Error(n); };
  return {
    buffer,
    config: makeConfig(memoryDir),
    bulkImportWriteNamespace: () => unreachable("bulkImportWriteNamespace"),
    extractionQueueCoordinator: new ExtractionQueueCoordinator(),
    getStorage: async () => unreachable("getStorage"),
    heartbeatObserverChains: new Map(),
    lcmEngine: null,
    passiveCorrectionDedup: new Set(),
    passiveCorrectionService: () => unreachable("passiveCorrectionService"),
    passiveCorrectionTelemetry: { detected: 0, queued: 0, autoApplied: 0, suppressedReasonCounts: {} },
    queueBufferedExtraction: async () => {},
    resolveMemoryIdOrHandle: (ref) => ref,
    runExtraction: () => unreachable("runExtraction"),
    sessionObserver: new SessionObserverState({ memoryDir, debounceMs: 0, bands: [] }),
    shouldQueueExtraction: () => false,
    transcript: new TranscriptManager(makeConfig(memoryDir)),
  };
}

test("#3368 retry with same admission key does not duplicate buffered turns", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "buf-idem-"));
  const storage = new FakeStorage();
  const buffer = new SmartBuffer(makeConfig(memoryDir), storage, null, { countIngress: false });
  const coordinator = new TurnIngestionCoordinator(depsFor(buffer, memoryDir));
  const replay: ReplayTurn = {
    source: "openclaw",
    sessionKey: "s1",
    role: "user",
    content: "hello durable",
    timestamp: "2026-11-19T00:00:00.000Z",
  };
  const opts = {
    archiveLcm: false,
    extractionMode: "buffered" as const,
    writeNamespaceOverride: "default",
    bufferAdmissionIdempotencyKey: "obs-3368-key",
  };
  await coordinator.ingestReplayBatch([replay], opts);
  const afterFirst = storage.saved?.entries?.s1?.turns.length ?? 0;
  assert.equal(afterFirst, 1);
  await coordinator.ingestReplayBatch([replay], opts);
  const afterSecond = storage.saved?.entries?.s1?.turns.length ?? 0;
  assert.equal(afterSecond, 1);
  assert.equal(storage.saved?.admissionIdempotency?.["obs-3368-key"], 1);
});

test("#3368 different keys keep identical content", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "buf-idem-2-"));
  const storage = new FakeStorage();
  const buffer = new SmartBuffer(makeConfig(memoryDir), storage, null, { countIngress: false });
  const coordinator = new TurnIngestionCoordinator(depsFor(buffer, memoryDir));
  const replay: ReplayTurn = {
    source: "openclaw",
    sessionKey: "s1",
    role: "user",
    content: "same words",
    timestamp: "2026-11-19T00:00:00.000Z",
  };
  const base = { archiveLcm: false, extractionMode: "buffered" as const, writeNamespaceOverride: "default" };
  await coordinator.ingestReplayBatch([replay], { ...base, bufferAdmissionIdempotencyKey: "key-a" });
  await coordinator.ingestReplayBatch([replay], { ...base, bufferAdmissionIdempotencyKey: "key-b" });
  assert.equal(storage.saved?.entries?.s1?.turns.length, 2);
});

test("#3368 scoped client keys do not dedupe across namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "buf-idem-scope-"));
  const storage = new FakeStorage();
  const buffer = new SmartBuffer(makeConfig(memoryDir), storage, null, { countIngress: false });
  const coordinator = new TurnIngestionCoordinator(depsFor(buffer, memoryDir));
  const replay: ReplayTurn = {
    source: "openclaw",
    sessionKey: "s1",
    role: "user",
    content: "scoped",
    timestamp: "2026-11-19T00:00:00.000Z",
  };
  const base = { archiveLcm: false, extractionMode: "buffered" as const, bufferAdmissionIdempotencyKey: "client-key" };
  const keyA = scopeObserveBufferAdmissionIdempotencyKey({
    sessionKey: "s1",
    writeNamespace: "ns-a",
    clientKey: "client-key",
  });
  const keyB = scopeObserveBufferAdmissionIdempotencyKey({
    sessionKey: "s1",
    writeNamespace: "ns-b",
    clientKey: "client-key",
  });
  await coordinator.ingestReplayBatch([replay], { ...base, writeNamespaceOverride: "ns-a", bufferAdmissionIdempotencyKey: keyA });
  await coordinator.ingestReplayBatch([replay], { ...base, writeNamespaceOverride: "ns-b", bufferAdmissionIdempotencyKey: keyB });
  assert.equal(storage.saved?.entries?.s1?.turns.length, 2);
});

test("#3368 observe idempotency keys survive BufferSessionFiles restart", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "buf-idem-files-"));
  const files = new BufferSessionFiles(stateDir, plainIo());
  const storage: BufferStorage = {
    loadBuffer: () => files.load(),
    saveBuffer: (state) => files.reconcile(state),
    saveBufferSession: (key, entry) => files.save(key, entry),
    saveBufferAdmissionIdempotency: (state) => files.saveAdmissionIdempotency(state),
    deleteBufferSession: (key) => files.remove(key),
  };
  const memoryDir = stateDir;
  const buffer = new SmartBuffer(makeConfig(memoryDir), storage, null, { countIngress: false });
  const coordinator = new TurnIngestionCoordinator(depsFor(buffer, memoryDir));
  const replay: ReplayTurn = {
    source: "openclaw",
    sessionKey: "s1",
    role: "user",
    content: "durable",
    timestamp: "2026-11-19T00:00:00.000Z",
  };
  const idemKey = "obs-restart-key";
  await coordinator.ingestReplayBatch([
    replay,
  ], {
    archiveLcm: false,
    extractionMode: "buffered",
    writeNamespaceOverride: "default",
    bufferAdmissionIdempotencyKey: idemKey,
  });
  await buffer.load();
  await coordinator.ingestReplayBatch([replay], {
    archiveLcm: false,
    extractionMode: "buffered",
    writeNamespaceOverride: "default",
    bufferAdmissionIdempotencyKey: idemKey,
  });
  const reloaded = await files.load();
  assert.equal(reloaded.entries?.s1?.turns.length, 1);
  assert.equal(reloaded.admissionIdempotency?.[idemKey], 1);
});
