import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import {
  BulkImportBatchPartialFailureError,
  Orchestrator,
} from "./orchestrator.js";
import { ExtractionQueueCoordinator } from "./orchestration/extraction-queue-coordinator.js";
import { TurnIngestionCoordinator } from "./orchestration/turn-ingestion.js";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import { stableHash } from "./coding/git-context.js";
import type { BufferState, BufferTurn, PluginConfig } from "./types.js";
import type { ImportTurn } from "./bulk-import/types.js";
import type { LcmEngine } from "./lcm/index.js";
import type { ExtractionRunResult } from "./orchestration/extraction-run.js";
import { namespaceIdentityToken } from "./namespaces/identity.js";
import { readNamespaceMaintenanceStatuses } from "./maintenance/namespace-planner.js";
import { stubPersistExtraction } from "./testing/orchestrator-lite.js";

function makeTurn(sessionKey: string, content: string, sessionOwnerPrincipal?: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-12T12:00:00.000Z",
    sessionKey,
    ...(sessionOwnerPrincipal ? { sessionOwnerPrincipal } : {}),
  };
}

/**
 * Writable orchestrator double for `ingestBulkImportBatch` slice tests: the
 * real prototype methods run, but the per-test stub surface must stay
 * assignable (the real class marks these fields readonly).
 */
interface BulkImportTestDouble {
  config: PluginConfig;
  extractionQueueCoordinator: ExtractionQueueCoordinator;
  lcmEngine: LcmEngine | null;
  runExtraction: (
    turns: BufferTurn[],
    options?: Record<string, unknown>,
  ) => Promise<ExtractionRunResult>;
  ingestBulkImportBatch: Orchestrator["ingestBulkImportBatch"];
}

interface ScopedFlushTestDouble {
  buffer: {
    getTurns(bufferKey: string): BufferTurn[];
  };
  queueBufferedExtraction(
    turns: BufferTurn[],
    reason: string,
    options?: Record<string, unknown>,
  ): Promise<void>;
  flushSession(
    sessionKey: string,
    options: {
      reason: string;
      abortSignal?: AbortSignal;
      bufferKey?: string;
      extractionDeadlineMs?: number;
      writeNamespaceOverride?: string;
      failOnExtractionFailure?: boolean;
      principalOverride?: string;
    },
  ): Promise<void>;
}

test("flushSession queues extraction for the targeted buffered session", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const turns = [makeTurn("thread-a", "remember alpha")];
  let queued: {
    turns: BufferTurn[];
    reason: string;
    options: Record<string, unknown> | undefined;
  } | null = null;
  let committed = 0;

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
    (options?.onDurableCommit as (() => void) | undefined)?.();
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };
  await orchestrator.flushSession("thread-a", {
    reason: "access_force_flush",
    failOnExtractionFailure: true,
    onCommitted: () => {
      committed += 1;
    },
  });

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
  assert.equal(queuedCall.options?.failOnExtractionFailure, true);
  assert.equal(queuedCall.options?.abortSignal, undefined);
  assert.equal(committed, 1);
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

