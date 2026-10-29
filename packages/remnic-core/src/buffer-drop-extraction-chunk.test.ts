import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "./storage.js";
import type { BufferState, BufferTurn } from "./types.js";

/** A real StorageManager (so SmartBuffer gets its exact type) whose buffer I/O is in memory. */
class FakeStorage extends StorageManager {
  public saved: BufferState | null = null;
  public saveCount = 0;

  constructor(private readonly initial: BufferState) {
    super(path.join(os.tmpdir(), "remnic-fake-storage-unused"));
  }

  override async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.saved ?? this.initial);
  }

  override async saveBuffer(state: BufferState): Promise<void> {
    this.saveCount += 1;
    this.saved = structuredClone(state);
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

test("dropExtractionChunk removes the matched prefix and persists the shrink", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage);
  const turns = [
    makeTurn("s1", "turn one"),
    makeTurn("s1", "turn two"),
    makeTurn("s1", "turn three"),
  ];
  for (const turn of turns) await buffer.addTurn("s1", turn);

  const dropped = await buffer.dropExtractionChunk("s1", turns.slice(0, 2));

  assert.equal(dropped, 2);
  assert.deepEqual(
    buffer.getTurns("s1").map((turn) => turn.content),
    ["turn three"],
  );
  assert.ok(storage.saveCount > 0);
  // A drop is not an extraction: the extraction bookkeeping stays untouched.
  assert.equal(buffer.getExtractionCount("s1"), 0);
});

test("dropExtractionChunk returns zero without dropping when turns no longer match", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage);
  await buffer.addTurn("s1", makeTurn("s1", "kept turn"));

  const savesBefore = storage.saveCount;
  const dropped = await buffer.dropExtractionChunk("s1", [
    makeTurn("s1", "already extracted elsewhere"),
  ]);

  assert.equal(dropped, 0);
  assert.equal(buffer.getTurns("s1").length, 1);
  assert.equal(storage.saveCount, savesBefore);
});

test("dropExtractionChunk drops the whole matched window and empties the buffer", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage);
  const turns = [makeTurn("s1", "only turn")];
  await buffer.addTurn("s1", turns[0]!);

  const dropped = await buffer.dropExtractionChunk("s1", turns);

  assert.equal(dropped, 1);
  assert.equal(buffer.getTurns("s1").length, 0);
});
