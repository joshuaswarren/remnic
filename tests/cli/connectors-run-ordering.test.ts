/**
 * Regression tests for `runConnectorPollOnce` — persist-before-cursor-advance
 * contract (Codex P1 thread on PR #753, cli.ts:4816).
 *
 * Issue: the original `remnic connectors run` CLI called `pollOnce` and wrote
 * the new cursor BEFORE persisting the fetched docs.  If the persist step
 * threw after the cursor was advanced, those docs were permanently lost.
 *
 * Fix: `runConnectorPollOnce` in `connectors-cli.ts` enforces the ordering:
 *   1. `syncFn`    — fetch new docs + next cursor
 *   2. `ingestFn`  — persist docs into memory layer
 *   3. `writeCursorFn` — advance cursor (only if step 2 succeeded)
 *
 * On any failure in steps 1 or 2, `writeCursorFn` is still called but with
 * the PRIOR cursor, so the next poll re-fetches the same document window.
 *
 * CLAUDE.md gotcha #25 — don't destroy old state before confirming new state
 * succeeds.
 * CLAUDE.md gotcha #43 — don't index content that failed to persist.
 *
 * All test data is fully synthetic (CLAUDE.md public-repo rule).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  runConnectorPollOnce,
  type RunConnectorPollOnceArgs,
} from "../../packages/remnic-core/src/connectors-cli.js";
import type {
  ConnectorCursor,
  ConnectorDocument,
  ConnectorState,
  ConnectorSyncStatus,
} from "../../packages/remnic-core/src/connectors/live/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeCursor(value: string): ConnectorCursor {
  return { kind: "pageToken", value, updatedAt: new Date().toISOString() };
}

function makeDoc(id: string): ConnectorDocument {
  return {
    id,
    title: `Doc ${id}`,
    content: `Synthetic body for ${id}`,
    source: {
      connector: "test-connector",
      externalId: id,
      fetchedAt: new Date().toISOString(),
    },
  };
}

function makePriorState(
  cursorValue: string | null,
  totalDocs = 5,
): ConnectorState {
  return {
    id: "test-connector",
    cursor: cursorValue !== null ? makeCursor(cursorValue) : null,
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "success" as ConnectorSyncStatus,
    totalDocsImported: totalDocs,
    updatedAt: new Date().toISOString(),
  };
}

/** Build a RunConnectorPollOnceArgs with overrideable stubs. */
function makeArgs(
  overrides: Partial<RunConnectorPollOnceArgs> & {
    writtenStates?: Array<Parameters<RunConnectorPollOnceArgs["writeCursorFn"]>[0]>;
    ingestedDocs?: ConnectorDocument[][];
  } = {},
): RunConnectorPollOnceArgs & {
  writtenStates: Array<Parameters<RunConnectorPollOnceArgs["writeCursorFn"]>[0]>;
  ingestedDocs: ConnectorDocument[][];
} {
  const writtenStates: Array<Parameters<RunConnectorPollOnceArgs["writeCursorFn"]>[0]> =
    overrides.writtenStates ?? [];
  const ingestedDocs: ConnectorDocument[][] = overrides.ingestedDocs ?? [];

  return {
    connectorId: "test-connector",
    priorState: makePriorState("cursor-v1"),
    syncFn: async (_cursor) => ({
      newDocs: [makeDoc("doc-1"), makeDoc("doc-2")],
      nextCursor: makeCursor("cursor-v2"),
    }),
    ingestFn: async (docs) => {
      ingestedDocs.push(docs);
    },
    writeCursorFn: async (state) => {
      writtenStates.push(state);
    },
    writtenStates,
    ingestedDocs,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

test("runConnectorPollOnce: success — ingestFn called before writeCursorFn", async () => {
  const callOrder: string[] = [];
  const args = makeArgs({
    ingestFn: async () => {
      callOrder.push("ingest");
    },
    writeCursorFn: async () => {
      callOrder.push("writeCursor");
    },
  });

  await runConnectorPollOnce(args);

  assert.deepEqual(
    callOrder,
    ["ingest", "writeCursor"],
    "ingestFn must be called before writeCursorFn",
  );
});

test("runConnectorPollOnce: success — returns correct docsImported count", async () => {
  const args = makeArgs();
  const result = await runConnectorPollOnce(args);
  assert.equal(result.docsImported, 2);
  assert.equal(result.error, undefined);
});

test("runConnectorPollOnce: success — cursor advances to nextCursor", async () => {
  const args = makeArgs();
  await runConnectorPollOnce(args);

  assert.equal(args.writtenStates.length, 1);
  assert.equal(args.writtenStates[0].cursor?.value, "cursor-v2");
  assert.equal(args.writtenStates[0].lastSyncStatus, "success");
});

test("runConnectorPollOnce: success — totalDocsImported accumulates", async () => {
  const args = makeArgs({
    priorState: makePriorState("cursor-v1", 10),
    syncFn: async () => ({
      newDocs: [makeDoc("doc-a"), makeDoc("doc-b"), makeDoc("doc-c")],
      nextCursor: makeCursor("cursor-v3"),
    }),
  });
  await runConnectorPollOnce(args);

  assert.equal(args.writtenStates[0].totalDocsImported, 13);
});

test("runConnectorPollOnce: success — all fetched docs passed to ingestFn", async () => {
  const args = makeArgs();
  await runConnectorPollOnce(args);

  assert.equal(args.ingestedDocs.length, 1);
  assert.equal(args.ingestedDocs[0].length, 2);
  assert.equal(args.ingestedDocs[0][0].id, "doc-1");
  assert.equal(args.ingestedDocs[0][1].id, "doc-2");
});

test("runConnectorPollOnce: no new docs — ingestFn NOT called, cursor advances", async () => {
  const ingestCalls: number[] = [];
  const args = makeArgs({
    syncFn: async () => ({
      newDocs: [],
      nextCursor: makeCursor("cursor-v2"),
    }),
    ingestFn: async () => {
      ingestCalls.push(1);
    },
  });

  const result = await runConnectorPollOnce(args);

  assert.equal(ingestCalls.length, 0, "ingestFn must not be called when there are no new docs");
  assert.equal(result.docsImported, 0);
  assert.equal(args.writtenStates[0].cursor?.value, "cursor-v2");
  assert.equal(args.writtenStates[0].lastSyncStatus, "success");
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 regression: ingestFn throws — cursor must NOT advance
// ─────────────────────────────────────────────────────────────────────────────

test("runConnectorPollOnce: ingestFn throws — cursor stays at prior value (P1 regression)", async () => {
  // This is the core regression case for Codex P1 thread PRRT_kwDORJXyws59sjWO.
  // When ingestFn (the doc-persist step) throws, the cursor MUST remain at the
  // prior value so the next poll re-fetches the same document window.
  const priorCursorValue = "cursor-old";
  const args = makeArgs({
    priorState: makePriorState(priorCursorValue),
    syncFn: async () => ({
      newDocs: [makeDoc("lost-doc")],
      nextCursor: makeCursor("cursor-new"),
    }),
    ingestFn: async () => {
      throw new Error("disk full");
    },
  });

  const result = await runConnectorPollOnce(args);

  // Result must indicate failure.
  assert.equal(result.docsImported, 0);
  assert.ok(result.error?.includes("disk full"), "error must propagate to result");

  // Cursor must NOT have advanced to "cursor-new".
  assert.equal(args.writtenStates.length, 1, "writeCursorFn must be called exactly once (error path)");
  assert.equal(
    args.writtenStates[0].cursor?.value,
    priorCursorValue,
    "cursor must stay at prior value when ingestFn throws — docs must not be lost",
  );
  assert.equal(args.writtenStates[0].lastSyncStatus, "error");
  assert.ok(
    args.writtenStates[0].lastSyncError?.includes("disk full"),
    "lastSyncError must contain the thrown message",
  );
});

test("runConnectorPollOnce: ingestFn throws — totalDocsImported stays at prior value", async () => {
  const priorTotal = 17;
  const args = makeArgs({
    priorState: makePriorState("cursor-v1", priorTotal),
    ingestFn: async () => {
      throw new Error("network error");
    },
  });

  await runConnectorPollOnce(args);

  assert.equal(
    args.writtenStates[0].totalDocsImported,
    priorTotal,
    "totalDocsImported must not increase when ingestFn throws",
  );
});

test("runConnectorPollOnce: ingestFn throws — writeCursorFn still called (error state persisted)", async () => {
  // Even on failure, writeCursorFn must be called so the error status is
  // persisted and visible in `remnic connectors status`.
  const args = makeArgs({
    ingestFn: async () => {
      throw new Error("transient");
    },
  });

  await runConnectorPollOnce(args);

  assert.equal(args.writtenStates.length, 1);
  assert.equal(args.writtenStates[0].lastSyncStatus, "error");
});

// ─────────────────────────────────────────────────────────────────────────────
// syncFn throws — cursor must NOT advance
// ─────────────────────────────────────────────────────────────────────────────

test("runConnectorPollOnce: syncFn throws — cursor stays at prior value", async () => {
  const priorCursorValue = "cursor-before-sync-fail";
  const args = makeArgs({
    priorState: makePriorState(priorCursorValue),
    syncFn: async () => {
      throw new Error("auth_expired");
    },
  });

  const result = await runConnectorPollOnce(args);

  assert.equal(result.docsImported, 0);
  assert.ok(result.error?.includes("auth_expired"));
  assert.equal(args.writtenStates[0].cursor?.value, priorCursorValue);
  assert.equal(args.writtenStates[0].lastSyncStatus, "error");
});

test("runConnectorPollOnce: syncFn throws — ingestFn never called", async () => {
  const ingestCalls: number[] = [];
  const args = makeArgs({
    syncFn: async () => {
      throw new Error("rate_limited");
    },
    ingestFn: async () => {
      ingestCalls.push(1);
    },
  });

  await runConnectorPollOnce(args);

  assert.equal(ingestCalls.length, 0, "ingestFn must not be called when syncFn throws");
});

// ─────────────────────────────────────────────────────────────────────────────
// Null prior state (first ever sync)
// ─────────────────────────────────────────────────────────────────────────────

test("runConnectorPollOnce: null priorState — syncs from scratch and advances cursor", async () => {
  const args = makeArgs({ priorState: null });
  const result = await runConnectorPollOnce(args);

  assert.equal(result.docsImported, 2);
  assert.equal(result.error, undefined);
  assert.equal(args.writtenStates[0].cursor?.value, "cursor-v2");
  assert.equal(args.writtenStates[0].totalDocsImported, 2);
});

test("runConnectorPollOnce: null priorState — ingestFn throws — null cursor retained", async () => {
  const args = makeArgs({
    priorState: null,
    ingestFn: async () => {
      throw new Error("storage_unavailable");
    },
  });

  const result = await runConnectorPollOnce(args);

  assert.equal(result.docsImported, 0);
  assert.ok(result.error?.includes("storage_unavailable"));
  // null priorState means null cursor must be written back.
  assert.equal(
    args.writtenStates[0].cursor,
    null,
    "null prior cursor must be retained on ingest failure",
  );
  assert.equal(args.writtenStates[0].totalDocsImported, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 regression: writeCursorFn throws on error path — must not mask ingest err
// (Codex thread PRRT_kwDORJXyws59sk8K, Cursor thread PRRT_kwDORJXyws59slAG)
// ─────────────────────────────────────────────────────────────────────────────

test("runConnectorPollOnce: writeCursorFn throws on error path — original ingest error is returned", async () => {
  // When ingestFn throws (primary failure) AND writeCursorFn also throws
  // (secondary failure, e.g. disk full trying to persist error state), the
  // caller must see the ORIGINAL ingest error — not the cursor-write error.
  // The state-write failure is logged but must not replace the primary error.
  const args = makeArgs({
    ingestFn: async () => {
      throw new Error("original_ingest_error");
    },
    writeCursorFn: async () => {
      throw new Error("cursor_write_failed");
    },
  });

  const result = await runConnectorPollOnce(args);

  assert.equal(result.docsImported, 0);
  assert.ok(
    result.error?.includes("original_ingest_error"),
    `expected original_ingest_error in result.error, got: ${result.error}`,
  );
  assert.ok(
    !result.error?.includes("cursor_write_failed"),
    "cursor_write_failed must NOT replace the primary ingest error in result.error",
  );
  assert.ok(
    result.stateWriteError?.includes("cursor_write_failed"),
    `expected cursor_write_failed in stateWriteError, got: ${result.stateWriteError}`,
  );
});

test("runConnectorPollOnce: writeCursorFn throws on error path — promise still resolves (no unhandled rejection)", async () => {
  // Even if both ingestFn and writeCursorFn throw, runConnectorPollOnce must
  // resolve (not reject) so cli.ts can render the error to the operator.
  const args = makeArgs({
    syncFn: async () => {
      throw new Error("sync_failed");
    },
    writeCursorFn: async () => {
      throw new Error("state_write_failed");
    },
  });

  // Must not throw/reject — should resolve with the original sync error.
  const result = await runConnectorPollOnce(args);

  assert.equal(result.docsImported, 0);
  assert.ok(result.error?.includes("sync_failed"));
  assert.ok(result.stateWriteError?.includes("state_write_failed"));
});

test("runConnectorPollOnce: writeCursorFn throws on success path — docsImported preserved, stateWriteError set", async () => {
  // Codex P1 thread PRRT_kwDORJXyws59sm76, Cursor thread PRRT_kwDORJXyws59sm_N.
  //
  // On the SUCCESS path, if writeCursorFn throws AFTER docs are already
  // ingested, the result MUST:
  //   1. report the actual docsImported count (docs ARE in the memory layer)
  //   2. set stateWriteError (not error) so the operator can distinguish a
  //      cursor-persistence failure from a sync/ingest failure
  //   3. leave result.error undefined (the ingest itself succeeded)
  //
  // The docs were successfully ingested — reporting docsImported: 0 would
  // mislead the operator into thinking no data was written.
  const args = makeArgs({
    writeCursorFn: async () => {
      throw new Error("success_cursor_write_failed");
    },
  });

  const result = await runConnectorPollOnce(args);

  // Docs were already ingested — must reflect the real count.
  assert.equal(
    result.docsImported,
    2,
    "docsImported must reflect actual ingested count even when cursor write fails",
  );
  // The cursor-write failure goes into stateWriteError, NOT error.
  assert.ok(
    result.stateWriteError?.includes("success_cursor_write_failed"),
    `expected stateWriteError to contain cursor-write message, got: ${result.stateWriteError}`,
  );
  // error must be undefined — the sync/ingest path was clean.
  assert.equal(
    result.error,
    undefined,
    "result.error must be undefined when only the cursor write failed",
  );
});

test("runConnectorPollOnce: writeCursorFn throws on success path — no new docs — stateWriteError set, docsImported 0", async () => {
  // Edge case: zero new docs + cursor write failure.  docsImported should be 0
  // (correctly reflecting no new docs) and stateWriteError should be set.
  const args = makeArgs({
    syncFn: async () => ({
      newDocs: [],
      nextCursor: makeCursor("cursor-v2"),
    }),
    writeCursorFn: async () => {
      throw new Error("cursor_write_zero_docs");
    },
  });

  const result = await runConnectorPollOnce(args);

  assert.equal(result.docsImported, 0);
  assert.ok(result.stateWriteError?.includes("cursor_write_zero_docs"));
  assert.equal(result.error, undefined);
});