test("flushSession preserves scoped force-drain routing and deadline options", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as unknown as ScopedFlushTestDouble;
  const abortController = new AbortController();
  const extractionDeadlineMs = Date.now() + 10_000;
  let queuedOptions: Record<string, unknown> | undefined;

  orchestrator.buffer = {
    getTurns(bufferKey: string) {
      return bufferKey === "logical-session" ? [makeTurn("session-z", "remember gamma", "alice")] : [];
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

  await orchestrator.flushSession("session-z", {
    reason: "access_force_flush",
    bufferKey: "logical-session",
    abortSignal: abortController.signal,
    extractionDeadlineMs,
    writeNamespaceOverride: "alice-project-example",
    principalOverride: "alice",
  });

  assert.equal(queuedOptions?.bufferKey, "logical-session");
  assert.equal(queuedOptions?.abortSignal, abortController.signal);
  assert.equal(queuedOptions?.extractionDeadlineMs, extractionDeadlineMs);
  assert.equal(queuedOptions?.writeNamespaceOverride, "alice-project-example");
  assert.equal(queuedOptions?.principalOverride, "alice");
  assert.equal(queuedOptions?.skipDedupeCheck, true);
  assert.equal(queuedOptions?.skipCharThreshold, true);
  assert.equal(queuedOptions?.skipUserTurnThreshold, true);
  assert.equal(queuedOptions?.forceExtractionAttempt, true);
  assert.equal(queuedOptions?.clearBufferAfterExtraction, true);
});

test("flushSession preserves retained context for other scoped sessions", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let retainedTurns = [
    makeTurn("session-z", "old session A context", "alice"),
    makeTurn("session-y", "session B context", "bob"),
  ];
  orchestrator.config = parseConfig({ namespacesEnabled: true });
  orchestrator.buffer = {
    flushPendingSave: async () => {},
    findBufferKeysForSession: async () => ["provider-thread"],
    getTurns: (bufferKey: string) =>
      bufferKey === "provider-thread" ? [makeTurn("session-z", "active session A", "alice")] : [],
    getRetainedDeferredTurns: (bufferKey: string) =>
      bufferKey === "provider-thread" ? retainedTurns : [],
    retainDeferredTurns: async (_bufferKey: string, turns: BufferTurn[]) => {
      retainedTurns = turns;
    },
  };
  orchestrator.queueBufferedExtraction = async (
    _queuedTurns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    retainedTurns = [makeTurn("session-z", "new session A context", "alice")];
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("session-z", {
    reason: "access_force_flush",
    writeNamespaceOverride: "alice-project",
    principalOverride: "alice",
  });

  assert.ok(retainedTurns.some((turn) => turn.content === "session B context"));
  assert.ok(retainedTurns.some((turn) => turn.content === "new session A context"));
});

test("flushSession keeps all other-session retained turns ahead of the scoped cap", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const otherSessionTurns = Array.from({ length: 10 }, (_, index) =>
    makeTurn("session-y", `session B context ${index}`, "bob"),
  );
  let retainedTurns = [...otherSessionTurns];
  orchestrator.config = parseConfig({ namespacesEnabled: true });
  orchestrator.buffer = {
    flushPendingSave: async () => {},
    findBufferKeysForSession: async () => ["provider-thread"],
    getTurns: (bufferKey: string) =>
      bufferKey === "provider-thread" ? [makeTurn("session-z", "active session A", "alice")] : [],
    getRetainedDeferredTurns: (bufferKey: string) =>
      bufferKey === "provider-thread" ? retainedTurns : [],
    retainDeferredTurns: async (_bufferKey: string, turns: BufferTurn[], max = 10) => {
      retainedTurns = turns.slice(-max);
    },
  };
  orchestrator.queueBufferedExtraction = async (
    _queuedTurns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    retainedTurns = [makeTurn("session-z", "new session A context", "alice")];
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("session-z", {
    reason: "access_force_flush",
    writeNamespaceOverride: "alice-project",
    principalOverride: "alice",
  });

  assert.deepEqual(
    retainedTurns.map((turn) => turn.content),
    otherSessionTurns.map((turn) => turn.content),
  );
});


test("flushSession rejects opaque buffers without trusted ownership", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let queued = false;
  orchestrator.config = parseConfig({ namespacesEnabled: true });
  orchestrator.buffer = {
    flushPendingSave: async () => {},
    findBufferKeysForSession: async () => ["provider-thread"],
    getTurns: (bufferKey: string) =>
      bufferKey === "provider-thread" ? [makeTurn("opaque-session", "remember gamma")] : [],
  };
  orchestrator.queueBufferedExtraction = async () => {
    queued = true;
  };

  await assert.rejects(
    orchestrator.flushSession("opaque-session", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
      writeNamespaceOverride: "alice-project",
      principalOverride: "alice",
    }),
    /without trusted ownership/,
  );
  assert.equal(queued, false);
});
test("flushSession skips scoped ownership enforcement when namespaces are disabled", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let queued = false;
  orchestrator.config = parseConfig({ namespacesEnabled: false });
  orchestrator.buffer = {
    flushPendingSave: async () => {},
    findBufferKeysForSession: async () => ["provider-thread"],
    getTurns: (bufferKey: string) =>
      bufferKey === "provider-thread" ? [makeTurn("opaque-session", "remember gamma")] : [],
  };
  orchestrator.queueBufferedExtraction = async (
    _turns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queued = true;
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("opaque-session", {
    reason: "access_force_flush",
    failOnExtractionFailure: true,
    writeNamespaceOverride: "default",
    principalOverride: "alice",
  });

  assert.equal(queued, true);
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
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
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


test("flushSession flushes the pending debounced buffer save before extraction, so keep_buffering turns survive a failed/timed-out extraction (issue #1909, PR #2016)", async () => {
  // Regression: in steady-state debounced buffering a `keep_buffering` turn only
  // SCHEDULES a trailing-edge save, so the newest turns live only in memory
  // behind an unref'd timer. The lifecycle force-drain (before_reset /
  // session_end) queues extraction with clearBufferAfterExtraction; if that
  // extraction fails or times out and the host then exits, the debounce timer
  // never fires and those turns are lost. flushSession must force the pending
  // save durable BEFORE reading/clearing turns.
  let saved: BufferState | null = null;
  const storage = {
    async loadBuffer(): Promise<BufferState> {
      return saved
        ? structuredClone(saved)
        : { turns: [], lastExtractionAt: null, extractionCount: 0 };
    },
    async saveBuffer(state: BufferState): Promise<void> {
      saved = structuredClone(state);
    },
  };
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 10_000, triggerMode: "smart", bufferMaxTurns: 100 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  await buffer.addTurn("thread-a", makeTurn("thread-a", "remember alpha"));
  // Debounced keep_buffering: buffered in memory but NOT yet durable.
  assert.equal(saved, null, "debounced keep_buffering turn is not yet on disk");
  assert.equal(buffer.getTurns("thread-a").length, 1);

  interface FlushFake {
    buffer: SmartBuffer;
    queueBufferedExtraction: (
      turns: BufferTurn[],
      reason: string,
      options?: Record<string, unknown>,
    ) => Promise<void>;
    flushSession(sessionKey: string, options: { reason: string }): Promise<void>;
  }
  const orchestrator = Object.create(Orchestrator.prototype) as unknown as FlushFake;
  orchestrator.buffer = buffer;
  let extractionAttempted = false;
  orchestrator.queueBufferedExtraction = async (
    _turns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    extractionAttempted = true;
    // Extraction fails/times out: the buffer is NOT cleared.
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.(
      new Error("simulated extraction timeout"),
    );
  };

  await assert.rejects(
    orchestrator.flushSession("thread-a", { reason: "before_reset" }),
    /simulated extraction timeout/,
  );

  assert.equal(extractionAttempted, true);
  // The pending debounced save was forced durable BEFORE the failing
  // extraction, so the keep_buffering turn is on disk for re-extraction even
  // though extraction failed and (in production) the host would now exit.
  assert.ok(saved, "pending debounced save was flushed before extraction");
  const persisted = saved as BufferState;
  const entryTurns = persisted.entries?.["thread-a"]?.turns ?? [];
  assert.equal(entryTurns.length, 1, "keep_buffering turn is durable after failed flush");
  assert.equal(entryTurns[0]?.content, "remember alpha");
});
test("queued extraction settles immediately when its caller aborts while waiting", async () => {
  const queue = new ExtractionQueueCoordinator();
  let extractionStarted = false;
  let releaseExtraction!: () => void;
  const coordinator = new TurnIngestionCoordinator({
    extractionQueueCoordinator: queue,
    shouldQueueExtraction: () => true,
    runExtraction: async () => {
      extractionStarted = true;
      await new Promise<void>((resolve) => {
        releaseExtraction = resolve;
      });
      return {
        status: "skipped",
        reason: "test",
        persistedCount: 0,
        durableOutputCount: 0,
      };
    },
  } as any);
  const turns = [makeTurn("thread-a", "remember alpha")];

  await coordinator.queueBufferedExtraction(turns, "trigger_mode", {
    skipDedupeCheck: true,
  });
  for (let i = 0; i < 50 && !extractionStarted; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(extractionStarted, true, "the first extraction must occupy the queue");

  const abortController = new AbortController();
  const abortReason = new Error("caller disconnected");
  const settled = Promise.withResolvers<unknown>();
  await coordinator.queueBufferedExtraction(turns, "trigger_mode", {
    skipDedupeCheck: true,
    abortSignal: abortController.signal,
    onTaskSettled: (error) => settled.resolve(error),
  });

  abortController.abort(abortReason);
  assert.equal(await settled.promise, abortReason);

  releaseExtraction();
  assert.equal(await queue.waitForIdle(1_000), true);
});


test("flushSession aborts a blocked pre-drain save before queueing extraction", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const abortController = new AbortController();
  let releaseSave!: () => void;
  let saveStarted!: () => void;
  const saveReady = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  let queued = false;

  orchestrator.buffer = {
    flushPendingSave: async () => {
      saveStarted();
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    },
    findBufferKeysForSession: async () => ["thread-a"],
    getTurns: () => [makeTurn("thread-a", "remember alpha")],
  };
  orchestrator.queueBufferedExtraction = async () => {
    queued = true;
  };

  const flushPromise = orchestrator.flushSession("thread-a", {
    reason: "access_force_flush",
    abortSignal: abortController.signal,
    extractionDeadlineMs: Date.now() + 10_000,
  });
  await saveReady;
  abortController.abort();
  await assert.rejects(flushPromise, /extraction force-flush aborted/);
  assert.equal(queued, false);
  releaseSave();
});

test("flushSession applies its deadline to a blocked pre-drain save", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let releaseSave!: () => void;
  let queued = false;
  const keepAlive = setInterval(() => undefined, 1_000);

  orchestrator.buffer = {
    flushPendingSave: async () =>
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      }),
    findBufferKeysForSession: async () => ["thread-a"],
    getTurns: () => [makeTurn("thread-a", "remember alpha")],
  };
  orchestrator.queueBufferedExtraction = async () => {
    queued = true;
  };

  try {
    const flushPromise = orchestrator.flushSession("thread-a", {
      reason: "access_force_flush",
      extractionDeadlineMs: Date.now() + 25,
    });
    await assert.rejects(flushPromise, /replay extraction deadline exceeded \(before_buffer_flush\)/);
    assert.equal(queued, false);
  } finally {
    clearInterval(keepAlive);
    releaseSave?.();
  }
});

