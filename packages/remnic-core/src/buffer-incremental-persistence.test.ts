/**
 * Per-session incremental buffer persistence (SmartBuffer layer).
 *
 * Pins the hot-path contract on top of the storage primitives tested in
 * storage-buffer-sessions.test.ts:
 *
 *   - a storage that exposes saveBufferSession/deleteBufferSession gets
 *     INCREMENTAL saves: only the sessions whose state actually changed are
 *     written, only on boundaries that need durability;
 *   - sessions whose state did not change are never rewritten;
 *   - eviction and resetToEmpty delete the corresponding session files;
 *   - a legacy storage (only loadBuffer/saveBuffer) keeps the exact old
 *     whole-state behavior — existing deployments and test doubles are
 *     unaffected.
 *
 * All saves flow through SmartBuffer's mutation chain, so there is exactly
 * one writer per session file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import { StorageManager } from "./storage.js";
import type { BufferEntryState, BufferState, BufferTurn } from "./types.js";

interface SessionFileRecord {
  entry: BufferEntryState;
  writeCount: number;
}

/**
 * Storage double implementing the incremental per-session surface. Records
 * per-session writes/deletes and whole-state saves separately so tests can
 * assert exactly which files the hot path touched.
 */
class IncrementalStorage {
  readonly sessions = new Map<string, SessionFileRecord>();
  readonly deleted: string[] = [];
  wholeStateSaves = 0;
  private initial: BufferState;

  constructor(initial: BufferState) {
    this.initial = initial;
  }

  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }

  async saveBuffer(state: BufferState): Promise<void> {
    this.wholeStateSaves += 1;
    this.initial = structuredClone(state);
  }

  async saveBufferSession(key: string, entry: BufferEntryState): Promise<void> {
    const record = this.sessions.get(key) ?? { entry, writeCount: 0 };
    record.entry = structuredClone(entry);
    record.writeCount += 1;
    this.sessions.set(key, record);
  }

  async deleteBufferSession(key: string): Promise<void> {
    this.deleted.push(key);
    this.sessions.delete(key);
  }
}

/**
 * Storage double implementing ONLY the legacy whole-state surface — every
 * pre-existing test double in the repo looks like this from SmartBuffer's
 * point of view, and must keep working unchanged.
 */
class LegacyOnlyStorage {
  wholeStateSaves = 0;
  lastSaved: BufferState | null = null;

  constructor(private initial: BufferState) {}

  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }

  async saveBuffer(state: BufferState): Promise<void> {
    this.wholeStateSaves += 1;
    this.lastSaved = structuredClone(state);
  }
}

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-10-29T12:00:00.000Z",
    sessionKey,
  };
}

function emptyState(): BufferState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

test("steady-state observe persists only the active session's file", async () => {
  const storage = new IncrementalStorage(emptyState());
  const buffer = new SmartBuffer(parseConfig({ triggerMode: "every_n", bufferMaxTurns: 100 }), storage);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha"));
  await buffer.flushPendingSave();
  assert.equal(storage.wholeStateSaves, 0, "hot path fell back to whole-state save");
  assert.equal(storage.sessions.get("thread-a")?.writeCount, 1);
  assert.equal(storage.sessions.get("thread-a")?.entry.turns[0]?.content, "alpha");

  await buffer.addTurn("thread-b", makeTurn("thread-b", "beta"));
  await buffer.flushPendingSave();
  assert.equal(storage.sessions.get("thread-b")?.writeCount, 1);
  // Session A's turn did NOT touch session A's file again.
  assert.equal(storage.sessions.get("thread-a")?.writeCount, 1, "unchanged session file was rewritten");
});

test("a second turn in the same session rewrites only that session's file", async () => {
  const storage = new IncrementalStorage(emptyState());
  const buffer = new SmartBuffer(parseConfig({ triggerMode: "every_n", bufferMaxTurns: 100 }), storage);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "one"));
  await buffer.flushPendingSave();
  await buffer.addTurn("thread-a", makeTurn("thread-a", "two"));
  await buffer.flushPendingSave();

  const record = storage.sessions.get("thread-a");
  assert.equal(record?.writeCount, 2);
  assert.equal(record?.entry.turns.length, 2);
});

test("extraction-boundary turn persists inline and durably", async () => {
  const storage = new IncrementalStorage(emptyState());
  // bufferMaxTurns: 1 → the very first turn triggers extract_batch.
  const buffer = new SmartBuffer(parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1 }), storage);

  const outcome = await buffer.addTurnWithOutcome("thread-a", makeTurn("thread-a", "trigger"));
  assert.equal(outcome.decision, "extract_batch");
  // Inline save already ran inside the mutation — no flush needed.
  assert.equal(storage.sessions.get("thread-a")?.writeCount, 1);
  assert.equal(storage.wholeStateSaves, 0, "extraction boundary fell back to whole-state save");
});

