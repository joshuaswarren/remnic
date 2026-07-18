import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import type { BufferSurpriseProbe } from "./buffer.js";
import type { BufferState, BufferTurn } from "./types.js";

class FakeStorage {
  public saved: BufferState | null = null;
  public saveCount = 0;

  constructor(private readonly initial: BufferState) {}

  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }

  async saveBuffer(state: BufferState): Promise<void> {
    this.saveCount += 1;
    this.saved = structuredClone(state);
  }
}

class DelayedBufferStorage {
  public saved: BufferState | null = null;

  async loadBuffer(): Promise<BufferState> {
    await delay(10);
    return structuredClone(this.saved ?? {
      turns: [],
      lastExtractionAt: null,
      extractionCount: 0,
    });
  }

  async saveBuffer(state: BufferState): Promise<void> {
    await delay(10);
    this.saved = structuredClone(state);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-12T12:00:00.000Z",
    sessionKey,
  };
}

test("SmartBuffer keeps logical session buffers isolated", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha memory"));
  await buffer.addTurn("thread-b", makeTurn("thread-b", "beta memory"));

  assert.equal(buffer.getTurns("thread-a").length, 1);
  assert.equal(buffer.getTurns("thread-a")[0]?.content, "alpha memory");
  assert.equal(buffer.getTurns("thread-b").length, 1);
  assert.equal(buffer.getTurns("thread-b")[0]?.content, "beta memory");
});

test("SmartBuffer keeps dangerous keys isolated from safe-prefix lookalikes", async () => {
  for (const [dangerousKey, lookalikeKey] of [
    ["__proto__", "__safe___proto__"],
    ["constructor", "__safe_constructor"],
  ] as const) {
    const storage = new FakeStorage({
      turns: [],
      lastExtractionAt: null,
      extractionCount: 0,
    });
    const buffer = new SmartBuffer(parseConfig({}), storage as any);

    await buffer.addTurn(lookalikeKey, makeTurn(lookalikeKey, "lookalike memory"));
    await buffer.addTurn(dangerousKey, makeTurn(dangerousKey, "dangerous memory"));

    assert.equal(buffer.getTurns(lookalikeKey).length, 1);
    assert.equal(buffer.getTurns(lookalikeKey)[0]?.content, "lookalike memory");
    assert.equal(buffer.getTurns(dangerousKey).length, 1);
    assert.equal(buffer.getTurns(dangerousKey)[0]?.content, "dangerous memory");

    await buffer.clearAfterExtraction(dangerousKey);

    assert.equal(buffer.getTurns(dangerousKey).length, 0);
    assert.equal(buffer.getTurns(lookalikeKey).length, 1);
    assert.equal(buffer.getTurns(lookalikeKey)[0]?.content, "lookalike memory");
  }
});

test("SmartBuffer serializes concurrent addTurn mutations", async () => {
  const storage = new DelayedBufferStorage();
  const buffer = new SmartBuffer(parseConfig({ bufferSaveDebounceMs: 0 }), storage as unknown as ConstructorParameters<typeof SmartBuffer>[1]);

  await Promise.all([
    buffer.addTurn("thread-a", makeTurn("thread-a", "alpha memory")),
    buffer.addTurn("thread-a", makeTurn("thread-a", "beta memory")),
  ]);

  const turns = storage.saved?.entries?.["thread-a"]?.turns ?? [];
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => turn.content).sort(),
    ["alpha memory", "beta memory"],
  );
});