test("flushSession rejects and skips extraction when the durable buffer save fails, leaving turns and pending state intact (issue #1909, PR #2016)", async () => {
  // Fail-closed regression: if the pending debounced save cannot land durably,
  // flushSession must STOP before queuing extraction with
  // clearBufferAfterExtraction. Otherwise the drain would clear turns that never
  // reached disk; a subsequent extraction failure + host exit loses the turn.
  let saved: BufferState | null = null;
  let failSave = true;
  const storage = {
    async loadBuffer(): Promise<BufferState> {
      return saved
        ? structuredClone(saved)
        : { turns: [], lastExtractionAt: null, extractionCount: 0 };
    },
    async saveBuffer(state: BufferState): Promise<void> {
      if (failSave) throw new Error("simulated durable save failure");
      saved = structuredClone(state);
    },
  };
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 10_000, triggerMode: "smart", bufferMaxTurns: 100 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  await buffer.addTurn("thread-a", makeTurn("thread-a", "remember alpha"));
  // Debounced keep_buffering: buffered in memory but NOT yet durable.
  assert.equal(saved, null, "debounced keep_buffering turn is not yet on disk");
  assert.equal(buffer.getTurns("thread-a").length, 1);

  interface FlushFake {
    buffer: SmartBuffer;
    queueBufferedExtraction: (
      turns: BufferTurn[],
      reason: string,
      options?: Record<string, unknown>,
    ) => Promise<void>;
    flushSession(sessionKey: string, options: { reason: string }): Promise<void>;
  }
  const orchestrator = Object.create(Orchestrator.prototype) as unknown as FlushFake;
  orchestrator.buffer = buffer;
  let extractionAttempted = false;
  orchestrator.queueBufferedExtraction = async () => {
    extractionAttempted = true;
  };

  await assert.rejects(
    orchestrator.flushSession("thread-a", { reason: "before_reset" }),
    /simulated durable save failure/,
  );

  // The failed save short-circuits the drain: extraction never runs.
  assert.equal(extractionAttempted, false, "extraction is skipped after a failed durable save");
  assert.equal(saved, null, "nothing was written durably");
  // In-memory turns survive: the buffer was never read/cleared.
  assert.equal(buffer.getTurns("thread-a").length, 1, "buffered turn is retained after a failed flush");

  // Pending state was retained (not cleared): once the durable write recovers,
  // the still-pending save lands the turn on disk.
  failSave = false;
  await buffer.flushPendingSave();
  assert.ok(saved, "pending save was retained and lands durably once the write recovers");
  const entryTurns = (saved as BufferState).entries?.["thread-a"]?.turns ?? [];
  assert.equal(entryTurns.length, 1, "retained pending save persists the keep_buffering turn");
  assert.equal(entryTurns[0]?.content, "remember alpha");
});

test("ingestBulkImportBatch rejects when the extraction deadline expires in the queue", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  orchestrator.extractionQueueCoordinator.setProcessingForTest(true);
  let runExtractionCalls = 0;
  orchestrator.runExtraction = async () => {
    runExtractionCalls += 1;
  };

  const turns: ImportTurn[] = [
    {
      role: "user",
      timestamp: "2026-06-24T12:00:00.000Z",
      content: "Remember this queued bulk import.",
    },
  ];
  const startedAt = Date.now();
  const outcome = await Promise.race([
    orchestrator
      .ingestBulkImportBatch(turns, {
        deadlineMs: Date.now() + 25,
        failOnExtractionFailure: true,
      })
      .then(
        () => new Error("bulk import unexpectedly resolved"),
        (error: unknown) => error,
      ),
    new Promise<Error>((resolve) =>
      setTimeout(() => resolve(new Error("bulk import did not time out")), 300),
    ),
  ]);

  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /deadline exceeded \(queue_wait\)/);
  assert.ok(
    Date.now() - startedAt < 250,
    "bulk import should not wait behind the extraction queue past its deadline",
  );
  assert.equal(runExtractionCalls, 0);

  const queuedTask = orchestrator.extractionQueueCoordinator.shift();
  assert.ok(queuedTask);
  await queuedTask();
  assert.equal(
    runExtractionCalls,
    0,
    "the expired bulk-import task should be a no-op when the queue later drains",
  );
});

