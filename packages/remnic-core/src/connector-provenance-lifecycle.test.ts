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
import { bufferTurnsEqual, copyBufferTurn } from "./buffer-turn-helpers.js";
import {
  ExtractionRunCoordinator,
  type ExtractionRunCoordinatorDeps,
  deriveSourceConnector,
} from "./orchestration/extraction-run.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./orchestration/turn-ingestion.js";
import { StorageManager } from "./storage.js";
import { hashAccessIdempotencyPayload } from "./access-idempotency.js";
import { ExtractionEngine } from "./extraction.js";
import type { ThreadingManager } from "./threading.js";
import type { BufferTurn, ExtractionResult, PluginConfig } from "./types.js";
import { parseConfig } from "./config.js";
import { resolveSourceConnector } from "./source-agent-qualifier.js";
import type { FallbackLlmOptions } from "./fallback-llm.js";
import { handleCodingDecision } from "./coding/decision-surfaces.js";
import type { DecisionSurfaceContext } from "./coding/decision-surfaces.js";

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
        originRole: "tool",
      },
    ]);

    assert.ok(capturedTurns.length > 0, "ingestReplayBatch must pass turns to queueBufferedExtraction");
    assert.equal(
      capturedTurns[0].sourceConnector,
      "chatgpt",
      "ingestReplayBatch must preserve sourceConnector on rebuilt BufferTurn"
    );
    assert.equal(
      capturedTurns[0].originRole,
      "tool",
      "ingestReplayBatch must preserve the authenticated originRole so origin authority fences tool content"
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
          extract: async (turns: BufferTurn[]): Promise<ExtractionResult> => ({
            facts: [{ content: "test fact", category: "fact", confidence: 0.8, tags: [] }],
            entities: [],
            questions: [],
            profileUpdates: [],
            sourceConnector: resolveSourceConnector(turns),
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
        ): Promise<{ persistedIds: string[]; memoryPathById: Map<string, string> }> => {
          spy(sourceContext);
          return { persistedIds: ["fact-1"], memoryPathById: new Map() };
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

test("runExtraction: context-only turns without sourceConnector do not affect attribution", async () => {
  // QMnY3: deriveSourceConnector was called on the full turns array including
  // extractionContextOnly turns. Context-only turns without sourceConnector
  // caused deriveSourceConnector to return undefined (mixed tagged+untagged)
  // even when every contributing turn shared one connector.
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-ctx-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();
    const config = makeMinimalConfig();
    const buffer = new SmartBuffer(config, storage);
    await buffer.load();

    let capturedConnector: string | undefined = "SENTINEL";
    const coordinator = new ExtractionRunCoordinator({
      config,
      getBuffer: () => buffer,
      getExtraction: () => ({
        extract: async (turns: BufferTurn[]): Promise<ExtractionResult> => ({
          facts: [{ content: "test fact", category: "fact", confidence: 0.8, tags: [] }],
          entities: [],
          questions: [],
          profileUpdates: [],
          sourceConnector: resolveSourceConnector(turns),
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
      ): Promise<{ persistedIds: string[]; memoryPathById: Map<string, string> }> => {
        capturedConnector = sourceContext?.sourceConnector;
        return { persistedIds: ["fact-1"], memoryPathById: new Map() };
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
    });

    // Two real turns with the same connector, plus one context-only turn
    // without sourceConnector. Before the fix, deriveSourceConnector saw
    // the context-only turn as "untagged" and returned undefined.
    await coordinator.runExtraction(
      [
        makeTurn({ content: "hello from chatgpt", sourceConnector: "chatgpt" }),
        makeTurn({ role: "assistant", content: "response", sourceConnector: "chatgpt" }),
        makeTurn({
          content: "context-only background",
          extractionContextOnly: true,
        }),
      ],
      { skipCharThreshold: true, skipUserTurnThreshold: true }
    );
    assert.equal(
      capturedConnector,
      "chatgpt",
      "context-only turns must not cause sourceConnector to be undefined when all contributing turns share a connector"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("StorageManager.writeChunk: sourceConnector preserved on chunk memories", async () => {
  // QMo7g: chunked writes must carry sourceConnector so independently
  // surfaced chunks preserve provenance.
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-chunk-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const parentId = "test-parent-1";
    const chunkId = await storage.writeChunk(parentId, 0, 2, "fact", "First chunk of a large fact", {
      confidence: 0.8,
      tags: ["chunked"],
      source: "chunking",
      sourceConnector: "chatgpt",
    });

    const chunk = await storage.getMemoryById(chunkId);
    if (!chunk) assert.fail("chunk memory must exist");
    assert.equal(
      chunk.frontmatter.sourceConnector,
      "chatgpt",
      "chunk memory must preserve sourceConnector from write options"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("StorageManager.writeMemory: sourceConnector preserved for inline capture path", async () => {
  // QMo7i: OpenClaw inline captures call persistExplicitCapture /
  // queueExplicitCaptureForReview, which both call writeMemory.
  // This test verifies writeMemory accepts and preserves sourceConnector
  // when called with the "openclaw" connector (as the inline capture path does).
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-inline-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory("fact", "inline captured note", {
      sourceConnector: "openclaw",
    });

    const memory = await storage.getMemoryById(id);
    if (!memory) assert.fail("memory must exist");
    assert.equal(
      memory.frontmatter.sourceConnector,
      "openclaw",
      "inline-captured memory must preserve sourceConnector='openclaw'"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("hashAccessIdempotencyPayload: different sourceConnector yields different fingerprint", () => {
  // QMx3S: two writes with identical content but different sourceConnector
  // must produce different idempotency fingerprints so they are not
  // treated as duplicates.
  const base = {
    operation: "memory_store",
    request: {
      schemaVersion: 1,
      content: "test fact",
      category: "fact",
      confidence: 0.8,
      namespace: "default",
      tags: [],
      entityRef: undefined,
      ttl: undefined,
      sourceReason: undefined,
    },
  };
  const withChatgpt = { ...base, request: { ...base.request, sourceConnector: "chatgpt" } };
  const withCodex = { ...base, request: { ...base.request, sourceConnector: "codex-cli" } };
  const noConnector = { ...base, request: { ...base.request, sourceConnector: undefined } };

  const hashChatgpt = hashAccessIdempotencyPayload(withChatgpt);
  const hashCodex = hashAccessIdempotencyPayload(withCodex);
  const hashNone = hashAccessIdempotencyPayload(noConnector);

  assert.notEqual(hashChatgpt, hashCodex, "different connectors must yield different fingerprints");
  assert.notEqual(hashChatgpt, hashNone, "connector vs no-connector must yield different fingerprints");
  assert.notEqual(hashCodex, hashNone, "connector vs no-connector must yield different fingerprints");

  // Same connector + key order must be stable (stableStringify sorts keys)
  const withChatgptReordered = {
    request: { ...base.request, sourceConnector: "chatgpt" },
    operation: "memory_store",
  };
  const hashReordered = hashAccessIdempotencyPayload(withChatgptReordered);
  assert.equal(hashChatgpt, hashReordered, "key order must not affect fingerprint");
});

test("handleCodingDecision: sourceConnector='chatgpt' reaches stored frontmatter", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-decision-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const ctx: DecisionSurfaceContext = {
      codingKnowledge: {
        enabled: true,
        decisionRecords: true,
        architectureCard: false,
        sessionDelta: false,
        architectureCardLlmSummary: false,
        structuralProvider: "none",
        structuralProviderCommand: "",
        codegraphTools: false,
        codegraphDbDir: "",
      },
      getCodingContext: () => ({
        projectId: "test",
        branch: "main",
        rootPath: baseDir,
        defaultBranch: "main",
      }),
      resolveStorage: async () => Object.assign(storage, { namespace: "default" }),
      throwInputError: (msg: string): never => {
        throw new Error(msg);
      },
      sourceConnector: "chatgpt",
    };

    const result = await handleCodingDecision(
      { subcommand: "record", title: "Test Decision", decision: "We adopt SQLite for local dev.", status: "accepted", sessionKey: "s1" },
      ctx
    );

    assert.equal(result.subcommand, "record");
    if (!("memoryId" in result)) assert.fail("expected record result with memoryId");
    const memory = await storage.getMemoryById(result.memoryId);
    if (!memory) assert.fail("decision memory must exist");
    assert.equal(
      memory.frontmatter.sourceConnector,
      "chatgpt",
      "decision record must persist sourceConnector in frontmatter"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("codegraph_manage_adr operation: ctx.sourceConnector forwarded to codegraphTool", async () => {
  // Tests the operation handler directly — no MCP server needed.
  // Proves ctx.sourceConnector reaches service.codegraphTool as the 3rd arg.
  const { codegraphManageAdrOperation } = await import("./access-operations.js");
  let capturedConnector: string | undefined = "SENTINEL";
  const result = await codegraphManageAdrOperation.spec.handler(
    { tool: "manage_adr", subcommand: "record", title: "Test", status: "accepted", sessionKey: "s1" },
    {
      service: {
        codegraphTool: async (_req: unknown, _principal?: string, sourceConnector?: string) => {
          capturedConnector = sourceConnector;
          return { tool: "manage_adr", ok: true, result: { subcommand: "record" } };
        },
      } as never,
      authenticatedPrincipal: "test-user",
      sourceConnector: "chatgpt",
    } as never
  );
  assert.equal(
    capturedConnector,
    "chatgpt",
    "operation handler must forward ctx.sourceConnector='chatgpt' to codegraphTool"
  );
});

test("runExtraction: the Source agent header connector equals the persisted sourceConnector (boundary-drop case)", async () => {
  // One derivation over boundedTurns: a work-layer-dropped UNTAGGED assistant
  // turn must not suppress the connector the model effectively saw, and the
  // value rendered in the header must be the same value persisted.
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-one-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();
    const config = makeMinimalConfig();
    const buffer = new SmartBuffer(config, storage);
    await buffer.load();

    let headerConversation = "";
    let persistedConnector: string | undefined = "SENTINEL";
    const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
    assert.equal(Reflect.set(engine, "fallbackLlm", {
      async parseWithSchemaDetailed<T>(
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
        _schema: { parse: (data: unknown) => T },
        _options?: FallbackLlmOptions,
      ) {
        headerConversation = messages[1]?.content ?? "";
        return {
          modelUsed: "fixture",
          result: { facts: [{ content: "use the search tool", category: "fact", confidence: 0.9, tags: [] }], entities: [], questions: [], profileUpdates: [] } as unknown as T,
        };
      },
    }), true);

    const coordinator = new ExtractionRunCoordinator({
      config,
      getBuffer: () => buffer,
      getExtraction: () => engine,
      getStorageRouter: () => ({ storageFor: async () => storage }),
      getThreading: () => ({ processTurn: async () => "thread-1", updateThreadTitle: async () => {} }),
      persistExtraction: async (_r, _s, _t, sourceContext?) => {
        persistedConnector = sourceContext?.sourceConnector;
        return { persistedIds: ["fact-1"], memoryPathById: new Map() };
      },
      maybeCapturePassiveCorrections: async () => {},
      resolveSelfNamespace: () => "default",
      getCodingContextForSession: () => null,
      applyCodingNamespaceOverlay: (_sk: string, ns: string) => ns,
      boxBuilderFor: () => { throw new Error("unexpected boxBuilderFor"); },
      appendPersistedThreadEpisodes: async () => {},
      maybeScheduleConsolidation: () => {},
      requestQmdMaintenance: () => {},
      runTierMigrationCycle: async () => { throw new Error("unexpected runTierMigrationCycle"); },
      getLastPersistExtractionDeferredCount: () => 0,
      recordProcessedExtractionFingerprint: async () => {},
    });

    await coordinator.runExtraction(
      [
        makeTurn({ content: "Use the search tool.", sourceConnector: "pi" }),
        makeTurn({ role: "assistant", content: "Found it.", sourceConnector: "pi" }),
        // UNTAGGED assistant turn that is entirely work-layer context -> dropped
        // by the work-layer boundary, so it is absent from boundedTurns.
        makeTurn({
          role: "assistant",
          content: "[WORK_LAYER_CONTEXT link_to_memory=false]\ninternal scratch\n[/WORK_LAYER_CONTEXT]",
        }),
      ],
      { skipCharThreshold: true, skipUserTurnThreshold: true }
    );

    const headerMatch = headerConversation.match(/^Source agent: (\S+)/);
    const headerConnector = headerMatch ? headerMatch[1] : undefined;
    assert.equal(headerConnector, "pi", "header names the connector the model saw (boundedTurns)");
    assert.equal(persistedConnector, "pi", "persistence records the same resolved connector");
    assert.equal(headerConnector, persistedConnector, "header connector must equal persisted connector");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("copyBufferTurn and bufferTurnsEqual carry originRole", () => {
  const turn = makeTurn({ content: "tool output", originRole: "tool" });
  const copy = copyBufferTurn(turn);
  assert.equal(copy.originRole, "tool", "extraction snapshots must keep the authenticated origin role");
  assert.equal(bufferTurnsEqual(copy, turn), true);
  assert.equal(
    bufferTurnsEqual(copy, makeTurn({ content: "tool output", originRole: "user" })),
    false,
    "a turn re-attributed to another origin is not the same turn",
  );
});
