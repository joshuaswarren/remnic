// Trigger-drain tests: an extraction window that exceeds the local model's
// learned context budget must be drained chunk by chunk (each success clears
// its chunk), and a chunk that keeps failing must be dropped after N
// consecutive failures (with a side-file copy) so a session cannot stall
// forever. Covers TurnIngestionCoordinator.queueBufferedExtraction drain
// gating: explicit drains (replay/import, force flush, accepted captures)
// are never chunked or dropped.
import test from "node:test";
import assert from "node:assert/strict";
import { TurnIngestionCoordinator } from "../packages/remnic-core/src/orchestration/turn-ingestion.js";
import type { ExtractionRunCoordinator, ExtractionRunResult } from "../packages/remnic-core/src/orchestration/extraction-run.js";
import type { BufferTurn } from "@remnic/core/types";

type RunExtractionOptions = Parameters<ExtractionRunCoordinator["runExtraction"]>[1];

interface DrainFixture {
  coordinator: TurnIngestionCoordinator;
  runs: { turns: BufferTurn[]; options: RunExtractionOptions }[];
  dropped: { bufferKey: string; turns: BufferTurn[] }[];
  sideFiles: { bufferKey: string; reason: string; turns: BufferTurn[] }[];
  settled: { error?: unknown; result?: unknown }[];
  tasks: Promise<void>[];
}

type FakeRunResult = {
  status: "completed" | "skipped";
  reason?: string;
  retainedBuffer?: boolean;
  persistedCount?: number;
  durableOutputCount?: number;
};

function makeTurn(content: string, sessionKey = "sess-1"): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-10-29T00:00:00.000Z",
    sessionKey,
  };
}

function drainFixture(options: {
  runResults: Array<FakeRunResult | Error>;
  budget: number;
  dropAfterFailures: number;
  bufferTurns?: BufferTurn[];
  sideFileFails?: boolean;
  minUserTurns?: number;
}): DrainFixture {
  const runs: DrainFixture["runs"] = [];
  const dropped: DrainFixture["dropped"] = [];
  const sideFiles: DrainFixture["sideFiles"] = [];
  const settled: DrainFixture["settled"] = [];
  const bufferTurns = options.bufferTurns ?? [];
  const tasks: Promise<void>[] = [];
  const fake = {
    config: {
      extractionChunkDropAfterFailures: options.dropAfterFailures,
      extractionMinUserTurns: options.minUserTurns ?? 1,
    },
    extractionQueueCoordinator: {
      enqueue: (fn: () => Promise<void>) => {
        const task = fn().catch(() => {});
        tasks.push(task);
        return true;
      },
      runPreemptable: (
        _preemptable: boolean,
        parent: AbortSignal | undefined,
        fn: (signal: AbortSignal) => Promise<void>,
      ) => fn(parent ?? new AbortController().signal),
    },
    extractionWindowBudgetChars: () => options.budget,
    buffer: {
      getTurns: () => bufferTurns,
      dropExtractionChunk: async (bufferKey: string, turns: readonly BufferTurn[]) => {
        dropped.push({ bufferKey, turns: [...turns] });
        return turns.length;
      },
    },
    getStorage: async () => ({
      saveDroppedExtractionChunk: async (
        bufferKey: string,
        reason: string,
        turns: readonly BufferTurn[],
      ) => {
        if (options.sideFileFails === true) throw new Error("dropped dir is read-only");
        sideFiles.push({ bufferKey, reason, turns: [...turns] });
        return `/state/dropped/${bufferKey}.json`;
      },
    }),
    shouldQueueExtraction: () => true,
    runExtraction: async (turns: BufferTurn[], runOptions: RunExtractionOptions) => {
      const next = options.runResults[runs.length];
      runs.push({ turns: [...turns], options: runOptions });
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error(`unexpected extraction attempt #${runs.length}`);
      const result: ExtractionRunResult = {
        status: next.status,
        persistedCount: next.persistedCount ?? 0,
        durableOutputCount: next.durableOutputCount ?? 0,
      };
      if (next.reason !== undefined) result.reason = next.reason;
      if (next.retainedBuffer !== undefined) result.retainedBuffer = next.retainedBuffer;
      return result;
    },
  };
  // SAFETY: the drain path exercises only these deps members; the rest of
  // TurnIngestionDeps is unused on this surface.
  const coordinator = new TurnIngestionCoordinator(fake as any);
  return { coordinator, runs, dropped, sideFiles, settled, tasks };
}