test("SmartBuffer ignores stale surprise promotion after newer turns arrive", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  let resolveFirstProbe = (_score: number): void => {
    throw new Error("first surprise probe did not start");
  };
  let markFirstProbeStarted = (): void => {
    throw new Error("probe start marker was not initialized");
  };
  const firstProbeStarted = new Promise<void>((resolve) => {
    markFirstProbeStarted = resolve;
  });
  const probe: BufferSurpriseProbe = {
    async scoreTurn(_bufferKey, turn) {
      if (turn.content !== "turn A") return null;
      markFirstProbeStarted();
      return new Promise<number>((probeResolve) => {
        resolveFirstProbe = probeResolve;
      });
    },
  };
  const buffer = new SmartBuffer(
    parseConfig({
      bufferSurpriseTriggerEnabled: true,
      bufferSurpriseThreshold: 0.35,
      bufferSurpriseProbeTimeoutMs: 10_000,
      triggerMode: "smart",
    }),
    storage as any,
    probe,
  );

  const firstOutcomePromise = buffer.addTurnWithOutcome(
    "thread-a",
    makeTurn("thread-a", "turn A"),
  );
  await firstProbeStarted;

  const secondOutcome = await buffer.addTurnWithOutcome(
    "thread-a",
    makeTurn("thread-a", "turn B"),
  );
  assert.deepEqual(secondOutcome, { decision: "keep_buffering" });

  resolveFirstProbe(1);
  const firstOutcome = await firstOutcomePromise;

  assert.deepEqual(firstOutcome, { decision: "keep_buffering" });
  assert.deepEqual(
    buffer.getTurns("thread-a").map((turn) => turn.content),
    ["turn A", "turn B"],
  );
});

test("SmartBuffer clearAfterExtraction only clears the targeted logical session", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha memory"));
  await buffer.addTurn("thread-b", makeTurn("thread-b", "beta memory"));
  await buffer.clearAfterExtraction("thread-a");

  assert.equal(buffer.getTurns("thread-a").length, 0);
  assert.equal(buffer.getTurns("thread-b").length, 1);
  assert.equal(buffer.getExtractionCount("thread-a"), 1);
  assert.equal(buffer.getExtractionCount("thread-b"), 0);
});

test("SmartBuffer clearAfterExtraction preserves appends after queued snapshots", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "first memory"));
  const firstSnapshot = buffer.getTurns("thread-a");
  await buffer.addTurn("thread-a", makeTurn("thread-a", "second memory"));
  const overlappingSnapshot = buffer.getTurns("thread-a");
  await buffer.addTurn("thread-a", makeTurn("thread-a", "third memory"));

  await buffer.clearAfterExtraction("thread-a", firstSnapshot);
  assert.deepEqual(
    buffer.getTurns("thread-a").map((turn) => turn.content),
    ["second memory", "third memory"],
  );

  await buffer.clearAfterExtraction("thread-a", overlappingSnapshot);
  assert.deepEqual(
    buffer.getTurns("thread-a").map((turn) => turn.content),
    ["third memory"],
  );
});

test("SmartBuffer clearAfterExtraction chooses the longest queued snapshot overlap", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "repeat"));
  await buffer.addTurn("thread-a", makeTurn("thread-a", "middle"));
  await buffer.addTurn("thread-a", makeTurn("thread-a", "repeat"));
  await buffer.addTurn("thread-a", makeTurn("thread-a", "tail"));
  const fullSnapshot = buffer.getTurns("thread-a");

  await buffer.clearAfterExtraction("thread-a", fullSnapshot.slice(0, 2));
  assert.deepEqual(
    buffer.getTurns("thread-a").map((turn) => turn.content),
    ["repeat", "tail"],
  );

  await buffer.clearAfterExtraction("thread-a", fullSnapshot);
  assert.deepEqual(buffer.getTurns("thread-a"), []);
});

test("SmartBuffer clearAfterExtraction clears live copies of retained snapshots", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "first memory"));
  await buffer.addTurn("thread-a", makeTurn("thread-a", "second memory"));
  const extractionSnapshot = buffer.getTurns("thread-a");

  await buffer.retainDeferredTurns("thread-a", extractionSnapshot, 2);
  await buffer.clearAfterExtraction("thread-a", extractionSnapshot);

  assert.deepEqual(
    buffer.getTurns("thread-a").map((turn) => turn.content),
    ["first memory", "second memory"],
  );
  assert.equal(
    storage.saved?.entries?.["thread-a"]?.turns.length,
    0,
    "live turns must be cleared even when retained copies are preserved",
  );
});

