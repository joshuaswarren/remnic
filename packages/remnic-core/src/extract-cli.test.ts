/**
 * Tests for `extract-cli.ts` (issue #3555).
 *
 * The CLI `extract` command used to print an informational message instead of
 * triggering extraction ("For now, inform the user" — removed by the COS-743
 * no-comments sweep). These tests pin the real behavior: a non-empty buffer
 * must reach the orchestrator's extraction path with the force-flush options
 * the turn-ingestion force paths use, and an empty buffer must not extract.
 *
 * Scenarios covered:
 *   1. Empty buffer returns kind "empty" and never calls runExtraction.
 *   2. Non-empty buffer calls runExtraction once with the loaded turns and
 *      forceExtractionAttempt: true (bypass the threshold/retry gates), plus
 *      the skip thresholds used by explicit flush paths.
 *   3. The extraction result (status + persistedCount + reason) is returned
 *      to the caller for printing.
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
    timestamp: "2026-11-21T19:00:00Z",
  } as unknown as BufferTurn;
}

interface StubState {
  runExtractionCalls: Array<{
    turns: BufferTurn[];
    options: Record<string, unknown> | undefined;
  }>;
}

function stubOrchestrator(turns: BufferTurn[], state: StubState) {
  return {
    buffer: {
      load: async () => {},
      getTurns: () => turns,
    },
    runExtraction: async (
      calledTurns: BufferTurn[],
      options?: Record<string, unknown>,
    ) => {
      state.runExtractionCalls.push({ turns: calledTurns, options });
      return { status: "completed", persistedCount: calledTurns.length };
    },
  };
}

// ─── 1. Empty buffer: no extraction call ─────────────────────────────────────

test("forceExtractBufferedTurns returns empty and does not call runExtraction", async () => {
  const state: StubState = { runExtractionCalls: [] };
  const outcome = await forceExtractBufferedTurns(stubOrchestrator([], state));
  assert.equal(outcome.kind, "empty");
  assert.equal(outcome.turns, 0);
  assert.equal(state.runExtractionCalls.length, 0);
});

// ─── 2. Non-empty buffer: forced extraction with the flush options ───────────

test("forceExtractBufferedTurns calls runExtraction with the buffered turns and forceExtractionAttempt", async () => {
  const state: StubState = { runExtractionCalls: [] };
  const turns = [turn("s1", "remember the deploy key rotates Fridays")];
  const outcome = await forceExtractBufferedTurns(
    stubOrchestrator(turns, state),
  );
  assert.equal(state.runExtractionCalls.length, 1);
  const call = state.runExtractionCalls[0];
  assert.equal(call.turns, turns);
  assert.equal(call.options?.forceExtractionAttempt, true);
  assert.equal(call.options?.skipCharThreshold, true);
  assert.equal(call.options?.skipUserTurnThreshold, true);
  assert.equal(outcome.kind, "run");
});

// ─── 3. Result passthrough for CLI printing ──────────────────────────────────

test("forceExtractBufferedTurns returns status, persistedCount and reason", async () => {
  const state: StubState = { runExtractionCalls: [] };
  const orchestrator = stubOrchestrator(
    [turn("s1", "a"), turn("s1", "b")],
    state,
  );
  orchestrator.runExtraction = async () => ({
    status: "skipped",
    persistedCount: 0,
    reason: "circuit_breaker_open",
  });
  const outcome = await forceExtractBufferedTurns(orchestrator);
  assert.equal(outcome.kind, "run");
  assert.equal(outcome.turns, 2);
  assert.equal(outcome.persistedCount, 0);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.reason, "circuit_breaker_open");
});