async function drain(fixture: DrainFixture, turns: BufferTurn[]): Promise<void> {
  const queued = fixture.coordinator.queueBufferedExtraction(turns, "trigger_mode", {
    bufferKey: "sess-1",
    onTaskSettled: (error, result) => fixture.settled.push({ error, result }),
  });
  await queued;
  // queueBufferedExtraction resolves when the work is QUEUED; settleTask
  // fires inside the queued callback, so await it before asserting.
  await fixture.tasks[fixture.tasks.length - 1];
}

test("oversized trigger window is extracted chunk by chunk and every success drains", async () => {
  const turns = [
    makeTurn("a".repeat(40)),
    makeTurn("b".repeat(40)),
    makeTurn("c".repeat(40)),
    makeTurn("d".repeat(40)),
  ];
  const fixture = drainFixture({
    runResults: [
      { status: "completed", persistedCount: 1, durableOutputCount: 2 },
      { status: "completed", persistedCount: 1, durableOutputCount: 2 },
    ],
    budget: 100,
    dropAfterFailures: 3,
  });

  await drain(fixture, turns);

  assert.equal(fixture.runs.length, 2);
  assert.ok(fixture.runs[0]!.turns.every((turn) => turn.content.length <= 100));
  assert.ok(fixture.runs[1]!.turns.every((turn) => turn.content.length <= 100));
  assert.equal(fixture.runs[0]!.turns.length, 2);
  assert.equal(fixture.runs[1]!.turns.length, 2);
  assert.equal(fixture.dropped.length, 0);
  assert.equal(fixture.sideFiles.length, 0);
  // SAFETY: the queue settles the drain aggregate (mergeDrainResults output);
  // only these fields are asserted.
  const result = fixture.settled[0]?.result as {
    status: string;
    persistedCount: number;
    durableOutputCount: number;
  };
  assert.equal(result.status, "completed");
  assert.equal(result.persistedCount, 2);
  assert.equal(result.durableOutputCount, 4);
});

test("a failing chunk stops the drain and retains the rest without dropping", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const fixture = drainFixture({
    runResults: [{ status: "skipped", reason: "empty_extraction_result", retainedBuffer: true }],
    budget: 100,
    dropAfterFailures: 3,
  });

  await drain(fixture, turns);

  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.dropped.length, 0);
  assert.equal(fixture.sideFiles.length, 0);
});

test("a chunk is dropped after N consecutive failures, with a side-file copy, and the drain continues", async () => {
  const turns = [
    makeTurn("a".repeat(60)),
    makeTurn("b".repeat(60)),
  ];
  const fixture = drainFixture({
    runResults: [
      { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true },
      { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true },
      { status: "completed", persistedCount: 1, durableOutputCount: 1 },
    ],
    budget: 100,
    dropAfterFailures: 2,
  });

  await drain(fixture, turns);
  assert.equal(fixture.runs.length, 1, "first failure only counts, nothing is dropped");
  assert.equal(fixture.dropped.length, 0);

  await drain(fixture, turns);

  assert.equal(fixture.sideFiles.length, 1);
  assert.equal(fixture.dropped.length, 1);
  assert.equal(fixture.dropped[0]!.bufferKey, "sess-1");
  assert.equal(fixture.dropped[0]!.turns.length, 1, "only the failing chunk is dropped");
  assert.ok(fixture.sideFiles[0]!.reason.includes("repeated extraction failures"));
  assert.equal(fixture.runs.length, 3);
  assert.equal(fixture.runs[2]!.turns.length, 1, "the next chunk is attempted after the drop");
  // SAFETY: the queue settles the drain aggregate (mergeDrainResults output);
  // only these fields are asserted.
  const merged = fixture.settled[1]?.result as {
    status: string;
    persistedCount: number;
    durableOutputCount: number;
  };
  assert.equal(merged.status, "completed");
  assert.equal(merged.persistedCount, 1);
  assert.equal(merged.durableOutputCount, 1);
});