test("queued extraction clamps long deadline timers to the Node setTimeout limit", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  orchestrator.extractionQueueCoordinator.setProcessingForTest(true);
  orchestrator.runExtraction = async () => ({
    status: "completed",
    persistedCount: 0,
    durableOutputCount: 0,
  });

  const timerGlobal = globalThis as unknown as { setTimeout: typeof setTimeout };
  const realSetTimeout = timerGlobal.setTimeout;
  const armedDelays: number[] = [];
  timerGlobal.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (typeof delay === "number") armedDelays.push(delay);
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  try {
    const pending = orchestrator.ingestBulkImportBatch(
      [{ role: "user", timestamp: "2026-06-24T12:00:00.000Z", content: "Remember this long-deadline import." }],
      { deadlineMs: Date.now() + 2_147_483_647 + 60_000, failOnExtractionFailure: true },
    );
    const queuedTask = orchestrator.extractionQueueCoordinator.shift();
    assert.ok(queuedTask);
    await queuedTask();
    await pending;
  } finally {
    timerGlobal.setTimeout = realSetTimeout;
  }
  assert.ok(armedDelays.includes(2_147_483_647), `expected a clamped queue timer, got ${armedDelays.join(", ")}`);
});

test("ingestBulkImportBatch does not report queue wait timeout after extraction starts", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  let runExtractionCalls = 0;
  orchestrator.runExtraction = async () => {
    runExtractionCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
    return {
      status: "completed",
      persistedCount: 1,
      durableOutputCount: 1,
    };
  };

  const result = await orchestrator.ingestBulkImportBatch(
    [
      {
        role: "user",
        timestamp: "2026-06-24T12:00:00.000Z",
        content: "Remember this active bulk import.",
      },
    ],
    {
      deadlineMs: Date.now() + 25,
      failOnExtractionFailure: true,
    },
  );

  assert.equal(runExtractionCalls, 1);
  assert.equal(result.extractionCount, 1);
  assert.equal(result.persistedCount, 1);
  assert.equal(result.failedCount, 0);
});

test("ingestBulkImportBatch reports post-persist metadata failures separately", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  orchestrator.runExtraction = async () => ({
    status: "completed",
    persistedCount: 1,
    durableOutputCount: 1,
    postPersistMetadataFailed: true,
  });

  const result = await orchestrator.ingestBulkImportBatch(
    [
      {
        role: "user",
        timestamp: "2026-06-24T12:00:00.000Z",
        content: "Remember this import, but fail the replay metadata marker.",
        turnFingerprint: "flush-plan-fp-1",
        persistProcessedFingerprint: true,
      },
    ],
    {
      failOnExtractionFailure: true,
    },
  );

  assert.equal(result.extractionCount, 1);
  assert.equal(result.persistedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(result.postPersistMetadataFailureCount, 1);
});

test("ingestBulkImportBatch can disable source-valid-at replay context", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  const capturedSlices: BufferTurn[][] = [];
  orchestrator.runExtraction = async (turns: BufferTurn[]) => {
    capturedSlices.push(turns);
    return {
      status: "completed",
      persistedCount: 1,
      durableOutputCount: 1,
    };
  };

  await orchestrator.ingestBulkImportBatch(
    [
      {
        role: "user",
        timestamp: "2026-06-24T12:00:00.000Z",
        content: "Remember the first chunk.",
      },
      {
        role: "user",
        timestamp: "2026-06-24T12:00:00.001Z",
        content: "Remember the second chunk.",
      },
      {
        role: "user",
        timestamp: "2026-06-24T12:00:00.002Z",
        content: "Remember the third chunk.",
      },
    ],
    {
      includeSourceValidAtContext: false,
    },
  );

  assert.equal(capturedSlices.length, 3);
  assert.deepEqual(
    capturedSlices.map((slice) =>
      slice.map((turn) => ({
        content: turn.content,
        contextOnly: turn.extractionContextOnly === true,
      })),
    ),
    [
      [{ content: "Remember the first chunk.", contextOnly: false }],
      [{ content: "Remember the second chunk.", contextOnly: false }],
      [{ content: "Remember the third chunk.", contextOnly: false }],
    ],
  );
});

test("ingestBulkImportBatch skips LCM observation for flush-plan recovery batches (issue #2457)", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as unknown as BulkImportTestDouble;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  const observedSessionKeys: string[] = [];
  orchestrator.lcmEngine = {
    enabled: true,
    observeMessages: async (sessionKey: string) => {
      observedSessionKeys.push(sessionKey);
    },
    // Partial engine double for the observe seam.
  } as unknown as LcmEngine;
  const extractedSlices: BufferTurn[][] = [];
  orchestrator.runExtraction = async (turns: BufferTurn[]) => {
    extractedSlices.push(turns);
    return { status: "completed", persistedCount: 1, durableOutputCount: 1 };
  };

  const result = await orchestrator.ingestBulkImportBatch([
    {
      role: "user",
      timestamp: "2026-06-24T12:00:00.000Z",
      content: "Recovery material the host already compacted once.",
      importProvenance: {
        sourceLabel: "OpenClaw flush plan",
        sourceId: "openclaw-remnic:flush-plan",
      },
    },
    {
      role: "user",
      timestamp: "2026-06-24T12:00:01.000Z",
      content: "Chunked recovery material.",
      importProvenance: {
        sourceLabel: "OpenClaw flush plan",
        sourceId: "openclaw-remnic:flush-plan:2/3",
      },
    },
  ]);

  assert.deepEqual(observedSessionKeys, []);
  assert.equal(extractedSlices.length, 2);
  assert.equal(result.extractionCount, 2);
  assert.equal(result.persistedCount, 2);
});

test("ingestBulkImportBatch still observes ordinary bulk imports through LCM (issue #2457)", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as unknown as BulkImportTestDouble;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  const observed: { sessionKey: string; turnCount: number }[] = [];
  orchestrator.lcmEngine = {
    enabled: true,
    observeMessages: async (sessionKey: string, messages: unknown[]) => {
      observed.push({ sessionKey, turnCount: messages.length });
    },
    // Partial engine double for the observe seam.
  } as unknown as LcmEngine;
  orchestrator.runExtraction = async () => ({
    status: "completed",
    persistedCount: 1,
    durableOutputCount: 1,
  });

  await orchestrator.ingestBulkImportBatch([
    {
      role: "user",
      timestamp: "2026-06-24T12:00:00.000Z",
      content: "Ordinary chatgpt import turn.",
      importProvenance: { sourceLabel: "chatgpt", sourceId: "cg-1" },
    },
    {
      role: "user",
      timestamp: "2026-06-24T12:00:01.000Z",
      content: "Ordinary turn without provenance.",
    },
  ]);

  assert.deepEqual(
    observed.map((entry) => entry.turnCount),
    [2],
  );
  assert.ok(observed[0]?.sessionKey.startsWith("bulk-import:batch:"));
});