test("SmartBuffer read-only accessors do not persist phantom entries for unknown buffers", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({ bufferSaveDebounceMs: 0 }), storage as unknown as ConstructorParameters<typeof SmartBuffer>[1]);

  assert.deepEqual(buffer.getTurns("missing-thread"), []);
  assert.equal(buffer.getExtractionCount("missing-thread"), 0);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha memory"));

  assert.ok(storage.saved);
  assert.deepEqual(Object.keys(storage.saved?.entries ?? {}).sort(), ["default", "thread-a"]);
});

test("SmartBuffer can recover a logical buffer key from a raw session key", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      default: {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
      "codex-thread:thread-22::principal:cli": {
        turns: [
          {
            ...makeTurn("session-z", "gamma memory"),
            logicalSessionKey: "codex-thread:thread-22",
          },
        ],
        lastExtractionAt: null,
        extractionCount: 0,
      },
    },
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  const resolved = await buffer.findBufferKeyForSession("session-z");

  assert.equal(resolved, "codex-thread:thread-22::principal:cli");
});

test("SmartBuffer finds every buffer key that still carries turns for a session", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      default: {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
      "session-z": {
        turns: [makeTurn("session-z", "raw memory")],
        lastExtractionAt: null,
        extractionCount: 0,
      },
      "codex-thread:thread-22::principal:cli": {
        turns: [
          {
            ...makeTurn("session-z", "logical memory"),
            logicalSessionKey: "codex-thread:thread-22",
          },
        ],
        lastExtractionAt: null,
        extractionCount: 0,
      },
    },
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  const resolved = await buffer.findBufferKeysForSession("session-z");

  assert.deepEqual(resolved, [
    "session-z",
    "codex-thread:thread-22::principal:cli",
  ]);
});

test("SmartBuffer prunes stale logical session buffers to a bounded entry set", async () => {
  const entries = Object.fromEntries(
    Array.from({ length: 205 }, (_, index) => [
      `thread-${index}`,
      {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
    ]),
  );
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      default: {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
      ...entries,
    },
  });
  const buffer = new SmartBuffer(parseConfig({ bufferSaveDebounceMs: 0 }), storage as unknown as ConstructorParameters<typeof SmartBuffer>[1]);

  await buffer.addTurn("active-thread", makeTurn("active-thread", "pending memory"));

  const persistedKeys = Object.keys(storage.saved?.entries ?? {});
  assert.equal(persistedKeys.length, 200);
  assert.ok(persistedKeys.includes("default"));
  assert.ok(persistedKeys.includes("active-thread"));
  assert.ok(persistedKeys.includes("thread-204"));
  assert.ok(!persistedKeys.includes("thread-0"));
});

// ---------------------------------------------------------------------------
// Issue #562 PR 2 — defer retention
// ---------------------------------------------------------------------------

test("retainDeferredTurns preserves turns across clearAfterExtraction", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "deferred context one"));
  await buffer.addTurn("thread-a", makeTurn("thread-a", "deferred context two"));

  const liveTurns = buffer.getTurns("thread-a");
  assert.equal(liveTurns.length, 2);

  await buffer.retainDeferredTurns("thread-a", liveTurns);
  await buffer.clearAfterExtraction("thread-a");

  const afterClear = buffer.getTurns("thread-a");
  assert.equal(afterClear.length, 2, "Retained turns must survive clearAfterExtraction");
  assert.equal(afterClear[0]?.content, "deferred context one");
  assert.equal(afterClear[1]?.content, "deferred context two");
});

test("retainDeferredTurns respects the max tail size", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  const turns = Array.from({ length: 5 }, (_, i) =>
    makeTurn("thread-a", `turn ${i}`),
  );

  await buffer.retainDeferredTurns("thread-a", turns, 2);
  const retained = buffer.getRetainedDeferredTurns("thread-a");
  assert.equal(retained.length, 2);
  assert.equal(retained[0]?.content, "turn 3");
  assert.equal(retained[1]?.content, "turn 4");
});

