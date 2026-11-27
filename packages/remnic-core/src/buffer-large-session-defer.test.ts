import test from "node:test";
import assert from "node:assert/strict";

import {
  BufferSessionPersistence,
  BUFFER_SESSION_DEFER_MIN_BYTES,
  BUFFER_SESSION_DEFER_INTERVAL_MS,
} from "./buffer-persistence.js";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import type { BufferEntryState, BufferState, BufferTurn } from "./types.js";

const BIG_CONTENT = "x".repeat(BUFFER_SESSION_DEFER_MIN_BYTES);

function bigEntry(): BufferEntryState {
  return {
    turns: [makeTurn("big", BIG_CONTENT)],
    lastExtractionAt: null,
    extractionCount: 0,
  };
}

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-11-18T12:00:00.000Z",
    sessionKey,
  };
}

function emptyState(): BufferState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

class DeferStorage {
  readonly writes = new Map<string, number>();
  claimed = new Set<string>();
  private initial: BufferState;

  constructor(initial: BufferState) {
    this.initial = initial;
  }

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

  async deleteBufferSession(): Promise<void> {}

  isBufferSessionClaimed(key: string): boolean {
    return this.claimed.has(key);
  }

  writeCount(key: string): number {
    return this.writes.get(key) ?? 0;
  }
}

test("#3389 a large session persisted recently is deferred, not rewritten", async () => {
  const storage = new DeferStorage(emptyState());
  const entries = new Map<string, BufferEntryState>([["big", bigEntry()]]);
  const peek = (key: string) => entries.get(key);
  const persistence = new BufferSessionPersistence();
  let now = 1_000;
  const clock = () => now;

  persistence.markDirty("big");
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  assert.equal(storage.writeCount("big"), 1, "first write must land");

  persistence.markDirty("big");
  now += 1_000; // still within the defer interval
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  assert.equal(storage.writeCount("big"), 1, "recent large rewrite must defer");
  assert.equal(persistence.hasPending(), true, "deferred session stays dirty");
});

test("#3389 a large session writes again once the interval elapsed", async () => {
  const storage = new DeferStorage(emptyState());
  const entries = new Map<string, BufferEntryState>([["big", bigEntry()]]);
  const peek = (key: string) => entries.get(key);
  const persistence = new BufferSessionPersistence();
  let now = 1_000;
  const clock = () => now;

  persistence.markDirty("big");
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });

  persistence.markDirty("big");
  now += BUFFER_SESSION_DEFER_INTERVAL_MS + 1;
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  assert.equal(storage.writeCount("big"), 2, "stale large session must write");
  assert.equal(persistence.hasPending(), false);
});

test("#3389 a small session is never deferred no matter how recent", async () => {
  const storage = new DeferStorage(emptyState());
  const entries = new Map<string, BufferEntryState>([
    ["small", { turns: [makeTurn("small", "tiny")], lastExtractionAt: null, extractionCount: 0 }],
  ]);
  const peek = (key: string) => entries.get(key);
  const persistence = new BufferSessionPersistence();
  let now = 1_000;
  const clock = () => now;

  for (const _ of [1, 2, 3]) {
    persistence.markDirty("small");
    await persistence.persist(storage, emptyState(), peek, undefined, {
      now: clock,
      allowDeferral: true,
    });
    now += 1;
  }
  assert.equal(storage.writeCount("small"), 3, "small sessions keep per-flush durability");
});

test("#3389 a drain-claimed session is never deferred", async () => {
  const storage = new DeferStorage(emptyState());
  storage.claimed.add("big");
  const entries = new Map<string, BufferEntryState>([["big", bigEntry()]]);
  const peek = (key: string) => entries.get(key);
  const persistence = new BufferSessionPersistence();
  let now = 1_000;
  const clock = () => now;

  persistence.markDirty("big");
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  persistence.markDirty("big");
  now += 1;
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  assert.equal(storage.writeCount("big"), 2, "a claim must receive the entry now");
});