test("ingestBulkImportBatch observes mixed batches that contain flush-plan turns (issue #2457)", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as unknown as BulkImportTestDouble;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  const observed: number[] = [];
  orchestrator.lcmEngine = {
    enabled: true,
    observeMessages: async (_sessionKey: string, messages: unknown[]) => {
      observed.push(messages.length);
    },
    // Partial engine double for the observe seam.
  } as unknown as LcmEngine;
  orchestrator.runExtraction = async () => ({
    status: "completed",
    persistedCount: 1,
    durableOutputCount: 1,
  });

  await orchestrator.ingestBulkImportBatch([
    {
      role: "user",
      timestamp: "2026-06-24T12:00:00.000Z",
      content: "Recovery material mixed into an ordinary batch.",
      importProvenance: {
        sourceLabel: "OpenClaw flush plan",
        sourceId: "openclaw-remnic:flush-plan",
      },
    },
    {
      role: "user",
      timestamp: "2026-06-24T12:00:01.000Z",
      content: "Ordinary chatgpt import turn.",
      importProvenance: { sourceLabel: "chatgpt", sourceId: "cg-2" },
    },
  ]);

  assert.deepEqual(observed, [2]);
});

test("ingestBulkImportBatch preserves partial metadata failure before a later slice rejects", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  let runExtractionCalls = 0;
  orchestrator.runExtraction = async () => {
    runExtractionCalls += 1;
    if (runExtractionCalls <= 2) {
      return {
        status: "completed",
        persistedCount: 1,
        durableOutputCount: 1,
        postPersistMetadataFailed: runExtractionCalls === 1,
      };
    }
    throw new Error("backend unavailable");
  };

  const error = await orchestrator
    .ingestBulkImportBatch(
      [
        {
          role: "user",
          timestamp: "2026-06-24T12:00:00.000Z",
          content: "Remember the first chunk.",
          turnFingerprint: "flush-plan-fp-1",
          persistProcessedFingerprint: true,
        },
        {
          role: "user",
          timestamp: "2026-06-24T12:00:00.001Z",
          content: "Remember the second chunk.",
          turnFingerprint: "flush-plan-fp-2",
          persistProcessedFingerprint: true,
        },
        {
          role: "user",
          timestamp: "2026-06-24T12:00:00.002Z",
          content: "Remember the third chunk.",
          turnFingerprint: "flush-plan-fp-3",
          persistProcessedFingerprint: true,
        },
      ],
      {
        failOnExtractionFailure: true,
      },
    )
    .then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

  assert.ok(error instanceof BulkImportBatchPartialFailureError);
  assert.equal(error.partialResult.attemptedTurnCount, 3);
  assert.equal(error.partialResult.extractionCount, 2);
  assert.equal(error.partialResult.persistedCount, 2);
  assert.equal(error.partialResult.failedCount, 1);
  assert.equal(error.partialResult.postPersistMetadataFailureCount, 1);
  assert.equal(error.partialResult.processedTurnCount, 2);
  assert.equal(runExtractionCalls, 3);
});

test("ingestBulkImportBatch stops after the first failed source-valid-at slice", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = parseConfig({});
  orchestrator.extractionQueueCoordinator = new ExtractionQueueCoordinator();
  let runExtractionCalls = 0;
  orchestrator.runExtraction = async () => {
    runExtractionCalls += 1;
    if (runExtractionCalls === 1) {
      return {
        status: "completed",
        persistedCount: 1,
        durableOutputCount: 1,
      };
    }
    throw new Error("backend unavailable");
  };

  const error = await orchestrator
    .ingestBulkImportBatch(
      [
        {
          role: "user",
          timestamp: "2026-06-24T12:00:00.000Z",
          content: "Remember the first chunk.",
          turnFingerprint: "flush-plan-fp-1",
          persistProcessedFingerprint: true,
        },
        {
          role: "user",
          timestamp: "2026-06-24T12:00:00.001Z",
          content: "Remember the second chunk.",
          turnFingerprint: "flush-plan-fp-2",
          persistProcessedFingerprint: true,
        },
        {
          role: "user",
          timestamp: "2026-06-24T12:00:00.002Z",
          content: "Remember the third chunk.",
          turnFingerprint: "flush-plan-fp-3",
          persistProcessedFingerprint: true,
        },
      ],
      {
        failOnExtractionFailure: true,
      },
    )
    .then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

  assert.ok(error instanceof BulkImportBatchPartialFailureError);
  assert.equal(error.partialResult.attemptedTurnCount, 3);
  assert.equal(error.partialResult.extractionCount, 1);
  assert.equal(error.partialResult.persistedCount, 1);
  assert.equal(error.partialResult.failedCount, 1);
  assert.equal(error.partialResult.processedTurnCount, 1);
  assert.equal(runExtractionCalls, 2);
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

test("flushSession filters shared-buffer turns before scoped extraction", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const ownedTurn = makeTurn("session-z", "remember owned", "session-z");
  const foreignTurn = makeTurn("session-other", "remember foreign", "session-other");
  let queuedTurns: BufferTurn[] = [];
  let queuedOptions: Record<string, unknown> | undefined;

  orchestrator.buffer = {
    async findBufferKeysForSession() {
      return ["codex-thread:shared"];
    },
    getTurns() {
      return [ownedTurn, foreignTurn];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    turns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedTurns = turns;
    queuedOptions = options;
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("session-z", {
    reason: "access_force_flush",
    writeNamespaceOverride: "session-z-project",
    principalOverride: "session-z",
  });

  assert.deepEqual(queuedTurns, [ownedTurn]);
  assert.equal(queuedOptions?.clearMatchingTurns, true);
});

test("flushSession filters shared-buffer turns when namespace capability is disabled", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const ownedTurn = makeTurn("session-z", "remember owned");
  const foreignTurn = makeTurn("session-other", "remember foreign");
  let queuedTurns: BufferTurn[] = [];

  orchestrator.config = parseConfig({ namespacesEnabled: false });
  orchestrator.buffer = {
    async findBufferKeysForSession() {
      return ["codex-thread:shared"];
    },
    getTurns() {
      return [ownedTurn, foreignTurn];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    turns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedTurns = turns;
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("session-z", {
    reason: "access_force_flush",
    writeNamespaceOverride: "default",
  });

  assert.deepEqual(queuedTurns, [ownedTurn]);
});

test("flushSession honors persisted ownership for opaque sessions", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const ownedTurn = makeTurn("opaque-session", "remember owned", "alice");
  const foreignTurn = makeTurn("opaque-session", "remember foreign", "bob");
  let queuedTurns: BufferTurn[] = [];

  orchestrator.buffer = {
    async findBufferKeysForSession() {
      return ["codex-thread:shared"];
    },
    getTurns() {
      return [ownedTurn, foreignTurn];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    turns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedTurns = turns;
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("opaque-session", {
    reason: "access_force_flush",
    writeNamespaceOverride: "alice-project",
    principalOverride: "alice",
  });

  assert.deepEqual(queuedTurns, [ownedTurn]);
});

test("flushSession preserves unstamped turns for a principal-keyed session", async () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "alice:", principal: "alice" }],
  });
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  const unstampedTurn = makeTurn("alice:chat", "remember host-hook turn");
  let queuedTurns: BufferTurn[] = [];

  orchestrator.buffer = {
    async findBufferKeysForSession() {
      return ["codex-thread:shared"];
    },
    getTurns() {
      return [unstampedTurn];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    turns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedTurns = turns;
    (options?.onTaskSettled as ((error?: unknown) => void) | undefined)?.();
  };

  await orchestrator.flushSession("alice:chat", {
    reason: "access_force_flush",
    writeNamespaceOverride: "alice-project",
    principalOverride: "alice",
  });

  assert.deepEqual(queuedTurns, [unstampedTurn]);
});

