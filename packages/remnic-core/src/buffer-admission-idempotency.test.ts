import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUFFER_ADMISSION_IDEMPOTENCY_CAP,
  recordBufferedAdmissionIdempotencyKey,
  scopeObserveBufferAdmissionIdempotencyKey,
} from "./buffer-admission-idempotency.js";
import {
  BUFFER_SESSION_DEFER_INTERVAL_MS,
  BUFFER_SESSION_DEFER_MIN_BYTES,
  BufferSessionPersistence,
} from "./buffer-persistence.js";
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
import type { BufferEntryState, BufferState, BufferTurn, PluginConfig } from "./types.js";
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
  const bufferAfterRestart = new SmartBuffer(makeConfig(memoryDir), storage, null, { countIngress: false });
  await bufferAfterRestart.load();
  const coordinatorAfterRestart = new TurnIngestionCoordinator(depsFor(bufferAfterRestart, memoryDir));
  await coordinatorAfterRestart.ingestReplayBatch([replay], {
    archiveLcm: false,
    extractionMode: "buffered",
    writeNamespaceOverride: "default",
    bufferAdmissionIdempotencyKey: idemKey,
  });
  const reloaded = await files.load();
  assert.equal(reloaded.entries?.s1?.turns.length, 1);
  assert.equal(reloaded.admissionIdempotency?.[idemKey], 1);
});

test("#3368 restored idempotency map without order participates in eviction cap", () => {
  const state: BufferState = {
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    admissionIdempotency: { restored: 1 },
  };
  for (let i = 0; i < BUFFER_ADMISSION_IDEMPOTENCY_CAP; i++) {
    recordBufferedAdmissionIdempotencyKey(state, `k${i}`, 1);
  }
  assert.equal(Object.keys(state.admissionIdempotency!).length, BUFFER_ADMISSION_IDEMPOTENCY_CAP);
  assert.equal(state.admissionIdempotency!.restored, undefined);
});

test("#3368 incomplete order array still evicts orphan map keys", () => {
  const state: BufferState = {
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    admissionIdempotency: { restored: 1, orphan: 1 },
    admissionIdempotencyOrder: ["stale-only"],
  };
  for (let i = 0; i < BUFFER_ADMISSION_IDEMPOTENCY_CAP; i++) {
    recordBufferedAdmissionIdempotencyKey(state, `k${i}`, 1);
  }
  assert.equal(Object.keys(state.admissionIdempotency!).length, BUFFER_ADMISSION_IDEMPOTENCY_CAP);
  assert.equal(state.admissionIdempotency!.restored, undefined);
  assert.equal(state.admissionIdempotency!.orphan, undefined);
});

test("#3368 admission idempotency is not persisted while a session write is deferred", async () => {
  class DeferAdmissionStorage {
    readonly writes = new Map<string, number>();
    admissionPersistSaves = 0;
    private initial: BufferState = { turns: [], lastExtractionAt: null, extractionCount: 0 };

    async loadBuffer(): Promise<BufferState> {
      return structuredClone(this.initial);
    }

    async saveBuffer(state: BufferState): Promise<void> {
      this.initial = structuredClone(state);
    }

    async saveBufferSession(key: string, entry: BufferEntryState): Promise<void> {
      this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
      void entry;
    }

    async saveBufferAdmissionIdempotency(state: BufferState): Promise<void> {
      this.admissionPersistSaves++;
      this.initial = { ...this.initial, ...structuredClone(state) };
    }

    async deleteBufferSession(): Promise<void> {}

    isBufferSessionClaimed(): boolean {
      return false;
    }
  }

  const bigEntry = (): BufferEntryState => ({
    turns: [
      {
        role: "user",
        content: "x".repeat(BUFFER_SESSION_DEFER_MIN_BYTES),
        timestamp: "2026-11-19T00:00:00.000Z",
        sessionKey: "big",
      },
    ],
    lastExtractionAt: null,
    extractionCount: 0,
  });

  const storage = new DeferAdmissionStorage();
  const entries = new Map<string, BufferEntryState>([["big", bigEntry()]]);
  const peek = (key: string) => entries.get(key);
  const persistence = new BufferSessionPersistence();
  let now = 1_000;
  const clock = () => now;
  const state: BufferState = {
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    admissionIdempotency: { "obs-key": 1 },
  };

  persistence.markDirty("big");
  await persistence.persist(storage, state, peek, undefined, { now: clock, allowDeferral: true });
  assert.equal(storage.writes.get("big"), 1);

  persistence.markDirty("big");
  persistence.markAdmissionIdempotencyDirty();
  now += 1_000;
  await persistence.persist(storage, state, peek, undefined, { now: clock, allowDeferral: true });
  assert.equal(storage.writes.get("big"), 1, "large session rewrite deferred");
  assert.equal(storage.admissionPersistSaves, 0, "idempotency must not land ahead of deferred turns");
  assert.equal(persistence.hasPending(), true);
});