test("clearAfterExtraction persists the cleared session state", async () => {
  const storage = new IncrementalStorage(emptyState());
  const buffer = new SmartBuffer(parseConfig({ triggerMode: "every_n", bufferMaxTurns: 100 }), storage);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha"));
  await buffer.flushPendingSave();
  const before = storage.sessions.get("thread-a")?.writeCount ?? 0;

  await buffer.clearAfterExtraction("thread-a");
  const record = storage.sessions.get("thread-a");
  assert.equal(record?.writeCount, before + 1, "clearAfterExtraction did not persist the session");
  assert.equal(record?.entry.turns.length, 0);
  assert.equal(record?.entry.extractionCount, 1);
});

test("evicted sessions get their files deleted", async () => {
  const storage = new IncrementalStorage(emptyState());
  const buffer = new SmartBuffer(parseConfig({ triggerMode: "every_n", bufferMaxTurns: 100 }), storage);

  // normalizeState always materializes a "default" entry, so 198 seeded
  // sessions + default = 199; new-session reaches exactly 200 (the
  // addTurnBounded cap). One more UNBOUNDED addTurn pushes to 201 and
  // pruneEntries evicts the oldest non-default session (s0).
  for (let i = 0; i < 198; i++) {
    const key = `s${i}`;
    await buffer.addTurnBounded(key, makeTurn(key, `content ${i}`));
  }
  await buffer.flushPendingSave();

  const outcome = await buffer.addTurnBounded("new-session", makeTurn("new-session", "fresh"));
  assert.notEqual(outcome, null, "addTurnBounded refused below capacity");
  await buffer.addTurn("overflow", makeTurn("overflow", "one too many"));
  // The evicted key's file deletion lands on the next persist, like any
  // other buffered state change.
  await buffer.flushPendingSave();
  assert.ok(storage.deleted.includes("s0"), "oldest session was not evicted under capacity pressure");
  assert.ok(
    storage.deleted.length > 0,
    "capacity pressure evicted entries without deleting their session files",
  );
  for (const key of storage.deleted) {
    assert.equal(storage.sessions.has(key), false, `evicted session ${key} still has a file record`);
  }
});

test("resetToEmpty drops every session file on the next persist", async () => {
  const storage = new IncrementalStorage(emptyState());
  const buffer = new SmartBuffer(parseConfig({ triggerMode: "every_n", bufferMaxTurns: 100 }), storage);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha"));
  await buffer.flushPendingSave();
  buffer.resetToEmpty();
  await buffer.flushPendingSave();
  // resetToEmpty marks every known key for deletion; deleting a key whose
  // file never existed is an ENOENT no-op on real storage (covered in the
  // storage contract tests). The session that HAD a file must be gone.
  assert.ok(storage.deleted.includes("thread-a"));
  assert.equal(storage.sessions.size, 0);
});

test("retained turns survive the per-session persist", async () => {
  const storage = new IncrementalStorage(emptyState());
  const buffer = new SmartBuffer(parseConfig({ triggerMode: "every_n", bufferMaxTurns: 100 }), storage);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha"));
  await buffer.flushPendingSave();
  await buffer.retainDeferredTurns("thread-a", [makeTurn("thread-a", "alpha")], 5);
  await buffer.flushPendingSave();

  const record = storage.sessions.get("thread-a");
  assert.equal(record?.entry.retainedTurns?.length, 1, "retained turns were not persisted");
  assert.equal(record?.entry.retainedTurns?.[0]?.content, "alpha");
});

test("buffer state survives a restart through per-session files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bufio-restart-"));
  try {
    const storage = new StorageManager(root);
    const config = parseConfig({ triggerMode: "every_n", bufferMaxTurns: 100 });
    const first = new SmartBuffer(config, storage);
    await first.addTurn("thread-a", makeTurn("thread-a", "alpha"));
    await first.addTurn("thread-b", makeTurn("thread-b", "beta"));
    await first.flushPendingSave();

    // A fresh process reads the buffer back from the per-session files.
    const second = new SmartBuffer(config, storage);
    await second.load();
    assert.equal(second.getTurns("thread-a").length, 1);
    assert.equal(second.getTurns("thread-a")[0]?.content, "alpha");
    assert.equal(second.getTurns("thread-b")[0]?.content, "beta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy-only storage keeps the whole-state saveBuffer behavior", async () => {
  const storage = new LegacyOnlyStorage(emptyState());
  const buffer = new SmartBuffer(parseConfig({ triggerMode: "every_n", bufferMaxTurns: 100 }), storage);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha"));
  await buffer.flushPendingSave();
  await buffer.addTurn("thread-b", makeTurn("thread-b", "beta"));
  await buffer.flushPendingSave();

  assert.ok(storage.wholeStateSaves >= 2, "legacy storage did not receive whole-state saves");
  assert.equal(storage.lastSaved?.entries?.["thread-a"]?.turns[0]?.content, "alpha");
  assert.equal(storage.lastSaved?.entries?.["thread-b"]?.turns[0]?.content, "beta");
});
