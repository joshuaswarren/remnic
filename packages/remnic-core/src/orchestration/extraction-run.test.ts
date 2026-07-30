/**
 * Extraction retry/backoff + circuit-breaker tests (extraction hot-loop
 * hardening). Drives a real ExtractionRunCoordinator over tmpdir StorageManager
 * instances with a fake extraction engine so the retry gate, per-fingerprint
 * backoff, provider circuit breaker, recovery, class-specific caps, the
 * never-mark-processed invariant, force-flush bypass, config parity, backoff
 * math, cache coherence, and namespace isolation are all exercised end to end.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SmartBuffer } from "../buffer.js";
import {
  ExtractionDeadlineError,
  ExtractionRunCoordinator,
  type ExtractionRunCoordinatorDeps,
  computeExtractionRetryNextEligibleMs,
  capExtractionRetryStateEntries,
  deriveTopicsFromExtraction,
} from "./extraction-run.js";
import { StorageManager } from "../storage.js";
import { parseConfig } from "../config.js";
import type { ExtractionEngine } from "../extraction.js";
import type { ThreadingManager } from "../threading.js";
import type { BufferTurn, ExtractionResult, ExtractionFailureClass, PluginConfig } from "../types.js";
import type { TierMigrationCycleSummary } from "../recall-state.js";

// ---------------------------------------------------------------------------
// Result factories
// ---------------------------------------------------------------------------

function failureResult(cls: ExtractionFailureClass): ExtractionResult {
  return {
    facts: [],
    profileUpdates: [],
    entities: [],
    questions: [],
    extractionFailure: `synthetic_${cls}`,
    extractionFailureClass: cls,
  };
}

function successResult(): ExtractionResult {
  return {
    facts: [{ content: "a durable fact", category: "fact", confidence: 0.9, tags: [] }],
    profileUpdates: [],
    entities: [],
    questions: [],
  };
}

function makeTurns(content: string): BufferTurn[] {
  return [
    {
      role: "user",
      content: `u:${content}`,
      timestamp: "2026-07-15T00:00:00Z",
      persistProcessedFingerprint: true,
    },
    {
      role: "assistant",
      content: `a:${content}`,
      timestamp: "2026-07-15T00:00:01Z",
      persistProcessedFingerprint: true,
    },
  ] as BufferTurn[];
}

const migrationSummary: TierMigrationCycleSummary = {
  trigger: "extraction",
  scanned: 0,
  migrated: 0,
  promoted: 0,
  demoted: 0,
  limit: 0,
  dryRun: false,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  config: PluginConfig;
  storageForNs: (ns: string) => Promise<StorageManager>;
  setStorageForDelay: (delayMs: number) => void;
  newCoordinator: () => ExtractionRunCoordinator;
  engineCalls: () => number;
  setRespond: (fn: (turns: BufferTurn[]) => ExtractionResult | Promise<ExtractionResult>) => void;
  setPassiveCapture: (fn: () => void | Promise<void>) => void;
  setMemoryBox: (fn: () => void | Promise<void>) => void;
  setBufferClear: (fn: () => void | Promise<void>) => void;
  setPersist: (fn: () => void | Promise<void>) => void;
  setFingerprintRecorder: (
    fn: ExtractionRunCoordinatorDeps["recordProcessedExtractionFingerprint"],
  ) => void;
  recordedProcessedCount: () => number;
  run: (
    coord: ExtractionRunCoordinator,
    content: string,
    opts?: { force?: boolean; failClosed?: boolean; writeNamespaceOverride?: string },
  ) => Promise<{ status: string; reason?: string }>;
  cleanup: () => Promise<void>;
  passiveCapture: () => { principal?: string; namespace?: string } | null;
  setThreadingBlock: (blocked: boolean) => void;
  persistCalls: () => number;
}

async function makeHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "extraction-retry-"));
  const config = parseConfig({
    memoryDir: baseDir,
    qmdEnabled: false,
    ...overrides,
  });

  const storages = new Map<string, StorageManager>();
  let storageForDelayMs = 0;
  const storageForNs = async (ns: string): Promise<StorageManager> => {
    if (storageForDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, storageForDelayMs));
    }
    let s = storages.get(ns);
    if (!s) {
      s = new StorageManager(path.join(baseDir, `ns-${ns.replace(/[^a-z0-9]+/gi, "_")}`));
      await s.ensureDirectories();
      storages.set(ns, s);
    }
    return s;
  };

  const defaultStorage = await storageForNs("default");
  const buffer = new SmartBuffer(config, defaultStorage);
  await buffer.load();
  let engineCalls = 0;
  let respond: (turns: BufferTurn[]) => ExtractionResult | Promise<ExtractionResult> = () => successResult();
  let passiveCaptureHandler: () => void | Promise<void> = async () => {};
  let passiveCapture: { principal?: string; namespace?: string } | null = null;
  let persistHandler: () => void | Promise<void> = async () => {};
  let memoryBoxHandler: () => void | Promise<void> = async () => {};
  let recordedProcessedCount = 0;
  let fingerprintRecorder:
    ExtractionRunCoordinatorDeps["recordProcessedExtractionFingerprint"] =
      async () => {};

  let threadingBlocked = false;
  let persistCalls = 0;
  const makeDeps = (): ExtractionRunCoordinatorDeps => ({
    config,
    getBuffer: () => buffer,
    getExtraction: () => ({
      extract: async (turns: Parameters<ExtractionEngine["extract"]>[0]): Promise<ExtractionResult> => {
        engineCalls += 1;
        return respond(turns as BufferTurn[]);
      },
    }),
    getStorageRouter: () => ({
      storageFor: async (ns: string) => storageForNs(ns),
    }),
    getThreading: () => ({
      processTurn: async (..._args: Parameters<ThreadingManager["processTurn"]>) => {
        if (threadingBlocked) await new Promise<void>(() => {});
        return "thread-1";
      },
      updateThreadTitle: async (..._args: Parameters<ThreadingManager["updateThreadTitle"]>) => {},
    }),
    persistExtraction: async () => {
      persistCalls += 1;
      await persistHandler();
      return { persistedIds: ["memory-1"], memoryPathById: new Map() };
    },
    maybeCapturePassiveCorrections: async (_turns, options) => {
      await passiveCaptureHandler();
      passiveCapture = { principal: options.principal, namespace: options.namespace };
    },
    resolveSelfNamespace: () => "default",
    getCodingContextForSession: () => null,
    applyCodingNamespaceOverlay: () => "default",
    boxBuilderFor: () => ({
      onExtraction: async () => {
        await memoryBoxHandler();
      },
    }),
    appendPersistedThreadEpisodes: async () => {},
    maybeScheduleConsolidation: () => {},
    requestQmdMaintenance: () => {},
    runTierMigrationCycle: async () => migrationSummary,
    getLastPersistExtractionDeferredCount: () => 0,
    recordProcessedExtractionFingerprint: async (storage, fingerprint, meta) => {
      recordedProcessedCount += 1;
      await fingerprintRecorder(storage, fingerprint, meta);
    },
  });

  return {
    config,
    storageForNs,
    setStorageForDelay: (delayMs) => {
      storageForDelayMs = delayMs;
    },
    setThreadingBlock: (blocked) => {
      threadingBlocked = blocked;
    },
    persistCalls: () => persistCalls,
    newCoordinator: () => new ExtractionRunCoordinator(makeDeps()),
    engineCalls: () => engineCalls,
    setRespond: (fn) => {
      respond = fn;
    },
    setPassiveCapture: (fn) => {
      passiveCaptureHandler = fn;
    },
    setMemoryBox: (fn) => {
      memoryBoxHandler = fn;
    },
    setBufferClear: (fn) => {
      buffer.clearAfterExtraction = async () => {
        await fn();
      };
    },
    setFingerprintRecorder: (fn) => {
      fingerprintRecorder = fn;
    },
    setPersist: (fn) => {
      persistHandler = fn;
    },
    recordedProcessedCount: () => recordedProcessedCount,
    passiveCapture: () => passiveCapture,
    run: async (coord, content, opts = {}) => {
      const result = await coord.runExtraction(makeTurns(content), {
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        clearBufferAfterExtraction: false,
        bufferKey: content,
        failOnExtractionFailure: opts.failClosed === true,
        forceExtractionAttempt: opts.force === true,
        writeNamespaceOverride: opts.writeNamespaceOverride,
      });
      return { status: result.status, reason: result.reason };
    },
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

test("context-only extraction honors scoped principal and namespace overrides", async () => {
  const harness = await makeHarness();
  try {
    const coordinator = harness.newCoordinator();
    const result = await coordinator.runExtraction(
      [
        {
          role: "user",
          content: "Please use the blue dashboard.",
          timestamp: "2026-07-15T00:00:00Z",
          sessionKey: "opaque-session",
          extractionContextOnly: true,
        },
      ],
      {
        bufferKey: "opaque-session",
        clearBufferAfterExtraction: false,
        principalOverride: "alice",
        writeNamespaceOverride: "alice-project",
      },
    );

    assert.equal(result.reason, "empty_normalized_turns");
    assert.deepEqual(harness.passiveCapture(), {
      principal: "alice",
      namespace: "alice-project",
    });
  } finally {
    await harness.cleanup();
  }
});

test("context-only extraction bounds passive capture by its deadline", async () => {
  const harness = await makeHarness();
  try {
    harness.setPassiveCapture(() => new Promise<void>(() => {}));
    const coordinator = harness.newCoordinator();
    const startedAt = Date.now();
    await assert.rejects(
      coordinator.runExtraction(
        [
          {
            role: "user",
            content: "The correction capture must not clear this buffer after its deadline.",
            timestamp: "2026-07-15T00:00:00Z",
            sessionKey: "context-only-deadline",
            extractionContextOnly: true,
          },
        ],
        {
          bufferKey: "context-only-deadline",
          clearBufferAfterExtraction: false,
          deadlineMs: startedAt + 25,
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionDeadlineError);
        assert.equal(error.stage, "during_passive_capture");
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 1_000, "passive capture must not outlive its deadline");
  } finally {
    await harness.cleanup();
  }
});

test("runExtraction aborts an in-flight provider when its deadline expires", async () => {
  const harness = await makeHarness();
  try {
    const coordinator = harness.newCoordinator();
    harness.setRespond(() => new Promise<ExtractionResult>(() => {}));
    await assert.rejects(
      coordinator.runExtraction(makeTurns("deadline"), {
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        clearBufferAfterExtraction: false,
        bufferKey: "deadline",
        deadlineMs: Date.now() + 40,
      }),
      (error: unknown) => error instanceof ExtractionDeadlineError && error.stage === "during_extract",
    );
  } finally {
    await harness.cleanup();
  }
});

test("runExtraction bounds storage preparation by its deadline", async () => {
  const scenarios = [
    {
      name: "storageFor",
      stage: "during_storage",
      configure: (harness: Harness) => harness.setStorageForDelay(100),
    },
    {
      name: "loadMeta",
      stage: "during_load_meta",
      configure: async (harness: Harness) => {
        const storage = await harness.storageForNs("default");
        const loadMeta = storage.loadMeta.bind(storage);
        storage.loadMeta = async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return loadMeta();
        };
      },
    },
    {
      name: "listEntityNames",
      stage: "during_list_entity_names",
      configure: async (harness: Harness) => {
        const storage = await harness.storageForNs("default");
        const listEntityNames = storage.listEntityNames.bind(storage);
        storage.listEntityNames = async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return listEntityNames();
        };
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const harness = await makeHarness();
    try {
      await scenario.configure(harness);
      await assert.rejects(
        harness.newCoordinator().runExtraction(makeTurns(`deadline-${scenario.name}`), {
          skipCharThreshold: true,
          skipUserTurnThreshold: true,
          clearBufferAfterExtraction: false,
          bufferKey: `deadline-${scenario.name}`,
          deadlineMs: Date.now() + 40,
        }),
        (error: unknown) => error instanceof ExtractionDeadlineError && error.stage === scenario.stage,
      );
      assert.equal(harness.engineCalls(), 0, `${scenario.name} timeout must happen before provider extraction`);
    } finally {
      await harness.cleanup();
    }
  }
});

test("runExtraction does not wait past its deadline for post-persist memory boxes", async () => {
  const harness = await makeHarness({ memoryBoxesEnabled: true });
  try {
    harness.setMemoryBox(() => new Promise<void>(() => {}));
    const startedAt = Date.now();
    const result = await harness.newCoordinator().runExtraction(makeTurns("deadline-memory-box"), {
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      clearBufferAfterExtraction: false,
      bufferKey: "deadline-memory-box",
      deadlineMs: startedAt + 200,
    });
    assert.equal(result.status, "completed");
    assert.equal(harness.persistCalls(), 1, "durable persistence must complete before helper timeout");
    assert.ok(Date.now() - startedAt < 1_500, "post-persist helper must not hold the extraction indefinitely");
  } finally {
    await harness.cleanup();
  }
});

test("runExtraction force flush reports a late deadline after clearing committed turns", async () => {
  const harness = await makeHarness();
  try {
    harness.setPersist(() => new Promise<void>((resolve) => setTimeout(resolve, 150)));
    const deadlineMs = Date.now() + 50;
    await assert.rejects(
      harness.newCoordinator().runExtraction(makeTurns("late-persist-deadline"), {
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        clearBufferAfterExtraction: true,
        bufferKey: "late-persist-deadline",
        deadlineMs,
        failOnExtractionFailure: true,
      }),
      (error: unknown) => error instanceof ExtractionDeadlineError && error.stage === "during_buffer_clear",
    );
    assert.equal(harness.persistCalls(), 1, "the late deadline must follow durable persistence");
  } finally {
    await harness.cleanup();
  }
});

test("runExtraction bounds threading pre-persist work by its deadline", async () => {
  const harness = await makeHarness({ threadingEnabled: true });
  try {
    harness.setRespond(() => successResult());
    harness.setThreadingBlock(true);
    await assert.rejects(
      harness.newCoordinator().runExtraction(makeTurns("deadline-threading"), {
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        clearBufferAfterExtraction: false,
        bufferKey: "deadline-threading",
        deadlineMs: Date.now() + 40,
      }),
      (error: unknown) => error instanceof ExtractionDeadlineError && error.stage === "during_threading",
    );
    assert.equal(harness.persistCalls(), 0, "deadline must prevent durable persistence");
  } finally {
    await harness.cleanup();
  }
  });

test("runExtraction clamps long deadline timers to the Node setTimeout limit", async () => {
  const harness = await makeHarness();
  const timerGlobal = globalThis as unknown as { setTimeout: typeof setTimeout };
  const realSetTimeout = timerGlobal.setTimeout;
  const armedDelays: number[] = [];
  timerGlobal.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (typeof delay === "number") armedDelays.push(delay);
    return realSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;
  try {
    const coordinator = harness.newCoordinator();
    await coordinator.runExtraction(makeTurns("long-deadline"), {
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      clearBufferAfterExtraction: false,
      bufferKey: "long-deadline",
      deadlineMs: Date.now() + 2_147_483_647 + 60_000,
    });
  } finally {
    timerGlobal.setTimeout = realSetTimeout;
    await harness.cleanup();
  }
  assert.ok(armedDelays.includes(2_147_483_647), `expected a clamped deadline timer, got ${armedDelays.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Backoff math (pure)
// ---------------------------------------------------------------------------

test("computeExtractionRetryNextEligibleMs: progresses through schedule and caps", () => {
  const sched = [1000, 5000, 30000];
  const cap = 60000;
  const noJitter = () => 0.5; // jitter factor = 1 exactly
  assert.equal(computeExtractionRetryNextEligibleMs(1, sched, cap, 0.2, 0, noJitter), 1000);
  assert.equal(computeExtractionRetryNextEligibleMs(2, sched, cap, 0.2, 0, noJitter), 5000);
  assert.equal(computeExtractionRetryNextEligibleMs(3, sched, cap, 0.2, 0, noJitter), 30000);
  // Past the schedule end → clamps to the last step, then to cap.
  assert.equal(computeExtractionRetryNextEligibleMs(9, sched, cap, 0.2, 0, noJitter), 30000);
  // A schedule value above the cap is clamped to the cap.
  assert.equal(computeExtractionRetryNextEligibleMs(1, [999999], cap, 0.2, 0, noJitter), cap);
});

test("computeExtractionRetryNextEligibleMs: jitter stays within +/- ratio", () => {
  const base = 10000;
  const ratio = 0.2;
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const value = computeExtractionRetryNextEligibleMs(1, [base], base * 100, ratio, 0, () => r);
    assert.ok(value >= base * (1 - ratio) - 1, `>= lower bound for rng=${r} (${value})`);
    assert.ok(value <= base * (1 + ratio) + 1, `<= upper bound for rng=${r} (${value})`);
  }
});

test("capExtractionRetryStateEntries: caps to newest and guards maxEntries<=0", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    fingerprint: `fp${i}`,
    firstFailedAt: `2026-07-15T00:00:0${i}.000Z`,
  }));
  const capped = capExtractionRetryStateEntries(entries, 3);
  assert.equal(capped.length, 3);
  assert.deepEqual(
    capped.map((e) => e.fingerprint),
    ["fp7", "fp8", "fp9"],
  );
  // maxEntries<=0 must return [] (not ALL entries via slice(-0)).
  assert.deepEqual(capExtractionRetryStateEntries(entries, 0), []);
  assert.deepEqual(capExtractionRetryStateEntries(entries, -5), []);
});
test("extraction helpers ignore malformed runtime values", () => {
  const malformed = {
    facts: [
      null,
      { tags: [42, "OK"], entityRef: 7, category: "project" },
      { tags: ["valid"], entityRef: "Entity" },
    ],
    entities: [null, 4, { name: "Tool" }],
  } as unknown as ExtractionResult;
  assert.deepEqual(deriveTopicsFromExtraction(malformed), ["ok", "project", "valid", "entity", "tool"]);
  assert.deepEqual(
    deriveTopicsFromExtraction(null as unknown as ExtractionResult),
    [],
  );
});

test("computeExtractionRetryNextEligibleMs rejects invalid numeric inputs", () => {
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(Number.NaN, [1000], 5000, 0.2, 100),
    /attempts must be a finite integer/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(0, [1000], 5000, 0.2, 100),
    /attempts must be a finite integer/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(1.5, [1000], 5000, 0.2, 100),
    /attempts must be a finite integer/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(1, [1000], Number.POSITIVE_INFINITY, 0.2, 100),
    /maxBackoffMs must be a finite number/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(1, [1000], -1, 0.2, 100),
    /maxBackoffMs must be a finite number/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(1, [1000], 5000, Number.NaN, 100),
    /jitterRatio must be a finite number/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(1, [1000], 5000, 2, 100),
    /jitterRatio must be a finite number/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(1, [1000], 5000, 0.2, 100, () => Number.NaN),
    /rng\(\) must return a finite number/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(1, [1000], 5000, 0.2, 100, () => -0.1),
    /rng\(\) must return a finite number/,
  );
  assert.throws(
    () => computeExtractionRetryNextEligibleMs(1, [1000], 5000, 0.2, 100, () => 1.1),
    /rng\(\) must return a finite number/,
  );
});

test("capExtractionRetryStateEntries rejects non-finite and fractional caps", () => {
  const entries = [{ firstFailedAt: "2026-07-15T00:00:00.000Z" }];
  assert.deepEqual(capExtractionRetryStateEntries(entries, Number.NaN), []);
  assert.deepEqual(capExtractionRetryStateEntries(entries, Number.POSITIVE_INFINITY), []);
  assert.deepEqual(capExtractionRetryStateEntries(entries, 1.5), []);
});

// ---------------------------------------------------------------------------
// Backoff eligibility gate
// ---------------------------------------------------------------------------

test("backoff: a provider_retryable failure parks the same fingerprint; extract() not called again", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 100,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    const r1 = await h.run(coord, "topic-a");
    assert.equal(r1.status, "skipped");
    assert.equal(h.engineCalls(), 1, "first attempt calls extract()");

    const r2 = await h.run(coord, "topic-a");
    assert.equal(r2.reason, "extraction_backoff");
    assert.equal(h.engineCalls(), 1, "second attempt is suppressed by backoff");

    // A distinct fingerprint is unaffected by another fingerprint's backoff.
    const r3 = await h.run(coord, "topic-b");
    assert.equal(h.engineCalls(), 2, "distinct fingerprint still runs");
    assert.equal(r3.status, "skipped");
  } finally {
    await h.cleanup();
  }
});

test("backoff: rewriting nextEligibleAt to the past re-enables the fingerprint (restart-safe hydration)", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 100,
  });
  try {
    h.setRespond(() => failureResult("provider_retryable"));
    const coord = h.newCoordinator();
    await h.run(coord, "topic-a");
    assert.equal(h.engineCalls(), 1);

    // Simulate the backoff window elapsing by rewinding the persisted state,
    // then hydrate a FRESH coordinator (as a daemon restart would).
    const storage = await h.storageForNs("default");
    const meta = await storage.loadMeta();
    assert.equal(meta.extractionRetryState?.length, 1, "failure persisted to meta.json");
    meta.extractionRetryState = (meta.extractionRetryState ?? []).map((e) => ({
      ...e,
      nextEligibleAt: "2000-01-01T00:00:00.000Z",
    }));
    await storage.saveMeta(meta);

    h.setRespond(() => successResult());
    const coord2 = h.newCoordinator();
    const r = await h.run(coord2, "topic-a");
    assert.equal(h.engineCalls(), 2, "eligible-again fingerprint runs after restart hydration");
    assert.equal(r.status, "completed");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

test("circuit breaker: opens after threshold failures and suppresses distinct fingerprints", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 2,
    extractionBreakerCooldownMs: 3_600_000,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coord, "fp-1");
    await h.run(coord, "fp-2");
    assert.equal(h.engineCalls(), 2, "two distinct fingerprints failed, tripping the breaker");
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "open");

    // A THIRD distinct fingerprint is short-circuited without calling extract().
    const r = await h.run(coord, "fp-3");
    assert.equal(r.reason, "provider_circuit_open");
    assert.equal(h.engineCalls(), 2, "breaker-open suppresses distinct fingerprints too");
  } finally {
    await h.cleanup();
  }
});

test("circuit breaker: a forced flush still calls extract() while the breaker is open and records the failure", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 1,
    extractionBreakerCooldownMs: 3_600_000,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coord, "fp-1");
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "open");
    assert.equal(h.engineCalls(), 1);

    // Force-flush bypasses the gate (rule 18) but still records the failure.
    const r = await h.run(coord, "fp-2", { force: true });
    assert.equal(h.engineCalls(), 2, "forced attempt calls extract() despite open breaker");
    assert.equal(r.status, "skipped");
    const storage = await h.storageForNs("default");
    const meta = await storage.loadMeta();
    const fps = (meta.extractionRetryState ?? []).map((e) => e.fingerprint);
    assert.equal(fps.length, 2, "forced failure was recorded into retry state");
  } finally {
    await h.cleanup();
  }
});

test("circuit breaker: a forced local prefilter skip does not heal an open breaker", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 1,
    extractionBreakerCooldownMs: 3_600_000,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coord, "fp-1");
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "open");

    h.setRespond(() => ({
      ...emptySuccessResult(),
      extractionSkippedReason: "mechanical_telemetry",
    }));
    const result = await h.run(coord, "fp-2", { force: true });

    assert.equal(result.reason, "empty_extraction_result");
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "open");
    assert.equal(coord.getExtractionResilienceStatus().breaker.consecutiveFailures, 1);
  } finally {
    await h.cleanup();
  }
});

test("circuit breaker: auth_config failure opens the breaker immediately (no hot loop)", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 100, // far above one failure
    extractionBreakerAuthCooldownMs: 3_600_000,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("auth_config"));
    await h.run(coord, "fp-1");
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "open");

    const r = await h.run(coord, "fp-2");
    assert.equal(r.reason, "provider_circuit_open");
    assert.equal(h.engineCalls(), 1, "one auth_config failure suppresses subsequent extraction");
  } finally {
    await h.cleanup();
  }
});

test("recovery: half-open probe succeeds → breaker closes", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 1,
    extractionBreakerCooldownMs: 0, // cooldown already elapsed on the next call
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coord, "fp-1");
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "open");

    // Cooldown 0 → next call flips open→half_open and allows one probe.
    h.setRespond(() => successResult());
    const r = await h.run(coord, "fp-2");
    assert.equal(r.status, "completed", "half-open probe runs");
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "closed");
    assert.equal(coord.getExtractionResilienceStatus().breaker.consecutiveFailures, 0);
  } finally {
    await h.cleanup();
  }
});

test("recovery: a FAILED half-open probe re-opens the breaker (cursor review)", async () => {
  // An auth_config failure trips the breaker below the consecutive-failure
  // threshold. After the auth cooldown elapses (half_open), a transient probe
  // failure must re-open the breaker — not leave it stuck half_open where it
  // no longer suppresses anything.
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 100, // auth trips below threshold
    extractionBreakerAuthCooldownMs: 0, // half-open on the next call
    extractionBreakerCooldownMs: 3_600_000, // a re-open parks for a long time
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("auth_config"));
    await h.run(coord, "fp-a"); // auth failure → breaker opens immediately
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "open");

    // Auth cooldown 0 → this call flips open→half_open and probes; the probe
    // fails transiently → the breaker must re-open with the transient cooldown.
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coord, "fp-b");
    assert.equal(
      coord.getExtractionResilienceStatus().breaker.state,
      "open",
      "failed half-open probe re-opens the breaker",
    );

    // While re-opened, a third fingerprint is suppressed without calling extract().
    const calls = h.engineCalls();
    const r3 = await h.run(coord, "fp-c");
    assert.equal(r3.reason, "provider_circuit_open", "re-opened breaker suppresses");
    assert.equal(h.engineCalls(), calls, "no extract() call while re-opened");
  } finally {
    await h.cleanup();
  }
});

test("recovery: a successful extract clears the fingerprint's retry state so it proceeds again", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 100,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coord, "fp-1"); // fail → parked
    await h.run(coord, "fp-1"); // suppressed
    assert.equal(h.engineCalls(), 1);

    h.setRespond(() => successResult());
    await h.run(coord, "fp-1", { force: true }); // forced probe succeeds → clears state
    assert.equal(h.engineCalls(), 2);
    assert.equal(coord.getExtractionResilienceStatus().backoffFingerprintCount, 0, "retry state cleared on success");

    // Same fingerprint, non-forced, now proceeds because the entry cleared.
    await h.run(coord, "fp-1");
    assert.equal(h.engineCalls(), 3, "cleared fingerprint runs without the gate");
  } finally {
    await h.cleanup();
  }
});

test("recovery: a successful FORCED flush on a fresh coordinator clears a persisted backoff entry (cursor/codex review)", async () => {
  // A forced flush bypasses the retry gate and never hydrates the in-memory
  // mirror, so the success-heal path must still clear the persisted meta entry
  // — otherwise a stale backoff survives a successful forced flush and keeps
  // blocking normal extraction until the timer expires.
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 100,
  });
  try {
    const coordA = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coordA, "fp-heal"); // fail → parked, persisted to meta.json
    const storage = await h.storageForNs("default");
    let meta = await storage.loadMeta();
    assert.equal((meta.extractionRetryState ?? []).length, 1, "failure persisted");

    // Fresh coordinator (mirror empty, namespace not hydrated) — forced success.
    const coordB = h.newCoordinator();
    h.setRespond(() => successResult());
    await h.run(coordB, "fp-heal", { force: true });

    meta = await storage.loadMeta();
    assert.equal(
      (meta.extractionRetryState ?? []).length,
      0,
      "successful forced flush must clear the persisted backoff entry",
    );
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Class-specific caps
// ---------------------------------------------------------------------------

test("parse_empty: long-parks a fingerprint after extractionParseEmptyMaxAttempts", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [1000],
    extractionRetryMaxBackoffMs: 9_000_000,
    extractionParseEmptyMaxAttempts: 2,
    extractionBreakerFailureThreshold: 100,
    extractionRetryJitterRatio: 0,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("parse_empty"));
    // Force each attempt so the gate does not suppress; drive past the cap.
    await h.run(coord, "fp-1", { force: true });
    await h.run(coord, "fp-1", { force: true });
    await h.run(coord, "fp-1", { force: true }); // attempt 3 > cap of 2 → long-park

    const storage = await h.storageForNs("default");
    const meta = await storage.loadMeta();
    const entry = (meta.extractionRetryState ?? [])[0];
    assert.ok(entry, "retry state entry exists");
    assert.equal(entry.attempts, 3);
    assert.equal(entry.lastFailureClass, "parse_empty");
    const parkMs = Date.parse(entry.nextEligibleAt) - Date.now();
    assert.ok(parkMs > 8_000_000, `long-parked to ~maxBackoff (got ${parkMs}ms)`);
    assert.equal(h.recordedProcessedCount(), 0, "parse_empty fingerprint is never marked processed");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Invariant guard (regression): never mark processed on failure
// ---------------------------------------------------------------------------

test("invariant: a failing extraction never records a processed fingerprint", async () => {
  const h = await makeHarness({ extractionBreakerFailureThreshold: 100 });
  try {
    const coord = h.newCoordinator();
    for (const cls of ["provider_retryable", "parse_empty", "auth_config"] as ExtractionFailureClass[]) {
      h.setRespond(() => failureResult(cls));
      await h.run(coord, `fp-${cls}`, { force: true });
    }
    assert.equal(h.recordedProcessedCount(), 0, "no processed fingerprint recorded across all failure classes");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Config parity: extractionRetryEnabled=false restores pre-change behavior
// ---------------------------------------------------------------------------

test("extractionRetryEnabled=false: extractor is called on every observe with no gate", async () => {
  const h = await makeHarness({
    extractionRetryEnabled: false,
    extractionBreakerFailureThreshold: 1,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coord, "fp-1");
    await h.run(coord, "fp-1");
    await h.run(coord, "fp-1");
    assert.equal(h.engineCalls(), 3, "no backoff/breaker gate when the feature is disabled");
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "closed");
    const storage = await h.storageForNs("default");
    const meta = await storage.loadMeta();
    assert.equal((meta.extractionRetryState ?? []).length, 0, "no retry state persisted when disabled");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Cache coherence across instances
// ---------------------------------------------------------------------------

test("cache coherence: a failure recorded by one coordinator gates a second over the same meta", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 100,
  });
  try {
    const coordA = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coordA, "shared-fp");
    assert.equal(h.engineCalls(), 1);

    // A second coordinator over the same memory dir hydrates from meta.json and
    // honors the persisted backoff without calling extract().
    const coordB = h.newCoordinator();
    const r = await h.run(coordB, "shared-fp");
    assert.equal(r.reason, "extraction_backoff");
    assert.equal(h.engineCalls(), 1, "coordinator B honors coordinator A's persisted failure");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Namespace isolation vs. provider-global breaker
// ---------------------------------------------------------------------------

test("namespace isolation: per-fingerprint backoff is namespace-scoped; breaker is provider-global", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 100, // keep the breaker closed for the per-fp assertion
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    // Same fingerprint content, routed to namespace A → parked in A only.
    await h.run(coord, "same-content", { writeNamespaceOverride: "nsA" });
    assert.equal(h.engineCalls(), 1);
    const rA = await h.run(coord, "same-content", { writeNamespaceOverride: "nsA" });
    assert.equal(rA.reason, "extraction_backoff", "namespace A fingerprint is parked");
    assert.equal(h.engineCalls(), 1);

    // The identical content routed to namespace B is NOT gated by A's backoff.
    const rB = await h.run(coord, "same-content", { writeNamespaceOverride: "nsB" });
    assert.equal(h.engineCalls(), 2, "namespace B is not gated by namespace A's per-fingerprint backoff");
    assert.equal(rB.status, "skipped");

    // Meta isolation: each namespace persists only its own retry state.
    const metaA = await (await h.storageForNs("nsA")).loadMeta();
    const metaB = await (await h.storageForNs("nsB")).loadMeta();
    assert.equal((metaA.extractionRetryState ?? []).length, 1);
    assert.equal((metaB.extractionRetryState ?? []).length, 1);
  } finally {
    await h.cleanup();
  }
});

test("namespace isolation: the provider breaker suppresses extraction across namespaces", async () => {
  const h = await makeHarness({
    extractionRetryScheduleMs: [3_600_000],
    extractionBreakerFailureThreshold: 1,
    extractionBreakerCooldownMs: 3_600_000,
  });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    await h.run(coord, "fp-a", { writeNamespaceOverride: "nsA" });
    assert.equal(coord.getExtractionResilienceStatus().breaker.state, "open");

    // A different namespace is still suppressed — the breaker is provider-global.
    const r = await h.run(coord, "fp-b", { writeNamespaceOverride: "nsB" });
    assert.equal(r.reason, "provider_circuit_open");
    assert.equal(h.engineCalls(), 1, "provider-global breaker suppresses namespace B too");
  } finally {
    await h.cleanup();
  }
});


// ---------------------------------------------------------------------------
// Extraction liveness watermark (#2223): a successfully parsed extraction must
// advance lastExtractionAt even when it emits no durable objects. Normal live
// turns do not set persistProcessedFingerprint, which is the gap case.
// ---------------------------------------------------------------------------

function emptySuccessResult(): ExtractionResult {
  return { facts: [], profileUpdates: [], entities: [], questions: [] };
}

// Normal live turns (TurnIngestionCoordinator.processTurn path) do NOT set
// persistProcessedFingerprint — the case the pre-#2223 watermark stamp skipped.
function liveTurns(content: string): BufferTurn[] {
  return [
    { role: "user", content: `u:${content}`, timestamp: "2026-07-15T00:00:00Z" },
    { role: "assistant", content: `a:${content}`, timestamp: "2026-07-15T00:00:01Z" },
  ] as BufferTurn[];
}

test("extraction liveness (#2223): a normal live empty success advances lastExtractionAt without persisting memories", async () => {
  const h = await makeHarness();
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => emptySuccessResult());
    const storage = await h.storageForNs("default");
    const before = await storage.loadMeta();
    const baselineCount = before.extractionCount;

    const result = await coord.runExtraction(liveTurns("nothing-durable-here"), {
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      clearBufferAfterExtraction: true,
      bufferKey: "nothing-durable-here",
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "empty_extraction_result");
    assert.equal(h.persistCalls(), 0, "no durable memories persisted for an empty result");

    const after = await storage.loadMeta();
    assert.equal(after.extractionCount, baselineCount + 1, "empty success increments extractionCount");
    assert.ok(after.lastExtractionAt, "empty success stamps lastExtractionAt");
    assert.equal(h.recordedProcessedCount(), 0, "normal live turns never record a processed fingerprint");
  } finally {
    await h.cleanup();
  }
});

test("extraction liveness (#2227): prefilter skips do not advance the watermark", async () => {
  for (const extractionSkippedReason of [
    "conversation_only_non_memory",
    "mechanical_telemetry",
  ] as const) {
    const h = await makeHarness();
    try {
      h.setRespond(() => ({ ...emptySuccessResult(), extractionSkippedReason }));
      const storage = await h.storageForNs("default");
      const before = await storage.loadMeta();

      const result = await h.newCoordinator().runExtraction(liveTurns(extractionSkippedReason), {
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        clearBufferAfterExtraction: true,
        bufferKey: extractionSkippedReason,
      });

      assert.equal(result.reason, "empty_extraction_result");
      const after = await storage.loadMeta();
      assert.equal(after.extractionCount, before.extractionCount);
      assert.equal(after.lastExtractionAt, before.lastExtractionAt);
    } finally {
      await h.cleanup();
    }
  }
});

test("extraction liveness (#2227): passive-correction failure prevents a live empty-success stamp", async () => {
  const h = await makeHarness();
  try {
    h.setRespond(() => emptySuccessResult());
    h.setPassiveCapture(() => {
      throw new Error("passive capture failed");
    });
    const storage = await h.storageForNs("default");
    const before = await storage.loadMeta();

    await assert.rejects(
      h.newCoordinator().runExtraction(liveTurns("passive-capture-failure"), {
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        clearBufferAfterExtraction: true,
        bufferKey: "passive-capture-failure",
      }),
      /passive capture failed/,
    );

    const after = await storage.loadMeta();
    assert.equal(after.extractionCount, before.extractionCount);
    assert.equal(after.lastExtractionAt, before.lastExtractionAt);
  } finally {
    await h.cleanup();
  }
});

test("extraction liveness (#2227): buffer-clear failure prevents a live empty-success stamp", async () => {
  const h = await makeHarness();
  try {
    h.setRespond(() => emptySuccessResult());
    h.setBufferClear(() => {
      throw new Error("buffer clear failed");
    });
    const storage = await h.storageForNs("default");
    const before = await storage.loadMeta();

    await assert.rejects(
      h.newCoordinator().runExtraction(liveTurns("buffer-clear-failure"), {
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        clearBufferAfterExtraction: true,
        bufferKey: "buffer-clear-failure",
      }),
      /buffer clear failed/,
    );

    const after = await storage.loadMeta();
    assert.equal(after.extractionCount, before.extractionCount);
    assert.equal(after.lastExtractionAt, before.lastExtractionAt);
  } finally {
    await h.cleanup();
  }
});

test("extraction liveness (#2227): a fingerprinted prefilter skip persists dedupe state without stamping liveness", async () => {
  const h = await makeHarness();
  try {
    h.setRespond(() => ({
      ...emptySuccessResult(),
      extractionSkippedReason: "mechanical_telemetry",
    }));
    h.setFingerprintRecorder(async (_storage, fingerprint, meta) => {
      assert.ok(meta, "empty-success commit supplies preloaded metadata");
      meta.processedExtractionFingerprints = [
        ...(meta.processedExtractionFingerprints ?? []),
        { fingerprint, observedAt: new Date().toISOString() },
      ];
    });
    const storage = await h.storageForNs("default");
    const before = await storage.loadMeta();
    const baselineFingerprintCount =
      before.processedExtractionFingerprints?.length ?? 0;

    const result = await h.newCoordinator().runExtraction(
      makeTurns("fingerprinted-prefilter"),
      {
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        clearBufferAfterExtraction: true,
        bufferKey: "fingerprinted-prefilter",
      },
    );

    assert.equal(result.reason, "empty_extraction_result");
    const after = await storage.loadMeta();
    assert.equal(after.extractionCount, before.extractionCount);
    assert.equal(after.lastExtractionAt, before.lastExtractionAt);
    assert.equal(
      after.processedExtractionFingerprints?.length,
      baselineFingerprintCount + 1,
    );
    assert.equal(h.recordedProcessedCount(), 1);
  } finally {
    await h.cleanup();
  }
});

test("extraction liveness (#2223): a fingerprinted empty success advances the watermark once and records the fingerprint once", async () => {
  const h = await makeHarness();
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => emptySuccessResult());
    const storage = await h.storageForNs("default");
    const before = await storage.loadMeta();
    const baselineCount = before.extractionCount;

    const result = await coord.runExtraction(makeTurns("fingerprinted-empty"), {
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      clearBufferAfterExtraction: false,
      bufferKey: "fingerprinted-empty",
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "empty_extraction_result");
    assert.equal(h.persistCalls(), 0);

    const after = await storage.loadMeta();
    assert.equal(after.extractionCount, baselineCount + 1, "fingerprinted empty success increments extractionCount exactly once");
    assert.ok(after.lastExtractionAt, "fingerprinted empty success stamps lastExtractionAt");
    assert.equal(h.recordedProcessedCount(), 1, "processed fingerprint recorded exactly once");
  } finally {
    await h.cleanup();
  }
});

test("extraction liveness (#2223): a non-empty success advances lastExtractionAt", async () => {
  const h = await makeHarness();
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => successResult());
    const storage = await h.storageForNs("default");
    const before = await storage.loadMeta();
    const baselineCount = before.extractionCount;

    const result = await coord.runExtraction(makeTurns("durable-fact"), {
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      clearBufferAfterExtraction: false,
      bufferKey: "durable-fact",
    });

    assert.equal(result.status, "completed");
    assert.ok(h.persistCalls() >= 1);

    const after = await storage.loadMeta();
    assert.equal(after.extractionCount, baselineCount + 1, "non-empty success increments extractionCount");
    assert.ok(after.lastExtractionAt, "non-empty success stamps lastExtractionAt");
  } finally {
    await h.cleanup();
  }
});

test("extraction liveness (#2223): a provider failure does not advance lastExtractionAt", async () => {
  const h = await makeHarness({ extractionBreakerFailureThreshold: 100 });
  try {
    const coord = h.newCoordinator();
    h.setRespond(() => failureResult("provider_retryable"));
    const storage = await h.storageForNs("default");
    const before = await storage.loadMeta();
    const baselineWatermark = before.lastExtractionAt;
    const baselineCount = before.extractionCount;

    const result = await coord.runExtraction(makeTurns("failing-extraction"), {
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      clearBufferAfterExtraction: false,
      bufferKey: "failing-extraction",
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "empty_extraction_result");

    const after = await storage.loadMeta();
    assert.equal(after.lastExtractionAt, baselineWatermark, "failure must not stamp lastExtractionAt");
    assert.equal(after.extractionCount, baselineCount, "failure must not increment extractionCount");
  } finally {
    await h.cleanup();
  }
});