test("retainDeferredTurns with empty array clears the retention slot", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.retainDeferredTurns("thread-a", [makeTurn("thread-a", "x")], 5);
  assert.equal(buffer.getRetainedDeferredTurns("thread-a").length, 1);

  await buffer.retainDeferredTurns("thread-a", []);
  assert.equal(buffer.getRetainedDeferredTurns("thread-a").length, 0);
});

test("retainDeferredTurns with max=0 clears the retention slot (slice -0 guard)", async () => {
  // CLAUDE.md gotcha 27: `slice(-0)` equals `slice(0)` and would return all
  // entries. The implementation must guard against this.
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.retainDeferredTurns("thread-a", [makeTurn("thread-a", "x")], 5);
  assert.equal(buffer.getRetainedDeferredTurns("thread-a").length, 1);

  await buffer.retainDeferredTurns(
    "thread-a",
    [makeTurn("thread-a", "should-not-appear")],
    0,
  );
  assert.equal(
    buffer.getRetainedDeferredTurns("thread-a").length,
    0,
    "max=0 must clear the slot, not return all turns",
  );
});

test("getTurns prepends retained deferred turns before live turns", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.retainDeferredTurns(
    "thread-a",
    [makeTurn("thread-a", "old deferred context")],
    10,
  );
  await buffer.addTurn("thread-a", makeTurn("thread-a", "new live turn"));

  const all = buffer.getTurns("thread-a");
  assert.equal(all.length, 2);
  assert.equal(all[0]?.content, "old deferred context");
  assert.equal(all[1]?.content, "new live turn");
});

test("SmartBuffer prefers pruning empty entries and bounds pending-turn buffers at the cap (#1908 policy)", async () => {
  // Pre-#1908 this contract was "never prune non-empty entries". With retry
  // retention (failed extractions keep their turns), unbounded non-empty
  // growth during a provider outage would eventually OOM the daemon — the
  // documented policy (#1908 step 7) is: retain up to MAX_BUFFER_ENTRY_COUNT
  // session entries, then prune the OLDEST sessions with a loud warning.
  // Empty entries are still evicted first.
  const entries = Object.fromEntries(
    Array.from({ length: 205 }, (_, index) => [
      `thread-${index}`,
      {
        turns: [makeTurn(`thread-${index}`, `memory ${index}`)],
        lastExtractionAt: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
        extractionCount: 0,
      },
    ]),
  );
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      default: {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
      ...entries,
    },
  });
  const buffer = new SmartBuffer(parseConfig({ bufferSaveDebounceMs: 0 }), storage as unknown as ConstructorParameters<typeof SmartBuffer>[1]);

  await buffer.addTurn("active-thread", makeTurn("active-thread", "pending memory"));

  const persistedKeys = Object.keys(storage.saved?.entries ?? {});
  assert.ok(persistedKeys.length <= 201, `bounded at the cap plus default (got ${persistedKeys.length})`);
  assert.ok(persistedKeys.includes("default"), "default entry never pruned");
  assert.ok(persistedKeys.includes("active-thread"), "the just-written key is retained");
  assert.ok(!persistedKeys.includes("thread-0"), "oldest pending entry pruned once over the cap");
  assert.ok(persistedKeys.includes("thread-204"), "newest pending entry survives");
});

test("pruneEntries evicts oldest NON-empty session entries past the cap (#1908 retry-retention bound)", async () => {
  // Retained failed extractions keep their turns in the buffer, so during a
  // provider outage non-empty entries can exceed MAX_BUFFER_ENTRY_COUNT (200).
  // The cap is the documented bound: the oldest non-empty sessions must be
  // evicted (loudly) rather than growing without bound (codex review).
  const entries: NonNullable<BufferState["entries"]> = {};
  for (let i = 0; i < 210; i += 1) {
    const at = new Date(1_700_000_000_000 + i * 60_000).toISOString();
    entries[`session-${String(i).padStart(3, "0")}`] = {
      turns: [{ role: "user", content: `retained turn ${i}`, timestamp: at, sessionKey: `session-${i}` }],
      lastExtractionAt: at,
      extractionCount: 0,
    };
  }
  const storage = new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0, entries });
  const buffer = new SmartBuffer(parseConfig({ bufferSaveDebounceMs: 0 }), storage as unknown as ConstructorParameters<typeof SmartBuffer>[1]);
  await buffer.load();
  await buffer.addTurn("session-newest", makeTurn("session-newest", "new turn"));

  const savedKeys = Object.keys(storage.saved?.entries ?? {});
  assert.ok(savedKeys.length <= 200, `entries bounded at MAX_BUFFER_ENTRY_COUNT (got ${savedKeys.length})`);
  assert.ok(savedKeys.includes("session-newest"), "the just-written key is retained");
  assert.equal(buffer.getTurns("session-000").length, 0, "oldest non-empty entry was evicted");
  assert.ok(buffer.getTurns("session-209").length > 0, "newest pre-existing entry survives");
});