test("#3389 a durability-barrier pass never defers", async () => {
  const storage = new DeferStorage(emptyState());
  const entries = new Map<string, BufferEntryState>([["big", bigEntry()]]);
  const peek = (key: string) => entries.get(key);
  const persistence = new BufferSessionPersistence();
  let now = 1_000;
  const clock = () => now;

  persistence.markDirty("big");
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  persistence.markDirty("big");
  now += 1;
  await persistence.persist(storage, emptyState(), peek, undefined, { now: clock });
  assert.equal(storage.writeCount("big"), 2, "barrier passes always write");
});

test("#3389 SmartBuffer: a hot large session stops rewriting per turn (debounce off)", async () => {
  const state = emptyState();
  state.entries = { big: bigEntry() };
  const storage = new DeferStorage(state);
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1_000, bufferSaveDebounceMs: 0 }),
    storage,
  );

  await buffer.addTurn("big", makeTurn("big", "more"));
  assert.equal(storage.writeCount("big"), 1, "first write must land");

  await buffer.addTurn("big", makeTurn("big", "more"));
  await buffer.addTurn("big", makeTurn("big", "more"));
  assert.equal(storage.writeCount("big"), 1, "large session rewrite must be rate-limited");

  await buffer.addTurn("small", makeTurn("small", "a"));
  await buffer.addTurn("small", makeTurn("small", "b"));
  assert.equal(storage.writeCount("small"), 2, "small sessions keep per-turn durability");

  await buffer.save();
  assert.equal(storage.writeCount("big"), 2, "barrier pass writes the deferred session");
});

test("#3389 SmartBuffer: an extraction-trigger turn stays durable on a large session", async () => {
  const state = emptyState();
  state.entries = { big: bigEntry() };
  const storage = new DeferStorage(state);
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 2, bufferSaveDebounceMs: 0 }),
    storage,
  );

  await buffer.addTurn("big", makeTurn("big", "more"));
  assert.equal(storage.writeCount("big"), 1);
  const decision = await buffer.addTurn("big", makeTurn("big", "trigger"));
  assert.equal(decision, "extract_batch");
  assert.equal(storage.writeCount("big"), 2, "the durability barrier must not defer");
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function realtimeClock(offset = 1_000): () => number {
  const t0 = performance.now();
  return () => offset + (performance.now() - t0);
}

test("#3389 a deferred large session lands when its interval elapses — no new turn required", async () => {
  const state = emptyState();
  state.entries = { big: bigEntry() };
  const storage = new DeferStorage(state);
  const persistence = new BufferSessionPersistence({
    now: realtimeClock(),
    deferIntervalMs: 120,
  });
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1_000, bufferSaveDebounceMs: 0 }),
    storage,
    null,
    { persistence },
  );

  await buffer.addTurn("big", makeTurn("big", "more"));
  assert.equal(storage.writeCount("big"), 1, "first write must land");

  await buffer.addTurn("big", makeTurn("big", "more"));
  const deadline = Date.now() + 2_000;
  while (storage.writeCount("big") < 2 && Date.now() < deadline) await sleep(20);
  assert.equal(
    storage.writeCount("big"),
    2,
    "the deferred session must persist once its interval elapses, without another turn",
  );
});

test("#3389 a backend without isBufferSessionClaimed is never deferred (claim state unknown)", async () => {
  class ClaimlessStorage {
    readonly writes = new Map<string, number>();
    private initial: BufferState;
    constructor(initial: BufferState) {
      this.initial = initial;
    }
    async loadBuffer(): Promise<BufferState> {
      return structuredClone(this.initial);
    }
    async saveBuffer(next: BufferState): Promise<void> {
      this.initial = structuredClone(next);
    }
    async saveBufferSession(key: string, entry: BufferEntryState): Promise<void> {
      this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
      void entry;
    }
    async deleteBufferSession(): Promise<void> {}
  }
  const storage = new ClaimlessStorage(emptyState());
  const entries = new Map<string, BufferEntryState>([["big", bigEntry()]]);
  const peek = (key: string) => entries.get(key);
  const persistence = new BufferSessionPersistence();
  let now = 1_000;
  const clock = () => now;

  persistence.markDirty("big");
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  assert.equal(storage.writes.get("big"), 1, "first write must land");

  persistence.markDirty("big");
  now += 1;
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  assert.equal(
    storage.writes.get("big"),
    2,
    "unknown claim state must not defer: a claimed session would starve its drain",
  );
});

