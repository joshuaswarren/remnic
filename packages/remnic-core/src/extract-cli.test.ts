/**
 * Tests for `extract-cli.ts` (issue #3555 + PR #3668 review round).
 *
 * The CLI extract command must drain the keys real captures buffer under.
 * Turn 1 review: getTurns() with no key reads the "default" entry, but real
 * captures buffer under their session key, so extract reported an empty
 * buffer while sessions held turns. The helper now enumerates the buffer's
 * per-key counts (the backlog scheduler's liveBufferCounts convention) and
 * drains each key with runExtraction({ bufferKey: key }) — the flush
 * convention (clearAfterExtraction targets the passed bufferKey).
 *
 * Scenarios covered:
 *   1. No buffered keys: kind "empty", runExtraction never called.
 *   2. Turns buffered under a real session key: extracted per key with
 *      bufferKey set to that key and the force-flush options.
 *   3. A skipped (failed) extraction is reported in failed so the CLI can
 *      exit nonzero; completed keys still count as drained.
 *   4. A thrown extraction is contained per key; later keys still drain.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { forceExtractBufferedTurns } from "./extract-cli.js";
import type { BufferTurn } from "./types.js";

function turn(sessionKey: string, text: string): BufferTurn {
  return {
    sessionKey,
    role: "user",
    content: text,
    timestamp: "2026-11-22T02:30:00Z",
  } as unknown as BufferTurn;
}

interface StubState {
  runExtractionCalls: Array<{
    turns: BufferTurn[];
    options: Record<string, unknown> | undefined;
  }>;
}

interface StubKey {
  turns: BufferTurn[];
  result?: { status: string; persistedCount: number; reason?: string };
  throw?: unknown;
}

/** A stub buffer whose turns live under real session keys, like live captures. */
function stubOrchestrator(keys: Record<string, StubKey>, state: StubState) {
  const counts = new Map(
    Object.entries(keys).map(
      ([key, entry]) =>
        [key, { turns: entry.turns.length, retainedTurns: 0 }] as const,
    ),
  );
  return {
    buffer: {
      load: async () => {},
      entryCounts: () => counts,
      getTurns: (bufferKey?: string) => (keys[bufferKey ?? "default"]?.turns ?? []),
    },
    runExtraction: async (
      calledTurns: BufferTurn[],
      options?: Record<string, unknown>,
    ) => {
      state.runExtractionCalls.push({ turns: calledTurns, options });
      const key = String(options?.bufferKey ?? "default");
      const entry = keys[key];
      if (entry?.throw !== undefined) throw entry.throw;
      return entry?.result ?? { status: "completed", persistedCount: calledTurns.length };
    },
  };
}

// ─── 1. Nothing buffered anywhere: no extraction call ────────────────────────

test("forceExtractBufferedTurns returns empty and does not call runExtraction", async () => {
  const state: StubState = { runExtractionCalls: [] };
  const outcome = await forceExtractBufferedTurns(stubOrchestrator({}, state));
  assert.equal(outcome.kind, "empty");
  assert.equal(state.runExtractionCalls.length, 0);
});

// ─── 2. Turns buffered under a real session key are drained per key ──────────

test("extract drains a session-keyed buffer entry with bufferKey set (PR 3668 review)", async () => {
  const state: StubState = { runExtractionCalls: [] };
  const sessionTurns = [turn("wAY:s1", "remember the deploy window")];
  const outcome = await forceExtractBufferedTurns(
    stubOrchestrator({ "wAY:s1": { turns: sessionTurns } }, state),
  );
  assert.equal(outcome.kind, "run", "a session-keyed entry must not read as empty");
  assert.equal(state.runExtractionCalls.length, 1);
  const call = state.runExtractionCalls[0];
  assert.equal(call.turns, sessionTurns);
  assert.equal(call.options?.bufferKey, "wAY:s1");
  assert.equal(call.options?.forceExtractionAttempt, true);
  assert.equal(call.options?.skipCharThreshold, true);
  assert.equal(call.options?.skipUserTurnThreshold, true);
  assert.equal(outcome.drained, 1);
  assert.equal(outcome.turns, 1);
  assert.equal(outcome.persistedCount, 1);
  assert.deepEqual(outcome.failed, []);
});

// ─── 3. A skipped extraction is reported as failed ───────────────────────────

test("a skipped extraction lands in failed; completed keys count as drained", async () => {
  const state: StubState = { runExtractionCalls: [] };
  const outcome = await forceExtractBufferedTurns(
    stubOrchestrator(
      {
        "wAY:s1": { turns: [turn("wAY:s1", "a")] },
        "wAY:s2": {
          turns: [turn("wAY:s2", "b"), turn("wAY:s2", "c")],
          result: { status: "skipped", persistedCount: 0, reason: "circuit_breaker_open" },
        },
      },
      state,
    ),
  );
  assert.equal(outcome.kind, "run");
  assert.equal(outcome.drained, 1);
  assert.equal(outcome.turns, 3);
  assert.equal(outcome.persistedCount, 1);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].key, "wAY:s2");
  assert.equal(outcome.failed[0].status, "skipped");
  assert.equal(outcome.failed[0].reason, "circuit_breaker_open");
});

// ─── 4. A thrown extraction is contained per key ─────────────────────────────

test("a thrown extraction is contained per key; later keys still drain", async () => {
  const state: StubState = { runExtractionCalls: [] };
  const outcome = await forceExtractBufferedTurns(
    stubOrchestrator(
      {
        "wAY:bad": { turns: [turn("wAY:bad", "x")], throw: new Error("provider down") },
        "wAY:ok": { turns: [turn("wAY:ok", "y")] },
      },
      state,
    ),
  );
  assert.equal(state.runExtractionCalls.length, 2, "both keys must be attempted");
  assert.equal(outcome.drained, 1);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].key, "wAY:bad");
  assert.match(String(outcome.failed[0].error), /provider down/);
});