test("runExtraction skips active scope profile writes when no layer is writable", async () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultScopeProfile: "teamCoding",
    codingMode: { projectScope: true },
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-observer:", principal: "pi-observer" }],
    namespacePolicies: [
      { name: "pi-observer", readPrincipals: ["pi-observer"], writePrincipals: [] },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["teamProject"],
        writeDefault: "teamProject",
        promotionTargets: ["teamProject"],
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
      },
    },
    teams: {
      pi: {
        principals: ["pi-observer"],
        read: ["pi-observer"],
        write: [],
        promote: [],
      },
    },
  });
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.getCodingContextForSession = () => ({
    projectId: "tag:remnic",
    branch: null,
    rootPath: "tag:remnic",
    defaultBranch: "main",
  });
  orchestrator.storageRouter = {
    storageFor: async () => {
      throw new Error("unauthorized profile write must not choose fallback storage");
    },
  };

  const result = await orchestrator.runExtraction(
    [makeTurn("pi-observer:abc123", "remember unauthorized profile target")],
    { bufferKey: "pi-observer:abc123" },
  );

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "scope_profile_no_writable_layer");
  assert.equal(clearCalls, 1);
});

test("runExtraction writes buffered turns to active scope profile write layer", async () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultScopeProfile: "teamCoding",
    codingMode: { projectScope: true },
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-observer:", principal: "pi-observer" }],
    namespacePolicies: [
      { name: "pi-observer", readPrincipals: ["pi-observer"], writePrincipals: ["pi-observer"] },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["teamProject"],
        writeDefault: "teamProject",
        promotionTargets: ["teamProject"],
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
      },
    },
    teams: {
      pi: {
        principals: ["pi-observer"],
        read: ["pi-observer"],
        write: ["pi-observer"],
        promote: ["pi-observer"],
      },
    },
  });
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  const turn = {
    ...makeTurn("pi-observer:abc123", "remember the team profile target"),
    persistProcessedFingerprint: true,
  };
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = { clearAfterExtraction: async () => undefined };
  orchestrator.getCodingContextForSession = () => ({
    projectId: "tag:remnic",
    branch: null,
    rootPath: "tag:remnic",
    defaultBranch: "main",
  });
  let requestedNamespace: string | undefined;
  orchestrator.storageRouter = {
    storageFor: async (namespace: string) => {
      requestedNamespace = namespace;
      return {
        listEntityNames: async () => [],
        loadMeta: async () => ({
          extractionCount: 0,
          lastExtractionAt: null,
          lastConsolidationAt: null,
          totalMemories: 0,
          totalEntities: 0,
          processedExtractionFingerprints: [
            {
              fingerprint: orchestrator.buildExtractionFingerprint([turn], "pi-observer:abc123"),
              observedAt: "2026-04-15T00:00:00.000Z",
            },
          ],
        }),
        saveMeta: async () => undefined,
      };
    },
  };
  orchestrator.extraction = {
    extract: async () => {
      throw new Error("extraction should be skipped by processed fingerprint");
    },
  };

  await orchestrator.runExtraction([turn], { bufferKey: "pi-observer:abc123" });

  assert.equal(requestedNamespace, `team-pi-project-${stableHash("tag:remnic")}`);
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

test("runExtraction fails closed on invalid extraction results when required", async () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    [
      "malformed collections",
      {
        facts: "not an array",
        entities: [],
        questions: [],
        profileUpdates: [],
      },
    ],
  ];

  for (const [label, extractionResult] of cases) {
    const config = parseConfig({});
    config.extractionMinChars = 0;
    config.extractionMinUserTurns = 1;

    let clearCalls = 0;
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
      extract: async () => extractionResult,
    };
    const persistCalls = stubPersistExtraction(orchestrator, () => ["fact-1"]);

    await assert.rejects(
      orchestrator.runExtraction([makeTurn("session-invalid", "remember bad output")], {
        bufferKey: `bulk-import:batch:${label}`,
        failOnExtractionFailure: true,
      }),
      /extraction failed: invalid_extraction_result/,
    );

    assert.equal(clearCalls, 0);
    assert.equal(persistCalls.length, 0);
  }
});