test("#3389 a debounced retry after a failed save keeps session-level deferral", async () => {
  class FlakyStorage extends DeferStorage {
    private failed = false;
    async saveBufferSession(key: string, entry: BufferEntryState): Promise<void> {
      if (key === "small" && !this.failed) {
        this.failed = true;
        throw new Error("transient write failure");
      }
      return super.saveBufferSession(key, entry);
    }
  }
  const state = emptyState();
  state.entries = {
    big: bigEntry(),
    small: { turns: [makeTurn("small", "tiny")], lastExtractionAt: null, extractionCount: 0 },
  };
  const storage = new FlakyStorage(state);
  const persistence = new BufferSessionPersistence({ now: realtimeClock() });
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1_000, bufferSaveDebounceMs: 5 }),
    storage,
    null,
    { persistence },
  );

  await buffer.addTurn("big", makeTurn("big", "more"));
  const firstWriteDeadline = Date.now() + 2_000;
  while (storage.writeCount("big") < 1 && Date.now() < firstWriteDeadline) await sleep(10);
  assert.equal(storage.writeCount("big"), 1, "first write must land");

  await buffer.addTurn("big", makeTurn("big", "more"));
  await buffer.addTurn("small", makeTurn("small", "more"));
  const retryDeadline = Date.now() + 2_000;
  while (storage.writeCount("small") < 1 && Date.now() < retryDeadline) await sleep(10);
  assert.equal(storage.writeCount("small"), 1, "the retried small write must land");
  assert.equal(
    storage.writeCount("big"),
    1,
    "a steady-state retry keeps deferral instead of escalating to a barrier write",
  );

  await buffer.save();
  assert.equal(storage.writeCount("big"), 2, "the barrier still lands the session");
});

test("#3389 a session near the floor still defers once JSON overhead is counted", async () => {
  const storage = new DeferStorage(emptyState());
  const nearFloor: BufferEntryState = {
    turns: [makeTurn("big", "x".repeat(7_400_000))],
    lastExtractionAt: null,
    extractionCount: 0,
  };
  const entries = new Map<string, BufferEntryState>([["big", nearFloor]]);
  const peek = (key: string) => entries.get(key);
  const persistence = new BufferSessionPersistence();
  let now = 1_000;
  const clock = () => now;

  persistence.markDirty("big");
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  assert.equal(storage.writeCount("big"), 1, "first write must land");

  persistence.markDirty("big");
  now += 1;
  await persistence.persist(storage, emptyState(), peek, undefined, {
    now: clock,
    allowDeferral: true,
  });
  assert.equal(
    storage.writeCount("big"),
    1,
    "a ~7.4 MB-content session serializes past 8 MiB and must defer",
  );
});

test("#3389 a debounce-off deferred retry re-arms after a transient write failure", async () => {
  class FlakyStorage extends DeferStorage {
    private writesSeen = 0;
    async saveBufferSession(key: string, entry: BufferEntryState): Promise<void> {
      if (key === "big" && ++this.writesSeen === 2) {
        throw new Error("transient write failure");
      }
      return super.saveBufferSession(key, entry);
    }
  }
  const state = emptyState();
  state.entries = { big: bigEntry() };
  const storage = new FlakyStorage(state);
  const persistence = new BufferSessionPersistence({
    now: realtimeClock(),
    deferIntervalMs: 120,
  });
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1_000, bufferSaveDebounceMs: 0 }),
    storage,
    null,
    { persistence },
  );

  await buffer.addTurn("big", makeTurn("big", "more"));
  assert.equal(storage.writeCount("big"), 1, "first write must land");

  await buffer.addTurn("big", makeTurn("big", "more"));
  const deadline = Date.now() + 3_000;
  while (storage.writeCount("big") < 2 && Date.now() < deadline) await sleep(20);
  assert.equal(
    storage.writeCount("big"),
    2,
    "a failed deferred save must re-arm a retry even with debounce off",
  );
});