test("breaker and backoff skips defer the drain without counting failures", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const fixture = drainFixture({
    runResults: [
      { status: "skipped", reason: "provider_circuit_open" },
      { status: "skipped", reason: "extraction_backoff" },
      { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true },
    ],
    budget: 100,
    dropAfterFailures: 3,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) await drain(fixture, turns);

  assert.equal(fixture.runs.length, 3, "deferrals stop the drain but real failures still count");
  assert.equal(fixture.dropped.length, 0);
});

test("explicit drains (replay/import, force flush) are never chunked", async () => {
  const turns = [makeTurn("a".repeat(500)), makeTurn("b".repeat(500))];
  const replayFixture = drainFixture({
    runResults: [{ status: "completed", persistedCount: 1, durableOutputCount: 1 }],
    budget: 100,
    dropAfterFailures: 3,
  });
  await replayFixture.coordinator.queueBufferedExtraction(turns, "trigger_mode", {
    bufferKey: "sess-1",
    clearBufferAfterExtraction: false,
    skipDedupeCheck: true,
  });
  assert.equal(replayFixture.runs.length, 1);
  assert.equal(replayFixture.runs[0]!.turns.length, 2);

  const flushFixture = drainFixture({
    runResults: [{ status: "completed", persistedCount: 1, durableOutputCount: 1 }],
    budget: 100,
    dropAfterFailures: 3,
  });
  await flushFixture.coordinator.queueBufferedExtraction(turns, "trigger_mode", {
    bufferKey: "sess-1",
    forceExtractionAttempt: true,
    skipDedupeCheck: true,
  });
  assert.equal(flushFixture.runs.length, 1);
  assert.equal(flushFixture.runs[0]!.turns.length, 2);
});

test("accepted captures are never chunked or dropped", async () => {
  const turns: BufferTurn[] = [
    { ...makeTurn("a".repeat(500)), acceptedCapture: true },
    { ...makeTurn("b".repeat(500)), acceptedCapture: true },
  ];
  const fixture = drainFixture({
    runResults: [{ status: "completed", persistedCount: 1, durableOutputCount: 1 }],
    budget: 100,
    dropAfterFailures: 3,
    // The shared accepted-capture boundary re-reads the live buffer; expose
    // the same turns so the re-read does not look already-drained.
    bufferTurns: turns,
  });

  await drain(fixture, turns);

  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0]!.turns.length, 2);
});

test("without a finite budget the window is extracted in one run (legacy hosts)", async () => {
  const turns = [makeTurn("a".repeat(500)), makeTurn("b".repeat(500))];
  const fixture = drainFixture({
    runResults: [{ status: "completed", persistedCount: 1, durableOutputCount: 1 }],
    budget: Number.POSITIVE_INFINITY,
    dropAfterFailures: 3,
  });

  await drain(fixture, turns);

  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0]!.turns.length, 2);
});

test("a thrown extraction error counts as a chunk failure and propagates", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const fixture = drainFixture({
    runResults: [
      new Error("provider exploded"),
      { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true },
      { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true },
    ],
    budget: 100,
    dropAfterFailures: 2,
  });

  await drain(fixture, turns);
  assert.match(String(fixture.settled[0]?.error), /provider exploded/);
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.dropped.length, 0);

  // The thrown failure counted, so one more failing drain reaches the drop
  // threshold and unblocks the session.
  await drain(fixture, turns);
  assert.equal(fixture.dropped.length, 1);
});

