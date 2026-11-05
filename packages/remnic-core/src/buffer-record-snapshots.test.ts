import assert from "node:assert/strict";
/**
 * recordTurnUnlocked snapshot retention — issue: the per-turn mutation built
 * `priorTurns` + `activeTurnsSnapshot` + `retainedTurnsSnapshot` (two full
 * `copyBufferTurn` maps) on EVERY admitted turn, even when the decision path
 * consumes none of them: a plain `keep_buffering` turn with no surprise probe
 * eligible branch discards all three. The mutation now builds the snapshots
 * only when the decision path needs them (`keep_buffering` under an
 * eligible surprise branch, or any extraction decision), so steady-state
 * buffering performs no per-turn snapshot copies.
 *
 * Harness: an instance-level spy wraps the (private) recordTurnUnlocked and
 * captures each AddTurnMutationResult, so tests assert on exactly what the
 * mutation returned — no production instrumentation.
 */
import test from "node:test";

import { type BufferSurpriseProbe, SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
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

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-20T12:00:00.000Z",
    sessionKey,
  };
}

function emptyBuffer(): BufferState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

type MutationCapture = {
  priorTurns: BufferTurn[];
  activeTurnsSnapshot: BufferTurn[];
  retainedTurnsSnapshot: BufferTurn[];
  decision: string;
};

type RecordSpy = (bufferKey: string, turn: BufferTurn) => Promise<MutationCapture>;

function spyMutations(buffer: SmartBuffer): MutationCapture[] {
  const captures: MutationCapture[] = [];
  // SAFETY: recordTurnUnlocked is a TS-private prototype method with a stable
  // runtime shape; the spy re-exposes the identical signature on the instance.
  const original = Object.getPrototypeOf(buffer).recordTurnUnlocked as RecordSpy;
  Object.defineProperty(buffer, "recordTurnUnlocked", {
    value: async (bufferKey: string, turn: BufferTurn): Promise<MutationCapture> => {
      const result = await original.call(buffer, bufferKey, turn);
      captures.push(result);
      return result;
    },
    configurable: true,
    writable: true,
  });
  return captures;
}

function fixedScoreProbe(score: number | null): BufferSurpriseProbe & { calls: number } {
  const probe = {
    calls: 0,
    async scoreTurn(_key: string, _turn: BufferTurn, _prior: readonly BufferTurn[]): Promise<number | null> {
      probe.calls += 1;
      return score;
    },
  };
  return probe;
}

test("plain keep_buffering turn performs no snapshot copies", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const config = parseConfig({
    bufferMaxTurns: 5,
    triggerMode: "smart",
    bufferSaveDebounceMs: 0,
  });
  const buffer = new SmartBuffer(config, storage);
  const captures = spyMutations(buffer);

  const decision = await buffer.addTurn("sess-1", makeTurn("sess-1", "ordinary content"));

  assert.equal(decision, "keep_buffering");
  assert.equal(captures.length, 1);
  assert.equal(captures[0].priorTurns.length, 0, "no priorTurns copy for a decision that never reads it");
  assert.equal(captures[0].activeTurnsSnapshot.length, 0, "no active-turn snapshot copies while buffering");
  assert.equal(captures[0].retainedTurnsSnapshot.length, 0, "no retained-turn snapshot copies while buffering");
});

test("extraction decisions still carry full snapshots", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const config = parseConfig({
    bufferMaxTurns: 2,
    triggerMode: "every_n",
    bufferSaveDebounceMs: 0,
  });
  const buffer = new SmartBuffer(config, storage);
  const captures = spyMutations(buffer);

  await buffer.addTurn("sess-1", makeTurn("sess-1", "one"));
  const outcome = await buffer.addTurnWithOutcome("sess-1", makeTurn("sess-1", "two"));

  assert.equal(outcome.decision, "extract_batch");
  assert.notEqual(outcome.extractionTurns, undefined);
  assert.equal(outcome.extractionTurns?.length, 2);
  const last = captures[captures.length - 1];
  assert.equal(last.decision, "extract_batch");
  assert.equal(last.priorTurns.length, 1, "prior turn kept for extraction decisions");
  assert.equal(last.activeTurnsSnapshot.length, 2, "active snapshot kept for extraction decisions");
  assert.deepEqual(
    last.activeTurnsSnapshot.map((t) => t.content),
    ["one", "two"]
  );
});

test("surprise-eligible keep_buffering still builds the snapshots the probe path reads", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(null);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferMaxTurns: 5,
    triggerMode: "smart",
    bufferSaveDebounceMs: 0,
  });
  const buffer = new SmartBuffer(config, storage, probe);
  const captures = spyMutations(buffer);

  const decision = await buffer.addTurn("sess-1", makeTurn("sess-1", "ordinary content"));

  assert.equal(decision, "keep_buffering");
  assert.equal(probe.calls, 1, "the surprise probe must still be consulted");
  const capture = captures[0];
  assert.equal(capture.priorTurns.length, 0, "first turn has no priors");
  assert.equal(capture.activeTurnsSnapshot.length, 1, "snapshot kept while the surprise branch may promote");
  assert.equal(capture.retainedTurnsSnapshot.length, 0, "nothing retained yet");
});

test("surprise promotion still extracts from a consistent snapshot", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0.99);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferMaxTurns: 5,
    triggerMode: "smart",
    bufferSurpriseThreshold: 0.5,
    bufferSaveDebounceMs: 0,
  });
  const buffer = new SmartBuffer(config, storage, probe);

  const outcome = await buffer.addTurnWithOutcome("sess-1", makeTurn("sess-1", "novel"));

  assert.equal(outcome.decision, "extract_now");
  assert.deepEqual(
    outcome.extractionTurns?.map((t) => t.content),
    ["novel"]
  );
});

test("keep_buffering under every_n never builds snapshots even with a probe present", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0.99);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferMaxTurns: 5,
    triggerMode: "every_n",
    bufferSaveDebounceMs: 0,
  });
  const buffer = new SmartBuffer(config, storage, probe);
  const captures = spyMutations(buffer);

  const decision = await buffer.addTurn("sess-1", makeTurn("sess-1", "ordinary content"));

  assert.equal(decision, "keep_buffering");
  assert.equal(probe.calls, 0, "surprise branch is smart-mode only");
  assert.equal(captures[0].activeTurnsSnapshot.length, 0);
  assert.equal(captures[0].retainedTurnsSnapshot.length, 0);
  assert.equal(captures[0].priorTurns.length, 0);
});
