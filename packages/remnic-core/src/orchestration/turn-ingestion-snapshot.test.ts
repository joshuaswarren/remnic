import assert from "node:assert/strict";
import test from "node:test";
import { SmartBuffer } from "../buffer.js";
import { parseConfig } from "../config.js";
import type { BufferState, BufferTurn } from "../types.js";
import {
  TurnIngestionCoordinator,
  type TurnIngestionDeps,
} from "./turn-ingestion.js";

class FakeStorage {
  constructor(private readonly initial: BufferState) {}
  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }
  async saveBuffer(_state: BufferState): Promise<void> {}
}

function makeTurn(content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-08-17T00:00:00.000Z",
    sessionKey: "k",
  };
}

test("#2468 extract trigger returns the mutation snapshot", async () => {
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1 }),
    new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0 }) as never,
  );
  const outcome = await buffer.addTurnWithOutcome("k", makeTurn("only"));
  assert.equal(outcome.decision, "extract_batch");
  assert.equal(outcome.extractionTurns?.length, 1);
  assert.equal(outcome.extractionTurns?.[0]?.content, "only");
});

test("#2468 built-in trigger includes retained turns in the snapshot", async () => {
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1 }),
    new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0 }) as never,
  );
  await buffer.retainDeferredTurns("k", [makeTurn("retained")], 10);
  const outcome = await buffer.addTurnWithOutcome("k", makeTurn("live"));
  assert.equal(outcome.decision, "extract_batch");
  assert.deepEqual(
    outcome.extractionTurns?.map((turn) => turn.content),
    ["retained", "live"],
  );
});

test("#2468 processTurn does not adopt a later getTurns() batch", async () => {
  const snapshot = [makeTurn("first")];
  const later = [makeTurn("first"), makeTurn("later")];
  const queued: BufferTurn[][] = [];
  const buffer = {
    addTurnWithOutcome: async () => ({
      decision: "extract_now" as const,
      extractionTurns: snapshot,
    }),
    getTurns: () => later,
  };
  const deps = {
    buffer,
    config: parseConfig({}),
    getStorage: async () => {
      throw new Error("unexpected getStorage");
    },
    bulkImportWriteNamespace: () => "default",
    get extractionQueueCoordinator(): never {
      throw new Error("unexpected extractionQueueCoordinator");
    },
    heartbeatObserverChains: new Map(),
    lcmEngine: null,
    passiveCorrectionDedup: new Set(),
    passiveCorrectionService: () => {
      throw new Error("unexpected passiveCorrectionService");
    },
    passiveCorrectionTelemetry: {
      detected: 0,
      queued: 0,
      autoApplied: 0,
      suppressedReasonCounts: {},
    },
    queueBufferedExtraction: async (turns: BufferTurn[]) => {
      queued.push(turns);
    },
    resolveMemoryIdOrHandle: () => {
      throw new Error("unexpected resolveMemoryIdOrHandle");
    },
    runExtraction: async () => {
      throw new Error("unexpected runExtraction");
    },
    get sessionObserver(): never {
      throw new Error("unexpected sessionObserver");
    },
    shouldQueueExtraction: () => {
      throw new Error("unexpected shouldQueueExtraction");
    },
    get transcript(): never {
      throw new Error("unexpected transcript");
    },
  } as unknown as TurnIngestionDeps;
  await new TurnIngestionCoordinator(deps).processTurn("user", "first", "k");
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.length, 1);
  assert.equal(queued[0]?.[0]?.content, "first");
});
test("#2468 concurrent processTurn first trigger keeps its mutation snapshot", async () => {
  const queued: BufferTurn[][] = [];
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1, bufferSaveDebounceMs: 0 }),
    new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0 }) as never,
  );
  const deps = {
    buffer,
    config: parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1 }),
    getStorage: async () => {
      throw new Error("unexpected getStorage");
    },
    bulkImportWriteNamespace: () => "default",
    get extractionQueueCoordinator(): never {
      throw new Error("unexpected extractionQueueCoordinator");
    },
    heartbeatObserverChains: new Map(),
    lcmEngine: null,
    passiveCorrectionDedup: new Set(),
    passiveCorrectionService: () => {
      throw new Error("unexpected passiveCorrectionService");
    },
    passiveCorrectionTelemetry: {
      detected: 0,
      queued: 0,
      autoApplied: 0,
      suppressedReasonCounts: {},
    },
    queueBufferedExtraction: async (turns: BufferTurn[]) => {
      queued.push(turns);
    },
    resolveMemoryIdOrHandle: () => {
      throw new Error("unexpected resolveMemoryIdOrHandle");
    },
    runExtraction: async () => {
      throw new Error("unexpected runExtraction");
    },
    get sessionObserver(): never {
      throw new Error("unexpected sessionObserver");
    },
    shouldQueueExtraction: () => {
      throw new Error("unexpected shouldQueueExtraction");
    },
    get transcript(): never {
      throw new Error("unexpected transcript");
    },
  } as unknown as TurnIngestionDeps;
  const coordinator = new TurnIngestionCoordinator(deps);
  await Promise.all([
    coordinator.processTurn("user", "alpha", "shared-key"),
    coordinator.processTurn("user", "beta", "shared-key"),
  ]);
  assert.equal(queued.length, 2);
  assert.ok(
    queued.some((batch) => batch.length === 1),
    "the first trigger must extract only its mutation snapshot",
  );
});