test("runExtraction persists processed fingerprints for empty extraction results", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

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
      facts: [],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
  const persistCalls = stubPersistExtraction(orchestrator);

  const turns = [
    {
      ...makeTurn("session-empty", "transient note not worth remembering"),
      logicalSessionKey: "logical-thread:empty",
      turnFingerprint: "fp-empty",
      persistProcessedFingerprint: true,
    },
  ];
  const result = await orchestrator.runExtraction(turns, {
    bufferKey: "logical-thread:empty",
    failOnExtractionFailure: true,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "empty_extraction_result");
  assert.equal(persistCalls.length, 0);
  assert.equal(saveMetaCalls, 1);
  assert.equal(clearCalls, 1);
  assert.equal(savedMeta?.extractionCount, 1);
  assert.equal(savedMeta?.totalMemories, 0);
  assert.equal(savedMeta?.totalEntities, 0);
  assert.equal(savedMeta?.processedExtractionFingerprints.length, 1);
  assert.equal(
    savedMeta?.processedExtractionFingerprints[0]?.fingerprint,
    orchestrator.buildExtractionFingerprint(turns, "logical-thread:empty"),
  );
});

test("runExtraction does not persist processed fingerprints for failed empty extraction results", async () => {
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
      },
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({
      facts: [],
      entities: [],
      questions: [],
      profileUpdates: [],
      extractionFailure: "gateway_unavailable",
    }),
  };
  const persistCalls = stubPersistExtraction(orchestrator);

  const turns = [
    {
      ...makeTurn("session-empty-failed", "remember failed gateway output"),
      logicalSessionKey: "logical-thread:empty-failed",
      turnFingerprint: "fp-empty-failed",
      persistProcessedFingerprint: true,
    },
  ];
  const result = await orchestrator.runExtraction(turns, {
    bufferKey: "logical-thread:empty-failed",
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "empty_extraction_result");
  assert.equal(persistCalls.length, 0);
  // #1908: a failed extraction now persists per-fingerprint retry-state to meta (one
  // saveMeta call), but MUST NOT record a processed fingerprint — the invariant
  // below (processedExtractionFingerprints stays []) is the real contract.
  assert.ok(saveMetaCalls <= 1, `expected at most one retry-state meta save, got ${saveMetaCalls}`);
  // #1908: a retryable failure retains the buffer (clearCalls===0) so the backoff
  // gate can re-attempt the turns after nextEligibleAt — clearing would orphan
  // the persisted retry state (cursor high + codex P1).
  assert.equal(clearCalls, 0);
  assert.deepEqual(meta.processedExtractionFingerprints, []);
});

test("runExtraction clears the buffer on a failed extraction when extractionRetryEnabled=false (behavior parity)", async () => {
  // With retry disabled the failure path must match pre-#1908 behavior: the
  // buffer is cleared (no retry state is recorded, so there is nothing to retain).
  const config = parseConfig({ extractionRetryEnabled: false });
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;
  let clearCalls = 0;
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = { clearAfterExtraction: async () => { clearCalls += 1; } };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
      loadMeta: async () => ({ extractionCount: 0, lastExtractionAt: null, lastConsolidationAt: null, totalMemories: 0, totalEntities: 0, processedExtractionFingerprints: [] }),
      saveMeta: async () => {},
    }),
  };
  orchestrator.extraction = {
    extract: async () => ({ facts: [], entities: [], questions: [], profileUpdates: [], extractionFailure: "gateway_unavailable" }),
  };
  stubPersistExtraction(orchestrator);
  const turns = [{ ...makeTurn("session-retry-off", "failed gateway"), logicalSessionKey: "logical-thread:retry-off", turnFingerprint: "fp-retry-off", persistProcessedFingerprint: true }];
  const result = await orchestrator.runExtraction(turns, { bufferKey: "logical-thread:retry-off" });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "empty_extraction_result");
  assert.equal(clearCalls, 1, "retry disabled → buffer cleared (pre-#1908 behavior)");
});

test("runExtraction preserves empty-result buffers when fingerprint persistence fails", async () => {
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
      facts: [],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };

  await assert.rejects(
    orchestrator.runExtraction(
      [
        {
          ...makeTurn("session-empty-fail", "transient note not worth remembering"),
          logicalSessionKey: "logical-thread:empty-fail",
          turnFingerprint: "fp-empty-fail",
          persistProcessedFingerprint: true,
        },
      ],
      {
        bufferKey: "logical-thread:empty-fail",
        failOnExtractionFailure: true,
      },
    ),
    /meta save failed/,
  );

  assert.equal(saveMetaCalls, 1);
  assert.equal(clearCalls, 0);
});

test("runExtraction keeps the empty live path fail-open when liveness metadata write fails (#2223)", async () => {
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
    processedExtractionFingerprints: [] as Array<{ fingerprint: string; observedAt: string }>,
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
    extract: async () => ({ facts: [], entities: [], questions: [], profileUpdates: [] }),
  };

  // Normal live turn (no persistProcessedFingerprint): the liveness stamp is
  // diagnostic only, so a metadata write failure must neither reject the task
  // nor retain the buffer — extraction succeeded and produced nothing durable.
  const result = await orchestrator.runExtraction(
    [makeTurn("session-live-empty", "a transient note not worth remembering")],
    { bufferKey: "session-live-empty" },
  );

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "empty_extraction_result");
  assert.equal(saveMetaCalls, 1, "the liveness stamp was attempted");
  assert.equal(clearCalls, 1, "fail-open: the live buffer clears despite the metadata write failure");
});

test("runExtraction preserves deduped buffers when the caller aborts during meta load", async () => {
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
    /extraction aborted \(during_load_meta\)/,
  );

  assert.equal(clearCalls, 0);
});

