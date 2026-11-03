/**
 * The w9C live-data-loss scenario (#3303): when the extraction buffer is at its
 * session-entry cap, the buffered observe used to throw
 * `ReplayAdmissionRefusedError` and drop live turns. The buffer now spills at
 * capacity (`addTurnBounded` returns a spilled outcome) and the coordinator must
 * (a) not throw, and (b) drain the spill on later ingests, queueing extraction
 * for the admitted turns.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../config.js";
import { SmartBuffer } from "../buffer.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps, ReplayAdmissionRefusedError } from "./turn-ingestion.js";
import type { BufferTurn, PluginConfig } from "../types.js";

function makeConfig(): PluginConfig {
  return parseConfig({ memoryDir: "/tmp/turn-capacity-spill-test", defaultNamespace: "default" });
}

function makeTurn(content: string): BufferTurn {
  return { role: "user", content, timestamp: new Date().toISOString() };
}

/** Buffer at its session-entry cap: every addTurnBounded spills (the post-#3303 contract). */
function capacityBuffer(): SmartBuffer {
  const fake: Partial<SmartBuffer> = {
    addTurnBounded: async () => ({ decision: "keep_buffering", spilled: true }),
    drainCaptureSpill: async () => [],
    flushPendingSave: async () => {},
  };
  // SAFETY: the buffered path only calls addTurnBounded, drainCaptureSpill, and
  // flushPendingSave on the buffer; the three-method fake covers exactly that surface.
  return fake as SmartBuffer;
}

function baseDeps(overrides: Partial<TurnIngestionDeps> & Pick<TurnIngestionDeps, "buffer">): TurnIngestionDeps {
  // SAFETY: the buffered path touches only the members listed here (plus the
  // override), never the rest of TurnIngestionDeps.
  return {
    bulkImportWriteNamespace: () => "default",
    config: makeConfig(),
    // SAFETY: the buffered path never touches the extraction queue coordinator.
    extractionQueueCoordinator: {} as TurnIngestionDeps["extractionQueueCoordinator"],
    getStorage: async () => {
      throw new Error("unexpected getStorage");
    },
    heartbeatObserverChains: new Map(),
    lcmEngine: null,
    passiveCorrectionDedup: new Set(),
    passiveCorrectionService: () => {
      throw new Error("unexpected passiveCorrectionService");
    },
    passiveCorrectionTelemetry: { detected: 0, queued: 0, autoApplied: 0, suppressedReasonCounts: {} },
    queueBufferedExtraction: async () => {},
    resolveMemoryIdOrHandle: () => {
      throw new Error("unexpected resolveMemoryIdOrHandle");
    },
    runExtraction: async () => {
      throw new Error("unexpected runExtraction");
    },
    // SAFETY: the buffered path never touches the session observer or the
    // transcript manager; the never-getter pattern documents that contract.
    get sessionObserver(): never {
      throw new Error("unexpected sessionObserver");
    },
    shouldQueueExtraction: () => true,
    get transcript(): never {
      throw new Error("unexpected transcript");
    },
    ...overrides,
  };
}

test("a buffered observe at the entry cap spills the capture instead of throwing (#3303)", async () => {
  const coordinator = new TurnIngestionCoordinator(baseDeps({ buffer: capacityBuffer() }));
  // Before the spill behavior this rejected with ReplayAdmissionRefusedError
  // and the live turns were dropped.
  await coordinator.ingestReplayBatch(
    [{ source: "openclaw", sessionKey: "live-session", role: "user", content: "live turn payload", timestamp: new Date().toISOString() }],
    { archiveLcm: false, extractionMode: "buffered", writeNamespaceOverride: "default" },
  );
});

test("the entry drain queues extraction for admitted spill turns (#3303)", async () => {
  const queued: BufferTurn[][] = [];
  let admitted = [
    {
      bufferKey: "live-session",
      outcome: {
        decision: "keep_buffering" as const,
        extractionTurns: [makeTurn("admitted turn")],
      },
    },
  ];
  // SAFETY: same three-method fake as capacityBuffer; the drain feeds the
  // admitted turn back through the coordinator's extraction queueing.
  const fake: Partial<SmartBuffer> = {
    addTurnBounded: async () => ({ decision: "keep_buffering", spilled: true }),
    drainCaptureSpill: async () => {
      console.log("PROBE fake drain, admitting:", admitted.length);
      const out = admitted;
      admitted = [];
      return out;
    },
    flushPendingSave: async () => {},
  };
  // SAFETY: same three-method fake as capacityBuffer; the drain feeds the
  // admitted turn back through the coordinator's extraction queueing.
  const buffer = fake as SmartBuffer;
  const coordinator = new TurnIngestionCoordinator(
    baseDeps({
      buffer,
      queueBufferedExtraction: async (turns: BufferTurn[]) => {
        queued.push(turns);
      },
    }),
  );
  await coordinator.ingestReplayBatch(
    [{ source: "openclaw", sessionKey: "next-session", role: "user", content: "next payload", timestamp: new Date().toISOString() }],
    { archiveLcm: false, extractionMode: "buffered", writeNamespaceOverride: "default" },
  );
  assert.equal(queued.length, 1, "the admitted spill turn was queued for extraction");
  assert.deepEqual(queued[0].map((t) => t.content), ["admitted turn"]);
});
