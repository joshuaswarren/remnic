import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer, BufferSessionTurnRefusedError } from "./buffer.js";
import { parseConfig } from "./config.js";
import { FALLBACK_MAX_TURNS_PER_SESSION, resolveMaxTurnsPerSession } from "./buffer-session-cap.js";
import type { BufferState, BufferTurn } from "./types.js";

import type { BufferStorage } from "./buffer-persistence.js";

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

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-12T12:00:00.000Z",
    sessionKey,
  };
}

test("the per-session turn cap default outlives an extraction wedge", () => {
  assert.ok(
    FALLBACK_MAX_TURNS_PER_SESSION >= 1000,
    `the default cap (${FALLBACK_MAX_TURNS_PER_SESSION}) must hold a long outage without refusing live captures`,
  );
  assert.equal(resolveMaxTurnsPerSession(undefined), FALLBACK_MAX_TURNS_PER_SESSION);
});

test("parseConfig honours bufferMaxTurnsPerSession and defaults to the backstop", () => {
  assert.equal(parseConfig({}).bufferMaxTurnsPerSession, FALLBACK_MAX_TURNS_PER_SESSION);
  assert.equal(parseConfig({ bufferMaxTurnsPerSession: 42 }).bufferMaxTurnsPerSession, 42);
});

test("a session keeps more turns than the old 200 cap while extraction is stuck", async () => {
  const storage = new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0 });
  // SAFETY: FakeStorage implements the full BufferStorage surface the
  // constructor touches (loadBuffer/saveBuffer); the cast is exact.
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 0 }),
    storage as BufferStorage,
  );
  await buffer.load();

  const held = 250;
  for (let i = 0; i < held; i += 1) {
    await buffer.addTurnWithOutcome("wedged-session", makeTurn("wedged-session", `turn ${i}`));
  }

  assert.equal(
    buffer.getTurns("wedged-session").length,
    held,
    "a lane's turns are buffered, not refused, while extraction is stuck",
  );
});

test("a configured cap still refuses live captures once it is reached", async () => {
  const storage = new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0 });
  // SAFETY: FakeStorage implements the full BufferStorage surface the
  // constructor touches (loadBuffer/saveBuffer); the cast is exact.
  const buffer = new SmartBuffer(
    parseConfig({ bufferSaveDebounceMs: 0, bufferMaxTurnsPerSession: 4 }),
    storage as BufferStorage,
  );
  await buffer.load();

  for (let i = 0; i < 4; i += 1) {
    await buffer.addTurnWithOutcome("capped-session", makeTurn("capped-session", `turn ${i}`));
  }
  await assert.rejects(
    buffer.addTurnWithOutcome("capped-session", makeTurn("capped-session", "one too many")),
    BufferSessionTurnRefusedError,
    "the configured cap still bounds a session",
  );
});
