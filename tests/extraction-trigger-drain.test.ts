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
import { isPreemptedExtraction } from "../packages/remnic-core/src/abort-error.js";
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
  preemptRegistrations: Array<() => void>;
}

type FakeRunResult = {
  status: "completed" | "skipped";
  reason?: string;
  retainedBuffer?: boolean;
  persistedCount?: number;
  durableOutputCount?: number;
  /** Block until the run's abort signal fires, then throw a generic AbortError (no reason). */
  waitForAbort?: boolean;
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
  minChars?: number;
}): DrainFixture {
  const runs: DrainFixture["runs"] = [];
  const dropped: DrainFixture["dropped"] = [];
  const sideFiles: DrainFixture["sideFiles"] = [];
  const settled: DrainFixture["settled"] = [];
  const bufferTurns = options.bufferTurns ?? [];
  const tasks: Promise<void>[] = [];
  const preemptRegistrations: Array<() => void> = [];
  const fake = {
    config: {
      extractionChunkDropAfterFailures: options.dropAfterFailures,
      extractionMinUserTurns: options.minUserTurns ?? 1,
      extractionMinChars: options.minChars ?? 0,
      extractionMaxTurnChars: 100_000,
    },
    extractionQueueCoordinator: {
      beginPreemptable: (abort: () => void) => {
        preemptRegistrations.push(abort);
      },
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
      if (next.waitForAbort === true) {
        await new Promise<void>((_, reject) => {
          const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (runOptions.abortSignal?.aborted) fail();
          else runOptions.abortSignal?.addEventListener("abort", fail, { once: true });
        });
      }
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
  return { coordinator, runs, dropped, sideFiles, settled, tasks, preemptRegistrations };
}

async function drain(fixture: DrainFixture, turns: BufferTurn[], extra: { preemptable?: boolean } = {}): Promise<void> {
  const queued = fixture.coordinator.queueBufferedExtraction(turns, "trigger_mode", {
    bufferKey: "sess-1",
    ...extra,
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

test("a failure count belongs to its chunk: unrelated content never inherits it (codex P2)", async () => {
  // The old per-key counter survived a force flush that cleared the failing chunk, so the NEXT window's first chunk was
  // dropped on its first failed attempt. Counts are now bound to the chunk's content.
  const first = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const second = [makeTurn("c".repeat(60)), makeTurn("d".repeat(60))];
  const fail: FakeRunResult = { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true };
  const fixture = drainFixture({
    runResults: [fail, fail, fail, { status: "completed", persistedCount: 1, durableOutputCount: 1 }],
    budget: 100,
    dropAfterFailures: 2,
  });

  await drain(fixture, first); // chunk "a" fails once
  await drain(fixture, second); // different head chunk "c": its own count starts at zero
  assert.equal(fixture.dropped.length, 0, "chunk c must not be dropped on its first failure");
  assert.equal(fixture.sideFiles.length, 0);

  await drain(fixture, second); // chunk "c" fails a second time in a row: now it is dropped
  assert.equal(fixture.dropped.length, 1);
  assert.equal(fixture.dropped[0]!.turns[0]!.content, "c".repeat(60));
});

test("later chunks register preemption again so a fail-closed flush can abort them (codex P2)", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60)), makeTurn("c".repeat(60))];
  const ok: FakeRunResult = { status: "completed", persistedCount: 1, durableOutputCount: 1 };
  const fixture = drainFixture({ runResults: [ok, ok, ok], budget: 100, dropAfterFailures: 3 });

  await drain(fixture, turns, { preemptable: true });

  assert.equal(fixture.runs.length, 3);
  assert.equal(fixture.preemptRegistrations.length, 2, "one registration before each chunk after the first");
  const firstSignal = fixture.runs[0]!.options.abortSignal;
  const laterSignal = fixture.runs[1]!.options.abortSignal;
  assert.ok(laterSignal && laterSignal !== firstSignal, "a later chunk gets its own preempt-aware signal");
  assert.equal(laterSignal.aborted, false);
  fixture.preemptRegistrations[0]!();
  assert.equal(laterSignal.aborted, true, "the registered callback aborts that chunk's signal");
  assert.ok(isPreemptedExtraction(laterSignal.reason), "with the preempted-extraction reason the queue already understands");
});

test("non-preemptable drains register no preemption between chunks", async () => {
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const ok: FakeRunResult = { status: "completed", persistedCount: 1, durableOutputCount: 1 };
  const fixture = drainFixture({ runResults: [ok, ok], budget: 100, dropAfterFailures: 3 });

  await drain(fixture, turns);

  assert.equal(fixture.runs.length, 2);
  assert.equal(fixture.preemptRegistrations.length, 0);
});

test("the unextracted tail of a qualified window stays eligible on the next attempt (codex P1)", async () => {
  const fail: FakeRunResult = { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true };
  const ok: FakeRunResult = { status: "completed", persistedCount: 1, durableOutputCount: 1 };
  // First attempt: the user chunk drains, the assistant-only chunk fails and stays in the buffer.
  const fixture = drainFixture({ runResults: [ok, fail, ok, ok], budget: 100, dropAfterFailures: 3 });
  await drain(fixture, [makeTurn("u".repeat(60)), makeAssistantTurn("a".repeat(60))]);
  assert.equal(fixture.runs.length, 2);

  // Next attempt sees only the retained assistant turn: no user turn, one chunk. It is the tail of a window that qualified.
  await drain(fixture, [makeAssistantTurn("a".repeat(60))]);
  assert.equal(fixture.runs.length, 3);
  assert.equal(fixture.runs[2]!.options.skipUserTurnThreshold, true, "the tail keeps the window's eligibility");
  assert.equal(fixture.runs[2]!.options.skipCharThreshold, true);

  // The window is done: the same shape of content arriving later is judged on its own.
  await drain(fixture, [makeAssistantTurn("a".repeat(60))]);
  assert.equal(fixture.runs.length, 4);
  assert.notEqual(fixture.runs[3]!.options.skipUserTurnThreshold, true, "eligibility does not outlive the window");
});

test("a tail's eligibility never applies to unrelated content", async () => {
  const fail: FakeRunResult = { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true };
  const ok: FakeRunResult = { status: "completed", persistedCount: 1, durableOutputCount: 1 };
  const fixture = drainFixture({ runResults: [ok, fail, ok], budget: 100, dropAfterFailures: 3 });
  await drain(fixture, [makeTurn("u".repeat(60)), makeAssistantTurn("a".repeat(60))]);

  await drain(fixture, [makeAssistantTurn("z".repeat(60))]);
  assert.equal(fixture.runs.length, 3);
  assert.notEqual(fixture.runs[2]!.options.skipUserTurnThreshold, true);
});

test("a flush that preempts a later chunk surfaces the preemption reason (codex P1)", async () => {
  const ok: FakeRunResult = { status: "completed", persistedCount: 1, durableOutputCount: 1 };
  const fixture = drainFixture({
    runResults: [ok, { status: "skipped", waitForAbort: true }],
    budget: 100,
    dropAfterFailures: 3,
  });
  const turns = [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))];
  const done = drain(fixture, turns, { preemptable: true });
  while (fixture.runs.length < 2) await new Promise((resolve) => setImmediate(resolve));
  fixture.preemptRegistrations[0]!();
  await done;
  assert.equal(fixture.settled.length, 1);
  assert.ok(isPreemptedExtraction(fixture.settled[0]!.error), "the host sees a preemption, not a generic abort");
});

test("a window below the character minimum is not split into chunks that each skip it (codex P2)", async () => {
  // The minimum is larger than the model's input budget, so the window spans chunks yet is still below the minimum.
  const fixture = drainFixture({
    runResults: [{ status: "skipped", reason: "below_threshold" }],
    budget: 100,
    dropAfterFailures: 3,
    minChars: 1000,
  });
  await drain(fixture, [makeTurn("a".repeat(60)), makeTurn("b".repeat(60))]);
  assert.equal(fixture.runs.length, 1, "one run, as before the drain existed");
  assert.equal(fixture.runs[0]!.turns.length, 2, "over the whole window");
  assert.notEqual(fixture.runs[0]!.options.skipCharThreshold, true, "so the coordinator applies its own minimum");
});
