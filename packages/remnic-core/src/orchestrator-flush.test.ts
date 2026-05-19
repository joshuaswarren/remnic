import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "./orchestrator.js";
import { parseConfig } from "./config.js";
import type { BufferTurn } from "./types.js";

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-12T12:00:00.000Z",
    sessionKey,
  };
}

test("flushSession queues extraction for the targeted buffered session", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const turns = [makeTurn("thread-a", "remember alpha")];
  let queued: {
    turns: BufferTurn[];
    reason: string;
    options: Record<string, unknown> | undefined;
  } | null = null;

  orchestrator.buffer = {
    getTurns(bufferKey: string) {
      return bufferKey === "thread-a" ? turns : [];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    queuedTurns: BufferTurn[],
    reason: string,
    options?: Record<string, unknown>,
  ) => {
    queued = { turns: queuedTurns, reason, options };
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("thread-a", { reason: "before_reset" });

  assert.ok(queued);
  const queuedCall = queued as {
    turns: BufferTurn[];
    reason: string;
    options: Record<string, unknown> | undefined;
  };
  assert.equal(queuedCall.turns.length, 1);
  assert.equal(queuedCall.reason, "trigger_mode");
  assert.equal(queuedCall.options?.clearBufferAfterExtraction, true);
  assert.equal(queuedCall.options?.skipDedupeCheck, true);
  assert.equal(queuedCall.options?.abortSignal, undefined);
});

test("flushSession is a no-op when the targeted buffer is empty", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let queued = false;

  orchestrator.buffer = {
    getTurns() {
      return [];
    },
  };
  orchestrator.queueBufferedExtraction = async () => {
    queued = true;
  };

  await orchestrator.flushSession("thread-a", { reason: "before_reset" });

  assert.equal(queued, false);
});

test("flushSession forwards abort signals into the queued extraction", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const abortController = new AbortController();
  let queuedOptions: Record<string, unknown> | undefined;

  orchestrator.buffer = {
    getTurns() {
      return [makeTurn("thread-a", "remember alpha")];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    _queuedTurns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedOptions = options;
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("thread-a", {
    reason: "before_reset",
    abortSignal: abortController.signal,
  });

  assert.equal(queuedOptions?.abortSignal, abortController.signal);
});

test("flushSession waits for queued extraction task completion", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let releaseExtraction!: () => void;
  let extractionStarted = false;
  let flushSettled = false;

  orchestrator.buffer = {
    getTurns() {
      return [makeTurn("thread-a", "remember alpha")];
    },
  };
  orchestrator.extractionQueue = [];
  orchestrator.queueProcessing = false;
  orchestrator.runExtraction = async () => {
    extractionStarted = true;
    await new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
  };

  const flushPromise = orchestrator.flushSession("thread-a", {
    reason: "before_reset",
  });
  void flushPromise.then(() => {
    flushSettled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(extractionStarted, true);
  assert.equal(flushSettled, false);

  releaseExtraction();
  await flushPromise;

  assert.equal(flushSettled, true);
});

test("processTurn preserves the original sessionKey on buffered turns", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let capturedTurn: BufferTurn | undefined;
  let capturedBufferKey: string | undefined;

  orchestrator.config = parseConfig({});
  orchestrator.buffer = {
    async addTurn(bufferKey: string, turn: BufferTurn) {
      capturedBufferKey = bufferKey;
      capturedTurn = turn;
      return "keep_buffering";
    },
  };

  await orchestrator.processTurn("user", "remember alpha");

  assert.equal(capturedBufferKey, "default");
  assert.ok(capturedTurn);
  assert.equal(capturedTurn?.sessionKey, undefined);
});

test("processTurn honors an explicit logical buffer key and turn fingerprint", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let capturedTurn: BufferTurn | undefined;
  let capturedBufferKey: string | undefined;

  orchestrator.config = parseConfig({});
  orchestrator.buffer = {
    async addTurn(bufferKey: string, turn: BufferTurn) {
      capturedBufferKey = bufferKey;
      capturedTurn = turn;
      return "keep_buffering";
    },
  };

  await orchestrator.processTurn("assistant", "remember beta", "session-b", {
    bufferKey: "codex-thread:thread-7::principal:cli",
    logicalSessionKey: "codex-thread:thread-7",
    providerThreadId: "thread-7",
    turnFingerprint: "fp-thread-7",
  });

  assert.equal(capturedBufferKey, "codex-thread:thread-7::principal:cli");
  assert.equal(capturedTurn?.sessionKey, "session-b");
  assert.equal(capturedTurn?.logicalSessionKey, "codex-thread:thread-7");
  assert.equal(capturedTurn?.providerThreadId, "thread-7");
  assert.equal(capturedTurn?.turnFingerprint, "fp-thread-7");
});