// ---------------------------------------------------------------------------
// Issue #1909 (Part D) — debounced buffer save
// ---------------------------------------------------------------------------

function emptyBufferState(): BufferState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

interface DebouncedBufferInternals {
  saveTimer: NodeJS.Timeout | null;
  pendingSave: boolean;
}

test("debounce on: N keep_buffering turns coalesce into one save on flush", async () => {
  const storage = new FakeStorage(emptyBufferState());
  // Large window + high turn cap so every turn keeps buffering (no trigger).
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 10_000, triggerMode: "smart", bufferMaxTurns: 100 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  for (let i = 0; i < 5; i += 1) {
    const decision = await buffer.addTurn("thread-a", makeTurn("thread-a", `turn ${i}`));
    assert.equal(decision, "keep_buffering");
  }
  assert.equal(storage.saveCount, 0, "steady-state buffering does zero full serializations");

  await buffer.flushPendingSave();
  assert.equal(storage.saveCount, 1, "the trailing-edge flush writes exactly once");
  assert.equal(storage.saved?.entries?.["thread-a"]?.turns.length, 5, "flush persists all buffered turns");

  // Idempotent: a second flush with nothing pending does not write again.
  await buffer.flushPendingSave();
  assert.equal(storage.saveCount, 1, "flushPendingSave is idempotent");
});

test("debounce on: an extraction-triggering turn forces an immediate save", async () => {
  const storage = new FakeStorage(emptyBufferState());
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 10_000, triggerMode: "smart", bufferMaxTurns: 1 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  const decision = await buffer.addTurn("thread-a", makeTurn("thread-a", "trigger"));
  assert.notEqual(decision, "keep_buffering", "the turn triggers extraction");
  assert.equal(storage.saveCount, 1, "the triggering turn is durable immediately, not on the debounce edge");
  assert.equal(storage.saved?.entries?.["thread-a"]?.turns.length, 1);
});

test("debounce on: clearAfterExtraction cancels the pending timer and persists post-clear state", async () => {
  const storage = new FakeStorage(emptyBufferState());
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 10_000, triggerMode: "smart", bufferMaxTurns: 100 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  await buffer.addTurn("thread-a", makeTurn("thread-a", "buffered turn"));
  assert.equal(storage.saveCount, 0, "the buffered turn's save is still pending on the timer");

  await buffer.clearAfterExtraction("thread-a");
  assert.equal(storage.saveCount, 1, "clearAfterExtraction persists exactly once (post-clear state)");
  assert.equal(storage.saved?.entries?.["thread-a"]?.turns.length, 0, "the persisted state is cleared");

  // The pending debounce timer was cancelled — it must not fire a stale write.
  const internals = buffer as unknown as DebouncedBufferInternals;
  assert.equal(internals.saveTimer, null, "no armed timer remains after clear");
  assert.equal(internals.pendingSave, false, "no pending save remains after clear");
});

test("debounce off (bufferSaveDebounceMs: 0) reproduces save-every-turn", async () => {
  const storage = new FakeStorage(emptyBufferState());
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 0, triggerMode: "smart", bufferMaxTurns: 100 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  for (let i = 0; i < 4; i += 1) {
    await buffer.addTurn("thread-a", makeTurn("thread-a", `turn ${i}`));
  }
  assert.equal(storage.saveCount, 4, "with debounce disabled every turn saves immediately");
  assert.equal(storage.saved?.entries?.["thread-a"]?.turns.length, 4);
});

