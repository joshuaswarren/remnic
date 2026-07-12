/**
 * Provenance lifecycle tests — scenario matrix from the provenance design doc.
 *
 * Covers: deriveSourceConnector mixed-batch attribution, buffer fingerprint
 * dedupe, replay ingestion connector preservation, frontmatter YAML injection
 * guard, and end-to-end extraction→persistExtraction wiring.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SmartBuffer } from "./buffer.js";
import {
  ExtractionRunCoordinator,
  type ExtractionRunCoordinatorDeps,
  deriveSourceConnector,
} from "./orchestration/extraction-run.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./orchestration/turn-ingestion.js";
import { StorageManager } from "./storage.js";
import type { ExtractionEngine } from "./extraction.js";
import type { ThreadingManager } from "./threading.js";
import type { BufferTurn, ExtractionResult, PluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalConfig(): PluginConfig {
  return {
    memoryDir: "/tmp/prov-test",
    triggerMode: "every_n",
    bufferMaxTurns: 2,
    bufferMaxMinutes: 5,
    highSignalPatterns: [],
    consolidateEveryN: 999,
    maxMemoryTokens: 2000,
    openaiApiKey: "",
    qmdEnabled: false,
  } as unknown as PluginConfig;
}

function makeTurn(overrides: Partial<BufferTurn> = {}): BufferTurn {
  return {
    role: "user",
    content: "test content",
    timestamp: "2026-07-12T00:00:00Z",
    ...overrides,
  } as BufferTurn;
}

// ---------------------------------------------------------------------------
// deriveSourceConnector tests (scenarios 1-4)
// ---------------------------------------------------------------------------

test("deriveSourceConnector: all turns same connector → returns that connector", () => {
  const turns = [makeTurn({ sourceConnector: "chatgpt" }), makeTurn({ role: "assistant", sourceConnector: "chatgpt" })];
  assert.equal(deriveSourceConnector(turns), "chatgpt");
});

test("deriveSourceConnector: mixed tagged+untagged → undefined", () => {
  const turns = [makeTurn({ sourceConnector: "chatgpt" }), makeTurn({ role: "assistant" })];
  assert.equal(deriveSourceConnector(turns), undefined);
});

test("deriveSourceConnector: conflicting connectors → undefined", () => {
  const turns = [
    makeTurn({ sourceConnector: "chatgpt" }),
    makeTurn({ role: "assistant", sourceConnector: "codex-cli" }),
  ];
  assert.equal(deriveSourceConnector(turns), undefined);
});

test("deriveSourceConnector: all untagged → undefined", () => {
  const turns = [makeTurn(), makeTurn({ role: "assistant" })];
  assert.equal(deriveSourceConnector(turns), undefined);
});

// ---------------------------------------------------------------------------
// bufferTurnsEqual via clearAfterExtraction (scenario 11)
// ---------------------------------------------------------------------------

test("bufferTurnsEqual via clearAfterExtraction: different fingerprint → turn NOT cleared", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-fp-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();
    const config = makeMinimalConfig();
    const buffer = new SmartBuffer(config, storage);
    await buffer.load();

    // Buffer contains turnB (fingerprint fp-B). An extraction snapshot
    // claims turnA (same content/timestamp, different fingerprint fp-A)
    // was extracted. Without the turnFingerprint comparison in
    // bufferTurnsEqual, turnA would match turnB and clear it — a live
    // turn that was NOT part of the extraction snapshot.
    const turnA = makeTurn({ content: "hello", turnFingerprint: "fp-A" });
    const turnB = makeTurn({ content: "hello", turnFingerprint: "fp-B" });
    await buffer.addTurn("default", turnB);
    assert.equal(buffer.getTurns("default").length, 1);

    // Pass turnA (not in buffer) as the extraction snapshot.
    // clearAfterExtraction must NOT clear turnB because fingerprints differ.
    await buffer.clearAfterExtraction("default", [turnA]);
    const remaining = buffer.getTurns("default");
    assert.equal(remaining.length, 1, "turnB must survive — its fingerprint differs from the extraction snapshot");
    assert.equal(remaining[0].turnFingerprint, "fp-B");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// StorageManager frontmatter serialization (scenarios 12-13)
// ---------------------------------------------------------------------------

test("StorageManager.writeMemory: connector ID with newline → quoted, no frontmatter injection", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-inject-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const malicious = "evil\nstatus: archived";
    const { id } = await storage.writeMemory("fact", "test", {
      sourceConnector: malicious,
    });

    const memory = await storage.getMemoryById(id);
    if (!memory) assert.fail("memory must exist");
    const fm = memory.frontmatter;
    assert.equal(fm.sourceConnector, malicious, "round-trip must preserve the exact connector value");
    assert.notEqual(fm.status, "archived", "newline in connector must not inject a status: frontmatter key");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("StorageManager.writeMemory: valid connector IDs round-trip correctly", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-valid-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    for (const connector of ["chatgpt", "codex-cli", "omp", "openclaw", "github-copilot"]) {
      const { id } = await storage.writeMemory("fact", `test-${connector}`, {
        sourceConnector: connector,
      });
      const memory = await storage.getMemoryById(id);
      if (!memory) assert.fail(`memory for ${connector} must exist`);
      const fm = memory.frontmatter;
      assert.equal(fm.sourceConnector, connector, `connector '${connector}' must round-trip exactly`);
    }
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ingestReplayBatch sourceConnector preservation (scenario 5)
// ---------------------------------------------------------------------------

test("ingestReplayBatch: sourceConnector preserved through replay ingestion", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-replay-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();
    const config = makeMinimalConfig();
    const buffer = new SmartBuffer(config, storage);
    await buffer.load();

    let capturedTurns: BufferTurn[] = [];
    const deps: TurnIngestionDeps = {
      buffer,
      config,
      getStorage: async () => storage,
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
      queueBufferedExtraction: async (
        turnsToExtract: BufferTurn[],
        _reason: "trigger_mode" | "heartbeat_observer",
        options?: { onTaskSettled?: (error?: unknown) => void }
      ) => {
        capturedTurns = turnsToExtract;
        options?.onTaskSettled?.();
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
    };
    const coordinator = new TurnIngestionCoordinator(deps);

    await coordinator.ingestReplayBatch([
      {
        source: "chatgpt",
        sessionKey: "s1",
        role: "user",
        content: "hello from chatgpt",
        timestamp: "2026-07-12T00:00:00Z",
        sourceConnector: "chatgpt",
      },
    ]);

    assert.ok(capturedTurns.length > 0, "ingestReplayBatch must pass turns to queueBufferedExtraction");
    assert.equal(
      capturedTurns[0].sourceConnector,
      "chatgpt",
      "ingestReplayBatch must preserve sourceConnector on rebuilt BufferTurn"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runExtraction end-to-end: deriveSourceConnector → persistExtraction (scenario 3)
// ---------------------------------------------------------------------------

test("runExtraction: mixed tagged+untagged turns → persistExtraction receives sourceConnector=undefined", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-e2e-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();
    const config = makeMinimalConfig();
    const buffer = new SmartBuffer(config, storage);
    await buffer.load();

    function makeDeps(
      spy: (sourceContext: { sourceConnector?: string } | undefined) => void
    ): ExtractionRunCoordinatorDeps {
      return {
        config,
        getBuffer: () => buffer,
        getExtraction: () => ({
          extract: async (..._args: Parameters<ExtractionEngine["extract"]>): Promise<ExtractionResult> => ({
            facts: [{ content: "test fact", category: "fact", confidence: 0.8, tags: [] }],
            entities: [],
            questions: [],
            profileUpdates: [],
          }),
        }),
        getStorageRouter: () => ({
          storageFor: async () => storage,
        }),
        getThreading: () => ({
          processTurn: async (..._args: Parameters<ThreadingManager["processTurn"]>) => "thread-1",
          updateThreadTitle: async (..._args: Parameters<ThreadingManager["updateThreadTitle"]>) => {},
        }),
        persistExtraction: async (
          _result: ExtractionResult,
          _storage: StorageManager,
          _threadId?: string | null,
          sourceContext?: {
            sessionKey?: string;
            principal?: string;
            validAt?: string;
            sourceConnector?: string;
          }
        ): Promise<string[]> => {
          spy(sourceContext);
          return ["fact-1"];
        },
        maybeCapturePassiveCorrections: async () => {},
        resolveSelfNamespace: () => "default",
        getCodingContextForSession: () => null,
        applyCodingNamespaceOverlay: (_sk: string, ns: string) => ns,
        boxBuilderFor: () => {
          throw new Error("unexpected boxBuilderFor");
        },
        appendPersistedThreadEpisodes: async () => {},
        maybeScheduleConsolidation: () => {},
        requestQmdMaintenance: () => {},
        runTierMigrationCycle: async () => {
          throw new Error("unexpected runTierMigrationCycle");
        },
        getLastPersistExtractionDeferredCount: () => 0,
        recordProcessedExtractionFingerprint: async () => {},
      };
    }

    // Mixed batch: one tagged + one untagged → sourceConnector must be undefined
    let mixedConnector: string | undefined = "SENTINEL";
    const coord1 = new ExtractionRunCoordinator(
      makeDeps((ctx) => {
        mixedConnector = ctx?.sourceConnector;
      })
    );
    await coord1.runExtraction(
      [
        makeTurn({ content: "hello from chatgpt", sourceConnector: "chatgpt" }),
        makeTurn({ role: "assistant", content: "response" }),
      ],
      { skipCharThreshold: true, skipUserTurnThreshold: true }
    );
    assert.equal(mixedConnector, undefined, "mixed batch must produce sourceConnector=undefined");

    // All-same connector batch → sourceConnector must be "chatgpt"
    let sameConnector: string | undefined = "SENTINEL";
    const coord2 = new ExtractionRunCoordinator(
      makeDeps((ctx) => {
        sameConnector = ctx?.sourceConnector;
      })
    );
    await coord2.runExtraction(
      [
        makeTurn({ content: "hello from chatgpt", sourceConnector: "chatgpt" }),
        makeTurn({ role: "assistant", content: "response", sourceConnector: "chatgpt" }),
      ],
      { skipCharThreshold: true, skipUserTurnThreshold: true }
    );
    assert.equal(sameConnector, "chatgpt", "all-same batch must produce sourceConnector='chatgpt'");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});