test("processTurn queues a guarded extraction snapshot from promoted buffer outcomes", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const guardedTurns = [makeTurn("thread-a", "guarded surprising turn")];
  const laterTurns = [makeTurn("thread-a", "post-flush turn")];
  let queuedTurns: BufferTurn[] | undefined;

  orchestrator.config = parseConfig({});
  orchestrator.buffer = {
    async addTurnWithOutcome() {
      return {
        decision: "extract_now",
        extractionTurns: guardedTurns,
      };
    },
    getTurns() {
      return laterTurns;
    },
  };
  orchestrator.queueBufferedExtraction = async (turns: BufferTurn[]) => {
    queuedTurns = turns;
  };

  await orchestrator.processTurn("user", "guarded surprising turn", "thread-a");

  assert.deepEqual(
    queuedTurns?.map((turn) => turn.content),
    ["guarded surprising turn"],
  );
});

test("buildExtractionFingerprint normalizes fallback content like turn fingerprints", () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = parseConfig({});

  const compact = orchestrator.buildExtractionFingerprint(
    [makeTurn("session-b", "Memory saved.")],
    "logical-thread:thread-7",
  );
  const spaced = orchestrator.buildExtractionFingerprint(
    [makeTurn("session-b", "  Memory   saved.\n")],
    "logical-thread:thread-7",
  );

  assert.equal(compact, spaced);
});

test("flushSession honors an explicit bufferKey override", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let queuedBufferKey: string | undefined;

  orchestrator.buffer = {
    async findBufferKeysForSession() {
      throw new Error("flushSession should not discover buffer keys when one is provided");
    },
    getTurns(bufferKey: string) {
      return bufferKey === "codex-thread:thread-11"
        ? [makeTurn("session-z", "remember gamma")]
        : [];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    _queuedTurns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedBufferKey = options?.bufferKey as string | undefined;
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("session-z", {
    reason: "codex_compaction_signal",
    bufferKey: "codex-thread:thread-11",
  });

  assert.equal(queuedBufferKey, "codex-thread:thread-11");
});

test("flushSession falls back to a discovered logical buffer key for the session", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let queuedBufferKey: string | undefined;

  orchestrator.buffer = {
    async findBufferKeysForSession(sessionKey: string) {
      return sessionKey === "session-z"
        ? ["codex-thread:thread-11::principal:cli"]
        : [];
    },
    getTurns(bufferKey: string) {
      return bufferKey === "codex-thread:thread-11::principal:cli"
        ? [makeTurn("session-z", "remember gamma")]
        : [];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    _queuedTurns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedBufferKey = options?.bufferKey as string | undefined;
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("session-z", {
    reason: "session-command",
  });

  assert.equal(queuedBufferKey, "codex-thread:thread-11::principal:cli");
});

test("flushSession drains every discovered buffer for the session", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const queuedBufferKeys: string[] = [];

  orchestrator.buffer = {
    async findBufferKeysForSession(sessionKey: string) {
      return sessionKey === "session-z"
        ? ["session-z", "codex-thread:thread-11::principal:cli"]
        : [];
    },
    getTurns(bufferKey: string) {
      return bufferKey === "session-z" ||
        bufferKey === "codex-thread:thread-11::principal:cli"
        ? [makeTurn("session-z", "remember " + bufferKey)]
        : [];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    _queuedTurns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedBufferKeys.push(options?.bufferKey as string);
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("session-z", {
    reason: "session-command",
  });

  assert.deepEqual(queuedBufferKeys, [
    "session-z",
    "codex-thread:thread-11::principal:cli",
  ]);
});

test("runExtraction skips batches whose persisted fingerprint already exists in storage meta", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  let extractCalls = 0;
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => ({
        extractionCount: 0,
        lastExtractionAt: null,
        lastConsolidationAt: null,
        totalMemories: 0,
        totalEntities: 0,
        processedExtractionFingerprints: [
          {
            fingerprint: orchestrator.buildExtractionFingerprint(
              [
                {
                  ...makeTurn("session-c", "remember delta"),
                  logicalSessionKey: "logical-thread:thread-12",
                  turnFingerprint: "fp-thread-12",
                  persistProcessedFingerprint: true,
                },
              ],
              "logical-thread:thread-12",
            ),
            observedAt: "2026-04-15T00:00:00.000Z",
          },
        ],
      }),
      saveMeta: async () => undefined,
    }),
  };
  orchestrator.extraction = {
    extract: async () => {
      extractCalls += 1;
      return { facts: [], entities: [], questions: [], profileUpdates: [] };
    },
  };

  await orchestrator.runExtraction(
    [
      {
        ...makeTurn("session-c", "remember delta"),
        logicalSessionKey: "logical-thread:thread-12",
        turnFingerprint: "fp-thread-12",
        persistProcessedFingerprint: true,
      },
    ],
    {
      bufferKey: "logical-thread:thread-12",
    },
  );

  assert.equal(extractCalls, 0);
  assert.equal(clearCalls, 1);
});