test("parseConfig validates bufferSaveDebounceMs (accepts valid, defaults undefined)", () => {
  assert.equal(parseConfig({}).bufferSaveDebounceMs, 3_000, "undefined → default 3000ms");
  assert.equal(parseConfig({ bufferSaveDebounceMs: 0 }).bufferSaveDebounceMs, 0, "0 = save every turn");
  assert.equal(parseConfig({ bufferSaveDebounceMs: 5_000 }).bufferSaveDebounceMs, 5_000);
  assert.equal(
    parseConfig({ bufferSaveDebounceMs: 2_147_483_647 }).bufferSaveDebounceMs,
    2_147_483_647,
    "max (32-bit setTimeout limit) accepted",
  );
  // CLI numeric strings coerce, then validate.
  assert.equal(parseConfig({ bufferSaveDebounceMs: "5000" }).bufferSaveDebounceMs, 5_000, "numeric string coerces");
});

test("debounce on: each turn re-arms the trailing edge (save fires one window after the LAST turn)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const storage = new FakeStorage(emptyBufferState());
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 100, triggerMode: "smart", bufferMaxTurns: 10_000 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  await buffer.addTurn("thread-a", makeTurn("thread-a", "turn 0")); // schedules save at t=100
  t.mock.timers.tick(90); // t=90, before the first window closes
  await buffer.addTurn("thread-a", makeTurn("thread-a", "turn 1")); // re-arms to t=190
  t.mock.timers.tick(90); // t=180 — the ORIGINAL 100ms deadline is past
  await settle();
  assert.equal(storage.saveCount, 0, "re-arm pushed the deadline; no save at the original window");

  t.mock.timers.tick(20); // t=200 — 110ms after the last turn (past the re-armed 190)
  await settle();
  assert.equal(storage.saveCount, 1, "the save fires one window after the LAST turn (true trailing edge)");
  assert.equal(storage.saved?.entries?.["thread-a"]?.turns.length, 2);
});

test("debounce on: sustained activity forces an inline save at the 5x staleness cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const storage = new FakeStorage(emptyBufferState());
  // Window 100ms → cap at 5x = 500ms of continuously-deferred pending state.
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 100, triggerMode: "smart", bufferMaxTurns: 10_000 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  // Add a turn every 80ms (< window) so the trailing-edge timer never fires —
  // each turn re-arms it. The pending save is deferred continuously.
  await buffer.addTurn("thread-a", makeTurn("thread-a", "turn 0")); // firstPendingAt = 0
  for (let elapsed = 80; elapsed <= 480; elapsed += 80) {
    t.mock.timers.tick(80);
    await buffer.addTurn("thread-a", makeTurn("thread-a", `turn @${elapsed}`));
    assert.equal(storage.saveCount, 0, `still deferred at t=${elapsed} (< 5x window)`);
  }

  // Next turn crosses t=560 (>= 500ms cap): scheduleSave forces an inline save.
  t.mock.timers.tick(80); // t=560
  await buffer.addTurn("thread-a", makeTurn("thread-a", "turn @560"));
  assert.equal(storage.saveCount, 1, "the 5x staleness cap forced an inline save mid-activity");
});

class FailOnceBufferStorage {
  public saved: BufferState | null = null;
  public saveCount = 0;
  public failNext = true;

  async loadBuffer(): Promise<BufferState> {
    return emptyBufferState();
  }

  async saveBuffer(state: BufferState): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated buffer write failure");
    }
    this.saveCount += 1;
    this.saved = structuredClone(state);
  }
}

