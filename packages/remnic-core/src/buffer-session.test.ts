import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import type { BufferState, BufferTurn } from "./types.js";

class FakeStorage {
  public saved: BufferState | null = null;

  constructor(private readonly initial: BufferState) {}

  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }

  async saveBuffer(state: BufferState): Promise<void> {
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
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

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
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

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
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

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

test("SmartBuffer never prunes logical session buffers that still have pending turns", async () => {
  const entries = Object.fromEntries(
    Array.from({ length: 205 }, (_, index) => [
      `thread-${index}`,
      {
        turns: [makeTurn(`thread-${index}`, `memory ${index}`)],
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
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("active-thread", makeTurn("active-thread", "pending memory"));

  const persistedKeys = Object.keys(storage.saved?.entries ?? {});
  assert.equal(persistedKeys.length, 207);
  assert.ok(persistedKeys.includes("default"));
  assert.ok(persistedKeys.includes("active-thread"));
  assert.ok(persistedKeys.includes("thread-0"));
  assert.ok(persistedKeys.includes("thread-204"));
});