function makeAssistantTurn(content: string, sessionKey = "sess-1"): BufferTurn {
  return { ...makeTurn(content, sessionKey), role: "assistant" };
}

test("chunks of a qualifying window keep its eligibility (an assistant-only chunk is still extracted)", async () => {
  const turns = [
    makeTurn("u".repeat(60)),
    makeAssistantTurn("a".repeat(60)),
    makeAssistantTurn("b".repeat(60)),
  ];
  const fixture = drainFixture({
    runResults: [
      { status: "completed", persistedCount: 1, durableOutputCount: 1 },
      { status: "completed", persistedCount: 1, durableOutputCount: 1 },
      { status: "completed", persistedCount: 1, durableOutputCount: 1 },
    ],
    budget: 100,
    dropAfterFailures: 3,
  });

  await drain(fixture, turns);

  assert.equal(fixture.runs.length, 3);
  for (const run of fixture.runs) {
    assert.equal(run.options?.skipUserTurnThreshold, true, "whole-window eligibility was already decided");
    assert.equal(run.options?.skipCharThreshold, true);
  }
});

test("a window that never qualified (no user turns) is not chunked", async () => {
  const turns = [makeAssistantTurn("a".repeat(60)), makeAssistantTurn("b".repeat(60))];
  const fixture = drainFixture({
    runResults: [{ status: "skipped", reason: "below_user_turn_threshold" }],
    budget: 100,
    dropAfterFailures: 3,
  });

  await drain(fixture, turns);

  assert.equal(fixture.runs.length, 1, "single run keeps the original threshold behavior");
  assert.equal(fixture.runs[0]!.turns.length, 2);
});

test("a chunk whose recovery copy cannot be saved is retained, not dropped", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const fixture = drainFixture({
    runResults: [
      { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true },
      { status: "completed", persistedCount: 1, durableOutputCount: 1 },
    ],
    budget: 100,
    dropAfterFailures: 1,
    sideFileFails: true,
  });

  await drain(fixture, turns);

  assert.equal(fixture.dropped.length, 0, "no recovery copy, so the only buffered copy must stay");
  assert.equal(fixture.runs.length, 1, "the drain stops so it can retry safely");
});

test("repeated thrown failures reach the drop threshold and unblock later chunks", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const fixture = drainFixture({
    runResults: [
      new Error("provider exploded"),
      new Error("provider exploded again"),
      { status: "completed", persistedCount: 1, durableOutputCount: 1 },
    ],
    budget: 100,
    dropAfterFailures: 2,
  });

  await drain(fixture, turns);
  assert.match(String(fixture.settled[0]?.error), /provider exploded/);
  assert.equal(fixture.dropped.length, 0);

  await drain(fixture, turns);

  assert.equal(fixture.dropped.length, 1, "the second thrown failure drops the stuck head chunk");
  assert.equal(fixture.sideFiles.length, 1);
  assert.equal(fixture.runs.length, 3, "the next chunk is attempted after the drop");
});

test("an abort error propagates without counting or dropping", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const abort = new Error("aborted");
  abort.name = "AbortError";
  const fixture = drainFixture({
    runResults: [abort, abort, abort],
    budget: 100,
    dropAfterFailures: 1,
  });

  await drain(fixture, turns);
  await drain(fixture, turns);

  assert.equal(fixture.dropped.length, 0);
});

test("a successful empty extraction drains and does not carry a failure count forward", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60)), makeTurn("c".repeat(60))];
  const fixture = drainFixture({
    runResults: [
      { status: "skipped", reason: "empty_extraction_result" },
      { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true },
    ],
    budget: 100,
    dropAfterFailures: 2,
  });

  await drain(fixture, turns);

  assert.equal(fixture.runs.length, 2, "an empty success drains; the next chunk is attempted");
  assert.equal(fixture.dropped.length, 0, "one real failure after an empty success is not yet a drop");
});