test("runExtraction preserves deduped buffers when the caller aborts before clearing", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  const abortController = new AbortController();
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => {
        abortController.abort();
        return {
          extractionCount: 0,
          lastExtractionAt: null,
          lastConsolidationAt: null,
          totalMemories: 0,
          totalEntities: 0,
          processedExtractionFingerprints: [
            {
              fingerprint: orchestrator.buildExtractionFingerprint(
                [
                  {
                    ...makeTurn("session-c", "remember delta"),
                    logicalSessionKey: "logical-thread:thread-12",
                    turnFingerprint: "fp-thread-12",
                    persistProcessedFingerprint: true,
                  },
                ],
                "logical-thread:thread-12",
              ),
              observedAt: "2026-04-15T00:00:00.000Z",
            },
          ],
        };
      },
      saveMeta: async () => undefined,
    }),
  };
  orchestrator.extraction = {
    extract: async () => {
      throw new Error("should not extract");
    },
  };

  await assert.rejects(
    orchestrator.runExtraction(
      [
        {
          ...makeTurn("session-c", "remember delta"),
          logicalSessionKey: "logical-thread:thread-12",
          turnFingerprint: "fp-thread-12",
          persistProcessedFingerprint: true,
        },
      ],
      {
        bufferKey: "logical-thread:thread-12",
        abortSignal: abortController.signal,
      },
    ),
    /extraction aborted \(before_clear_buffer\)/,
  );

  assert.equal(clearCalls, 0);
});