test("runExtraction still clears the buffer when fingerprint persistence fails after durable writes", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;
  let clearCalls = 0;
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
  const persistCalls = stubPersistExtraction(orchestrator, () => ["fact-1"]);
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

  assert.equal(persistCalls.length, 1);
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
  stubPersistExtraction(orchestrator, () => ["fact-1"]);
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
  stubPersistExtraction(orchestrator, () => ["fact-1"]);
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

test("runExtraction completes after late threading failures and saves the processed fingerprint", async () => {
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
  stubPersistExtraction(orchestrator, () => ["fact-1"]);
  orchestrator.threading = {
    processTurn: async () => "thread-15",
    appendEpisodeIds: async () => undefined,
    updateThreadTitle: async () => {
      throw new Error("thread title failed");
    },
  };
  orchestrator.maybeScheduleConsolidation = () => undefined;
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.runTierMigrationCycle = async () => undefined;
  orchestrator.nonZeroExtractionsSinceConsolidation = 0;

  const result = await orchestrator.runExtraction(
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
  );

  assert.equal(result.status, "completed");
  assert.equal(result.persistedCount, 1);
  assert.equal(result.durableOutputCount, 1);
  assert.equal(result.postPersistMetadataFailed, false);
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

test("runExtraction completes and clears the buffer when the post-persist meta save fails", async () => {
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
  stubPersistExtraction(orchestrator, () => ["fact-1"]);
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.runTierMigrationCycle = async () => undefined;

  const result = await orchestrator.runExtraction(
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
  );

  assert.equal(result.status, "completed");
  assert.equal(result.persistedCount, 1);
  assert.equal(result.postPersistMetadataFailed, true);
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
  stubPersistExtraction(orchestrator, () => ["fact-1"]);
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
    throw new Error("tier migration failed");
  };
  orchestrator.nonZeroExtractionsSinceConsolidation = 0;

  const result = await orchestrator.runExtraction(
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
  );

  assert.equal(result.status, "completed");
  assert.equal(result.persistedCount, 1);
  assert.equal(result.postPersistMetadataFailed, true);
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
  const persistCalls = stubPersistExtraction(orchestrator);

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
  assert.equal(persistCalls.length, 0);
});

test("runExtraction still clears the session buffer after persistence even if reset abort fires late", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  let retentionCalls = 0;
  let passiveCaptureCalls = 0;
  let tierMigrationCalls = 0;
  const abortController = new AbortController();

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
    retainDeferredTurns: async () => {
      retentionCalls += 1;
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
  stubPersistExtraction(orchestrator, () => {
    abortController.abort();
    return ["fact-1"];
  });
  orchestrator.maybeScheduleConsolidation = () => undefined;
  orchestrator.requestQmdMaintenance = () => undefined;
  orchestrator.maybeCapturePassiveCorrections = async () => {
    passiveCaptureCalls += 1;
  };
  orchestrator.runTierMigrationCycle = async () => {
    tierMigrationCalls += 1;
  };
  orchestrator.nonZeroExtractionsSinceConsolidation = 0;

  await assert.doesNotReject(async () => {
    await orchestrator.runExtraction([makeTurn("thread-a", "remember alpha")], {
      bufferKey: "thread-a",
      abortSignal: abortController.signal,
    });
  });
  assert.equal(retentionCalls, 0);
  assert.equal(passiveCaptureCalls, 0);
  assert.equal(tierMigrationCalls, 0);

  assert.equal(
    clearCalls,
    1,
    "persisted reset flushes must still clear the session buffer even when the reset timeout aborts after persistence",
  );
});

// ── NHZEV (codex P2): the QMD STARTUP sync in deferredInitialize() must cover
// cataloged dynamic namespaces too, not only configuredNamespaces(). A dynamic
// namespace written before a daemon restart exists ONLY in the persisted catalog;
// if the boot-time "sync current disk state" pass embeds only the configured set,
// that namespace's QMD collection stays stale after restart. We drive
// deferredInitialize() with stubbed internals and abort the signal right after the
// sync (the next `if (signal.aborted) return;` bails before warmup), then assert the
// startup updateNamespaces() received the UNION of configured + cataloged namespaces.
test("deferredInitialize startup sync covers cataloged dynamic namespaces (NHZEV)", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let updateArg: string[] | undefined;
  const abortController = new AbortController();
  const memoryDir = path.join(os.tmpdir(), "remnic-startup-maintenance-nhzev");
  const dynamicNamespace = "project-origin-dynamic";
  const dynamicStorageDir = path.join(
    memoryDir,
    "namespaces",
    namespaceIdentityToken(dynamicNamespace),
  );
  await mkdir(path.join(dynamicStorageDir, "facts"), { recursive: true });

  orchestrator.config = {
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    qmdMaintenanceEnabled: true,
    maintenanceMaxNamespacesPerCycle: 2,
  };
  orchestrator.qmd = {
    isAvailable: () => true,
    async update() {},
  };
  orchestrator.namespaceCatalog = {
    enabled: true,
    async listNamespaces() {
      return [
        { namespace: "default" },
        {
          namespace: dynamicNamespace,
          identityToken: namespaceIdentityToken(dynamicNamespace),
          kind: "project",
          createdAt: "2026-04-12T12:00:00.000Z",
          storageDir: dynamicStorageDir,
          discoveredBy: "write",
        }, // dynamic, catalog-ONLY, NOT configured
      ];
    },
  };
  orchestrator.namespaceSearchRouter = {
    async updateNamespaces(ns: string[]) {
      updateArg = ns;
      // Abort AFTER the startup sync records its arg so deferredInitialize bails
      // at the next `if (signal.aborted) return;` before warmup/caches run.
      abortController.abort();
      return ns.length;
    },
  };

  await orchestrator.deferredInitialize(abortController.signal);

  assert.ok(updateArg, "startup updateNamespaces must be called");
  assert.ok(
    updateArg!.includes(dynamicNamespace),
    "startup sync must cover the cataloged dynamic namespace even when it exceeds the recurring maintenance cycle budget",
  );
  assert.ok(
    updateArg!.includes("default") && updateArg!.includes("shared"),
    "configured namespaces remain covered at startup",
  );
});

// NHZEV fallback: a catalog read failure during startup sync must degrade to the
// configured set rather than breaking deferredInitialize — same failure-tolerance
// contract as runQmdMaintenance (maintenanceNamespaces swallows the read error).
test("deferredInitialize startup sync falls back to configured set on catalog read failure (NHZEV)", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let updateArg: string[] | undefined;
  const abortController = new AbortController();

  orchestrator.config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    qmdMaintenanceEnabled: true,
  };
  orchestrator.qmd = {
    isAvailable: () => true,
    async update() {},
  };
  orchestrator.namespaceCatalog = {
    enabled: true,
    async listNamespaces() {
      throw new Error("catalog read failed");
    },
  };
  orchestrator.namespaceSearchRouter = {
    async updateNamespaces(ns: string[]) {
      updateArg = ns;
      abortController.abort();
      return ns.length;
    },
  };

  await orchestrator.deferredInitialize(abortController.signal);

  assert.ok(updateArg, "startup updateNamespaces must be called");
  assert.deepEqual(
    [...updateArg!].sort(),
    ["default", "shared"],
    "a catalog read failure degrades startup sync to the configured set",
  );
});
