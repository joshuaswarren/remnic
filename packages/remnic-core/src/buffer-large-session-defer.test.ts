/**
 * Large-session rewrite deferral (issue #3389).
 *
 * A session file grows without bound while its session stays hot; the daemon
 * had a ~44 MB session receiving a turn on nearly every observe. Every
 * mutation then queued a whole-file rewrite on the serialized persist pass,
 * and `durable-bufferMs` measured ~99% of observe time (worst ~10 min).
 *
 * The fix rate-limits REWRITES of large session files on steady-state passes:
 * a dirty session at or above `BUFFER_SESSION_DEFER_MIN_BYTES` that was
 * persisted less than `BUFFER_SESSION_DEFER_INTERVAL_MS` ago stays dirty for
 * the next pass instead of being rewritten. Bounds, each pinned by a test:
 *
 *   - a session never persisted before is always written (first durability);
 *   - a drain-claimed session is never deferred (the claim must receive the
 *     entry now, or the drain stalls);
 *   - durability barriers (buffer.save, flushPendingSave throwOnFailure,
 *     extraction-trigger saves) do not defer;
 *   - small sessions keep the legacy write-every-dirty-flush cadence.
 */
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

/** Storage double recording per-session writes; optional claim flag. */
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
  // No allowDeferral: barrier pass (save / flushPendingSave / trigger).
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

  // First turn lands the session file (never-persisted → always written).
  await buffer.addTurn("big", makeTurn("big", "more"));
  assert.equal(storage.writeCount("big"), 1, "first write must land");

  // The hot session keeps buffering; its file must NOT be rewritten per turn.
  await buffer.addTurn("big", makeTurn("big", "more"));
  await buffer.addTurn("big", makeTurn("big", "more"));
  assert.equal(storage.writeCount("big"), 1, "large session rewrite must be rate-limited");

  // A small session alongside keeps per-turn durability.
  await buffer.addTurn("small", makeTurn("small", "a"));
  await buffer.addTurn("small", makeTurn("small", "b"));
  assert.equal(storage.writeCount("small"), 2, "small sessions keep per-turn durability");

  // A durability barrier flushes the deferred session now.
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
  // This turn triggers extraction (turns >= bufferMaxTurns): the triggering
  // turn must be durable before extraction runs — no deferral.
  const decision = await buffer.addTurn("big", makeTurn("big", "trigger"));
  assert.equal(decision, "extract_batch");
  assert.equal(storage.writeCount("big"), 2, "the durability barrier must not defer");
});