test("runExtraction still clears the buffer when fingerprint persistence fails after durable writes", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;
  let clearCalls = 0;
  let persistCalls = 0;
  let fingerprintWrites = 0;
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => ({
        extractionCount: 0,
        lastExtractionAt: null,
        lastConsolidationAt: null,
        totalMemories: 0,
        totalEntities: 0,
        processedExtractionFingerprints: [],
      }),
      saveMeta: async () => undefined,
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({
      facts: [
        {
          content: "remember epsilon",
          category: "fact",
          confidence: 0.9,
          tags: [],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
  orchestrator.persistExtraction = async () => {
    persistCalls += 1;
    return ["fact-1"];
  };
  orchestrator.recordProcessedExtractionFingerprint = async () => {
    fingerprintWrites += 1;
    throw new Error("saveMeta failed");
  };
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.runTierMigrationCycle = async () => undefined;

  await orchestrator.runExtraction(
    [
      {
        ...makeTurn("session-d", "remember epsilon"),
        logicalSessionKey: "logical-thread:thread-13",
        turnFingerprint: "fp-thread-13",
        persistProcessedFingerprint: true,
      },
    ],
    {
      bufferKey: "logical-thread:thread-13",
    },
  );

  assert.equal(persistCalls, 1);
  assert.equal(fingerprintWrites, 1);
  assert.equal(clearCalls, 1);
});

test("runExtraction persists fingerprint and extraction counters through one coherent meta save", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  let loadMetaCalls = 0;
  let saveMetaCalls = 0;
  let savedMeta:
    | {
        extractionCount: number;
        lastExtractionAt: string | null;
        totalMemories: number;
        totalEntities: number;
        processedExtractionFingerprints: Array<{
          fingerprint: string;
          observedAt: string;
        }>;
      }
    | undefined;

  const meta = {
    extractionCount: 0,
    lastExtractionAt: null,
    lastConsolidationAt: null,
    totalMemories: 0,
    totalEntities: 0,
    processedExtractionFingerprints: [] as Array<{
      fingerprint: string;
      observedAt: string;
    }>,
  };

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => {
        loadMetaCalls += 1;
        return meta;
      },
      saveMeta: async (nextMeta: typeof meta) => {
        saveMetaCalls += 1;
        savedMeta = structuredClone(nextMeta);
      },
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({
      facts: [
        {
          content: "remember zeta",
          category: "fact",
          confidence: 0.9,
          tags: [],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
  orchestrator.persistExtraction = async () => ["fact-1"];
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.runTierMigrationCycle = async () => undefined;

  await orchestrator.runExtraction(
    [
      {
        ...makeTurn("session-e", "remember zeta"),
        logicalSessionKey: "logical-thread:thread-14",
        turnFingerprint: "fp-thread-14",
        persistProcessedFingerprint: true,
      },
    ],
    {
      bufferKey: "logical-thread:thread-14",
    },
  );

  assert.equal(loadMetaCalls, 1);
  assert.equal(saveMetaCalls, 1);
  assert.equal(clearCalls, 1);
  assert.equal(savedMeta?.extractionCount, 1);
  assert.equal(savedMeta?.totalMemories, 1);
  assert.equal(savedMeta?.processedExtractionFingerprints.length, 1);
  assert.equal(
    savedMeta?.processedExtractionFingerprints[0]?.fingerprint,
    orchestrator.buildExtractionFingerprint(
      [
        {
          ...makeTurn("session-e", "remember zeta"),
          logicalSessionKey: "logical-thread:thread-14",
          turnFingerprint: "fp-thread-14",
          persistProcessedFingerprint: true,
        },
      ],
      "logical-thread:thread-14",
    ),
  );
});

test("runExtraction loads meta before updating extraction counters when fingerprint persistence is skipped", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  let loadMetaCalls = 0;
  let saveMetaCalls = 0;
  let savedMeta:
    | {
        extractionCount: number;
        lastExtractionAt: string | null;
        totalMemories: number;
        totalEntities: number;
        processedExtractionFingerprints: Array<{
          fingerprint: string;
          observedAt: string;
        }>;
      }
    | undefined;

  const meta = {
    extractionCount: 0,
    lastExtractionAt: null,
    lastConsolidationAt: null,
    totalMemories: 0,
    totalEntities: 0,
    processedExtractionFingerprints: [] as Array<{
      fingerprint: string;
      observedAt: string;
    }>,
  };

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => {
        loadMetaCalls += 1;
        return meta;
      },
      saveMeta: async (nextMeta: typeof meta) => {
        saveMetaCalls += 1;
        savedMeta = structuredClone(nextMeta);
      },
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({
      facts: [
        {
          content: "remember eta",
          category: "fact",
          confidence: 0.9,
          tags: [],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
  orchestrator.persistExtraction = async () => ["fact-1"];
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.runTierMigrationCycle = async () => undefined;

  await orchestrator.runExtraction([makeTurn("session-f", "remember eta")], {
    bufferKey: "logical-thread:thread-15",
  });

  assert.equal(loadMetaCalls, 1);
  assert.equal(saveMetaCalls, 1);
  assert.equal(clearCalls, 1);
  assert.equal(savedMeta?.extractionCount, 1);
  assert.equal(savedMeta?.totalMemories, 1);
  assert.equal(savedMeta?.processedExtractionFingerprints.length, 0);
});

test("runExtraction saves the processed fingerprint before late threading failures", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;
  config.threadingEnabled = true;

  let clearCalls = 0;
  let saveMetaCalls = 0;
  let savedMeta:
    | {
        extractionCount: number;
        lastExtractionAt: string | null;
        totalMemories: number;
        totalEntities: number;
        processedExtractionFingerprints: Array<{
          fingerprint: string;
          observedAt: string;
        }>;
      }
    | undefined;

  const meta = {
    extractionCount: 0,
    lastExtractionAt: null,
    lastConsolidationAt: null,
    totalMemories: 0,
    totalEntities: 0,
    processedExtractionFingerprints: [] as Array<{
      fingerprint: string;
      observedAt: string;
    }>,
  };

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => meta,
      saveMeta: async (nextMeta: typeof meta) => {
        saveMetaCalls += 1;
        savedMeta = structuredClone(nextMeta);
      },
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({
      facts: [
        {
          content: "remember eta",
          category: "fact",
          confidence: 0.9,
          tags: [],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
  orchestrator.persistExtraction = async () => ["fact-1"];
  orchestrator.threading = {
    processTurn: async () => "thread-15",
    appendEpisodeIds: async () => undefined,
    updateThreadTitle: async () => {
      throw new Error("thread title failed");
    },
  };
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.runTierMigrationCycle = async () => undefined;

  await assert.rejects(
    orchestrator.runExtraction(
      [
        {
          ...makeTurn("session-f", "remember eta"),
          logicalSessionKey: "logical-thread:thread-15",
          turnFingerprint: "fp-thread-15",
          persistProcessedFingerprint: true,
        },
      ],
      {
        bufferKey: "logical-thread:thread-15",
      },
    ),
    /thread title failed/,
  );

  assert.equal(saveMetaCalls, 1);
  assert.equal(clearCalls, 1);
  assert.equal(savedMeta?.processedExtractionFingerprints.length, 1);
  assert.equal(
    savedMeta?.processedExtractionFingerprints[0]?.fingerprint,
    orchestrator.buildExtractionFingerprint(
      [
        {
          ...makeTurn("session-f", "remember eta"),
          logicalSessionKey: "logical-thread:thread-15",
          turnFingerprint: "fp-thread-15",
          persistProcessedFingerprint: true,
        },
      ],
      "logical-thread:thread-15",
    ),
  );
});

test("runExtraction clears the buffer even when the post-persist meta save fails", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  let saveMetaCalls = 0;

  const meta = {
    extractionCount: 0,
    lastExtractionAt: null,
    lastConsolidationAt: null,
    totalMemories: 0,
    totalEntities: 0,
    processedExtractionFingerprints: [] as Array<{
      fingerprint: string;
      observedAt: string;
    }>,
  };

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => meta,
      saveMeta: async () => {
        saveMetaCalls += 1;
        throw new Error("meta save failed");
      },
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({
      facts: [
        {
          content: "remember theta",
          category: "fact",
          confidence: 0.9,
          tags: [],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
  orchestrator.persistExtraction = async () => ["fact-1"];
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.runTierMigrationCycle = async () => undefined;

  await assert.rejects(
    orchestrator.runExtraction(
      [
        {
          ...makeTurn("session-g", "remember theta"),
          logicalSessionKey: "logical-thread:thread-16",
          turnFingerprint: "fp-thread-16",
          persistProcessedFingerprint: true,
        },
      ],
      {
        bufferKey: "logical-thread:thread-16",
      },
    ),
    /meta save failed/,
  );

  assert.equal(saveMetaCalls, 1);
  assert.equal(clearCalls, 1);
});

test("runExtraction still runs follow-on extraction helpers when the post-persist meta save fails", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;
  config.memoryBoxesEnabled = true;
  config.threadingEnabled = true;

  let clearCalls = 0;
  let boxCalls = 0;
  let appendCalls = 0;
  let titleCalls = 0;
  let scheduleCalls = 0;
  let qmdCalls = 0;
  let tierCalls = 0;

  const meta = {
    extractionCount: 0,
    lastExtractionAt: null,
    lastConsolidationAt: null,
    totalMemories: 0,
    totalEntities: 0,
    processedExtractionFingerprints: [] as Array<{
      fingerprint: string;
      observedAt: string;
    }>,
  };

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => meta,
      saveMeta: async () => {
        throw new Error("meta save failed");
      },
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({
      facts: [
        {
          content: "remember iota",
          category: "fact",
          confidence: 0.9,
          tags: [],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
  orchestrator.persistExtraction = async () => ["fact-1"];
  orchestrator.threading = {
    processTurn: async () => "thread-17",
    appendEpisodeIds: async () => {
      appendCalls += 1;
    },
    updateThreadTitle: async () => {
      titleCalls += 1;
    },
  };
  orchestrator.boxBuilderFor = () => ({
    onExtraction: async () => {
      boxCalls += 1;
    },
  });
  orchestrator.maybeScheduleConsolidation = () => {
    scheduleCalls += 1;
  };
  orchestrator.requestQmdMaintenance = () => {
    qmdCalls += 1;
  };
  orchestrator.runTierMigrationCycle = async () => {
    tierCalls += 1;
  };
  orchestrator.nonZeroExtractionsSinceConsolidation = 0;

  await assert.rejects(
    orchestrator.runExtraction(
      [
        {
          ...makeTurn("session-h", "remember iota"),
          logicalSessionKey: "logical-thread:thread-17",
          turnFingerprint: "fp-thread-17",
          persistProcessedFingerprint: true,
        },
      ],
      {
        bufferKey: "logical-thread:thread-17",
      },
    ),
    /meta save failed/,
  );

  assert.equal(clearCalls, 1);
  assert.equal(boxCalls, 1);
  assert.equal(appendCalls, 1);
  assert.equal(titleCalls, 1);
  assert.equal(scheduleCalls, 1);
  assert.equal(qmdCalls, 1);
  assert.equal(tierCalls, 1);
});

test("runExtraction aborts before late buffer clearing when the caller cancels", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  let persistCalls = 0;
  let resolveExtract!: (value: {
    facts: [];
    entities: [];
    questions: [];
    profileUpdates: [];
  }) => void;
  const extractPromise = new Promise<{
    facts: [];
    entities: [];
    questions: [];
    profileUpdates: [];
  }>((resolve) => {
    resolveExtract = resolve;
  });

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => ({
        extractionCount: 0,
        lastExtractionAt: null,
        totalMemories: 0,
        totalEntities: 0,
      }),
      saveMeta: async () => undefined,
    }),
  };
  orchestrator.extraction = {
    extract: async () => extractPromise,
  };
  orchestrator.persistExtraction = async () => {
    persistCalls += 1;
    return [];
  };

  const abortController = new AbortController();
  const runPromise = orchestrator.runExtraction(
    [makeTurn("thread-a", "remember alpha")],
    {
      bufferKey: "thread-a",
      abortSignal: abortController.signal,
    },
  );

  abortController.abort();
  resolveExtract({
    facts: [],
    entities: [],
    questions: [],
    profileUpdates: [],
  });

  await assert.rejects(runPromise, /extraction aborted/i);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(clearCalls, 0);
  assert.equal(persistCalls, 0);
});

test("runExtraction still clears the session buffer after persistence even if reset abort fires late", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  const abortController = new AbortController();

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => ({
        extractionCount: 0,
        lastExtractionAt: null,
        totalMemories: 0,
        totalEntities: 0,
      }),
      saveMeta: async () => undefined,
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({
      facts: [
        {
          category: "fact",
          content: "Remember alpha",
          confidence: 0.9,
          tags: [],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
  orchestrator.persistExtraction = async () => {
    abortController.abort();
    return ["fact-1"];
  };
  orchestrator.maybeScheduleConsolidation = () => undefined;
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.nonZeroExtractionsSinceConsolidation = 0;

  await assert.doesNotReject(async () => {
    await orchestrator.runExtraction([makeTurn("thread-a", "remember alpha")], {
      bufferKey: "thread-a",
      abortSignal: abortController.signal,
    });
  });

  assert.equal(
    clearCalls,
    1,
    "persisted reset flushes must still clear the session buffer even when the reset timeout aborts after persistence",
  );
});