test("debounce on: a failed flush keeps the save pending so a retry (or shutdown) persists", async () => {
  // Issue #1909 review round 2 finding 1: flushPendingSave must not clear
  // pendingSave until the write SUCCEEDS — otherwise a failed write diverges
  // memory from disk and a later shutdown flush early-returns, dropping turns.
  const storage = new FailOnceBufferStorage();
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 10_000, triggerMode: "smart", bufferMaxTurns: 10_000 }),
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  await buffer.addTurn("thread-a", makeTurn("thread-a", "buffered turn")); // schedules a save
  // First flush: the underlying write throws (swallowed, fail-open).
  await buffer.flushPendingSave();
  const internals = buffer as unknown as DebouncedBufferInternals;
  assert.equal(internals.pendingSave, true, "a failed save leaves the save pending for retry");
  assert.equal(storage.saveCount, 0, "nothing was persisted on the failed attempt");

  // Retry (mirrors the re-armed timer or graceful-shutdown flush) succeeds.
  await buffer.flushPendingSave();
  assert.equal(storage.saveCount, 1, "the retry performed exactly one successful write");
  assert.equal(
    storage.saved?.entries?.["thread-a"]?.turns.length,
    1,
    "the previously-unpersisted turn is now durable",
  );
  assert.equal(internals.pendingSave, false, "pending is cleared only after the write succeeds");
});

test("parseConfig rejects invalid bufferSaveDebounceMs (round 8: throw, do not clamp/floor)", () => {
  // Review round 8: reject invalid user input explicitly instead of silently
  // flooring fractions / clamping negatives to 0 / clamping oversized to the
  // timer max (AGENTS.md #1/#39).
  const cases: unknown[] = [
    -1, // negative
    0.5, // fraction
    3_000_000_000, // above the 32-bit setTimeout limit
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "abc", // non-numeric string
    -0.0001,
    2_147_483_648, // one past max
    null, // explicit null is invalid (only undefined defaults) — round 9 finding 1
  ];
  for (const value of cases) {
    assert.throws(
      () => parseConfig({ bufferSaveDebounceMs: value }),
      /bufferSaveDebounceMs must be an integer in \[0, 2147483647\]/,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
  // Boundary + coercion: valid inputs pass.
  assert.equal(parseConfig({ bufferSaveDebounceMs: 0 }).bufferSaveDebounceMs, 0);
  assert.equal(parseConfig({ bufferSaveDebounceMs: 2_147_483_647 }).bufferSaveDebounceMs, 2_147_483_647);
  assert.equal(parseConfig({ bufferSaveDebounceMs: "5000" }).bufferSaveDebounceMs, 5_000);
  assert.equal(parseConfig({}).bufferSaveDebounceMs, 3_000, "undefined → default");
});

test("debounce cap: the buffer never arms setTimeout above the 32-bit limit", async () => {
  // Deterministic (no real waiting): capture the delay the buffer passes to
  // setTimeout. An unclamped value > 2^31-1 is overflow-clamped by Node to 1ms;
  // the buffer-side Math.min prevents that even when a directly-constructed
  // config bypassed parseConfig's cap.
  const config = parseConfig({ triggerMode: "smart", bufferMaxTurns: 10_000 });
  config.bufferSaveDebounceMs = 3_000_000_000;
  const storage = new FakeStorage(emptyBufferState());
  const buffer = new SmartBuffer(
    config,
    storage as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );

  const timerGlobal = globalThis as unknown as { setTimeout: typeof setTimeout };
  const realSetTimeout = timerGlobal.setTimeout;
  const armedDelays: number[] = [];
  const fakeHandle = { unref() {}, ref() {} } as unknown as NodeJS.Timeout;
  timerGlobal.setTimeout = ((_fn: (...a: unknown[]) => void, delay?: number) => {
    if (typeof delay === "number") armedDelays.push(delay);
    // Do not schedule the real callback — we only assert on the delay argument.
    return fakeHandle;
  }) as typeof setTimeout;
  try {
    await buffer.addTurn("thread-a", makeTurn("thread-a", "x")); // arms the debounced save
  } finally {
    timerGlobal.setTimeout = realSetTimeout;
  }

  assert.ok(armedDelays.length >= 1, "a debounced save timer was armed");
  for (const delay of armedDelays) {
    assert.ok(
      delay <= 2_147_483_647,
      `armed setTimeout delay ${delay} must be clamped to the 32-bit limit`,
    );
  }
});
