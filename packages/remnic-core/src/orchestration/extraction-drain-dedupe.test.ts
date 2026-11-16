import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SmartBuffer } from "../buffer.js";
import { parseConfig } from "../config.js";
import { StorageManager } from "../storage.js";
import type { BufferTurn } from "../types.js";
import { ExtractionDrain, type DrainRunOptions } from "./extraction-drain.js";
import type { ExtractionRunResult } from "./extraction-run.js";

function makeTurn(content: string, overrides: Partial<BufferTurn> = {}): BufferTurn {
  return { role: "user", content, timestamp: "2026-11-16T12:00:00.000Z", sessionKey: "s1", ...overrides };
}

const DONE: ExtractionRunResult = { status: "completed", persistedCount: 1, durableOutputCount: 1 };
const FAILED: ExtractionRunResult = {
  status: "skipped",
  reason: "empty_extraction_result",
  retainedBuffer: true,
  failureClass: "parse_empty",
  persistedCount: 0,
  durableOutputCount: 0,
};

/** What an extraction run keeps for the model: the chunk minus marked duplicate copies. */
function modelTurnsOf(call: { turns: BufferTurn[] }): BufferTurn[] {
  return call.turns.filter((seen) => seen.extractionDuplicateOf !== true);
}

interface RunSpy {
  calls: { turns: BufferTurn[]; options: Partial<DrainRunOptions> }[];
  /** role+content the model sees, in arrival order */
  modelRoleContent(): string[];
  modelTurnCount(): number;
  /** repeated role+content pairs within any single chunk's model-visible set (must stay 0) */
  modelDuplicates(): number;
  /** marked copies whose representative is missing from the same call (must stay 0) */
  uncoveredShadows(): number;
}

function createSpy(): RunSpy {
  const calls: { turns: BufferTurn[]; options: DrainRunOptions }[] = [];
  return {
    calls,
    modelRoleContent() {
      return calls.flatMap((call) => modelTurnsOf(call).map((seen) => `${seen.role}\u0000${seen.content}`));
    },
    modelTurnCount() {
      return calls.reduce((total, call) => total + modelTurnsOf(call).length, 0);
    },
    modelDuplicates() {
      return Math.max(
        0,
        ...calls.map((call) => {
          const seen = modelTurnsOf(call).map((turn) => `${turn.role}\u0000${turn.content}`);
          return seen.length - new Set(seen).size;
        }),
      );
    },
    uncoveredShadows() {
      return calls.filter((call) => {
        const representatives = new Set(
          modelTurnsOf(call).map((seen) => `${seen.role}\u0000${seen.content}`),
        );
        return call.turns.some(
          (seen) => seen.extractionDuplicateOf === true && !representatives.has(`${seen.role}\u0000${seen.content}`),
        );
      }).length;
    },
  };
}

interface DrainOptions {
  /** Turns loaded into the buffer AND handed to `run` as the drain window. */
  turns: BufferTurn[];
  results: ExtractionRunResult[];
  budgetChars?: number;
  minChars?: number;
  dropAfter?: number;
  saveCopy?: (bufferKey: string, reason: string, turns: readonly BufferTurn[]) => Promise<string>;
}

/**
 * A real buffer on real storage, drained with a stub runExtraction that clears like the
 * coordinator does for a `clearMatchingTurns` drain: by identity, from the turns it received.
 */
async function withDrain(
  opts: DrainOptions,
  run: (
    drain: ExtractionDrain,
    spy: RunSpy,
    window: BufferTurn[],
    buffer: SmartBuffer,
  ) => Promise<ExtractionRunResult | void>,
): Promise<{ spy: RunSpy; buffer: SmartBuffer }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dedup-drain-"));
  const spy = createSpy();
  const buffer = new SmartBuffer(
    parseConfig({ memoryDir: root, bufferMaxTurnsPerSession: 2000 }),
    new StorageManager(root),
  );
  try {
    for (const entry of opts.turns) await buffer.addTurn("s1", entry);
    await buffer.flushPendingSave();
    const drain = new ExtractionDrain({
      config: {
        extractionMinUserTurns: 1,
        extractionMinChars: opts.minChars ?? 0,
        extractionMaxTurnChars: 100_000,
        extractionChunkDropAfterFailures: opts.dropAfter ?? 3,
      },
      extractionWindowBudgetChars: () => opts.budgetChars ?? Number.POSITIVE_INFINITY,
      measureRenderedTurns: (turns) => turns.reduce((total, seen) => total + seen.content.length, 0),
      runExtraction: async (turns, options) => {
        spy.calls.push({ turns: [...turns], options: options ?? {} });
        const result = opts.results.shift() ?? DONE;
        // A successful run clears its chunk the way the coordinator does: by identity.
        if (result.status === "completed") {
          await buffer.clearAfterExtraction(
            "s1",
            turns,
            options?.clearMatchingTurns === true ? { allowNonPrefix: true } : undefined,
          );
        }
        return result;
      },
      getStorage: async () => ({
        saveDroppedExtractionChunk:
          opts.saveCopy ?? (async (_bufferKey, _reason, turns) => `/recovery/${turns.length}.json`),
      }),
      buffer: {
        dropExtractionChunk: (bufferKey, turns, dropOptions) =>
          buffer.dropExtractionChunk(bufferKey, turns, dropOptions),
      },
    });
    const options: DrainRunOptions = {
      bufferKey: "s1",
      clearBufferAfterExtraction: true,
      clearMatchingTurns: true,
      skipUserTurnThreshold: false,
      failOnExtractionFailure: false,
      forceExtractionAttempt: false,
    };
    await run(drain, spy, opts.turns, buffer);
    return { spy, buffer };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SINGLE_RUN = (): DrainRunOptions => ({
  bufferKey: "s1",
  clearBufferAfterExtraction: true,
  clearMatchingTurns: true,
  skipUserTurnThreshold: false,
  failOnExtractionFailure: false,
  forceExtractionAttempt: false,
});

test("the model sees each turn once and every identity drains with its representative", async () => {
  const first = makeTurn("repeat me");
  const duplicate = makeTurn("repeat me", { timestamp: "2026-11-16T12:00:02.000Z" });
  const last = makeTurn("final word", { timestamp: "2026-11-16T12:00:03.000Z" });
  const { spy, buffer } = await withDrain(
    { turns: [first, duplicate, last], results: [DONE] },
    async (drain, _spy, window) => {
      return await drain.run(window, SINGLE_RUN());
    },
  );
  assert.equal(spy.calls.length, 1, "one chunk");
  assert.equal(spy.modelDuplicates(), 0, "the model never receives a duplicate");
  assert.deepEqual(spy.modelRoleContent(), ["user\u0000repeat me", "user\u0000final word"], "representatives only");
  assert.equal(spy.uncoveredShadows(), 0, "each duplicate copy rides with its representative");
  assert.deepEqual(
    buffer.getTurns("s1").map((seen) => seen.content),
    [],
    "on success the duplicate drains together with its representative — nothing left behind",
  );
});

test("the raw buffered turns are never altered by the marker", async () => {
  const first = makeTurn("repeat me");
  const duplicate = makeTurn("repeat me", { timestamp: "2026-11-16T12:00:02.000Z" });
  await withDrain({ turns: [first, duplicate], results: [DONE] }, async (drain, _spy, window) => {
    return await drain.run(window, SINGLE_RUN());
  });
  assert.equal(duplicate.extractionDuplicateOf, undefined, "the raw duplicate object carries no marker");
  assert.equal(first.extractionDuplicateOf, undefined);
});

test("a failed chunk retains its duplicates together with its representative", async () => {
  const first = makeTurn("repeat me");
  const duplicate = makeTurn("repeat me", { timestamp: "2026-11-16T12:00:02.000Z" });
  const { spy, buffer } = await withDrain(
    { turns: [first, duplicate], results: [FAILED, DONE] },
    async (drain, _spy, window, liveBuffer) => {
      const failed = await drain.run(window, SINGLE_RUN());
      assert.equal(failed.status, "skipped", "the first pass fails and retains");
      assert.deepEqual(
        liveBuffer.getTurns("s1").map((seen) => seen.timestamp),
        [first.timestamp, duplicate.timestamp],
        "after the failure both identities are still buffered",
      );
      return await drain.run(window, SINGLE_RUN());
    },
  );
  assert.deepEqual(buffer.getTurns("s1"), [], "the retry drains both identities");
  assert.equal(spy.modelDuplicates(), 0);
});

test("different write scopes are never collapsed, even with identical text", async () => {
  const namespaceA = makeTurn("same text", { writeNamespaceOverride: "ns-a" });
  const namespaceB = makeTurn("same text", { writeNamespaceOverride: "ns-b" });
  const { spy } = await withDrain(
    { turns: [namespaceA, namespaceB], results: [DONE] },
    async (drain, _spy, window) => {
      return await drain.run(window, SINGLE_RUN());
    },
  );
  assert.equal(spy.modelTurnCount(), 2, "both scope copies reach the model");
  assert.deepEqual(
    spy.calls[0]?.turns.map((seen) => [seen.content, seen.extractionDuplicateOf]),
    [
      ["same text", undefined],
      ["same text", undefined],
    ],
    "identical text under different scope pins is never collapsed or marked",
  );
});

test("duplicate-heavy windows need fewer chunks", async () => {
  // Six unique turns of 40 chars, every turn repeated twice, 120-char budget:
  // raw packing needs six chunks; deduped packing needs two of three representatives.
  const unique = Array.from({ length: 6 }, (_, index) => makeTurn(`u${index} `.padEnd(40, "x")));
  const window = unique.flatMap((entry) => [
    entry,
    makeTurn(entry.content, { timestamp: "2026-11-16T12:00:01.000Z" }),
  ]);
  const { spy } = await withDrain(
    { turns: window, results: [DONE, DONE, DONE], budgetChars: 120 },
    async (drain, _spy, drainWindow) => {
      return await drain.run(drainWindow, SINGLE_RUN());
    },
  );
  assert.equal(spy.calls.length, 2, "chunks pack unique turns: two chunks, not four");
  for (const call of spy.calls) {
    assert.ok(modelTurnsOf(call).length <= 3, "each chunk holds at most its budget in representatives");
  }
  assert.equal(spy.modelDuplicates(), 0);
  assert.equal(spy.uncoveredShadows(), 0);
});

test("a window that is 17.6% duplicates sends 17.6% fewer turns", async () => {
  // 1000 turns, 176 of them exact duplicates of an earlier turn (the measured backlog rate).
  const window: BufferTurn[] = [];
  let stamp = 0;
  const nextTimestamp = (): string => {
    const current = `2026-11-16T12:${String(Math.floor(stamp / 60) % 60).padStart(2, "0")}:${String(stamp % 60).padStart(2, "0")}.${String(stamp % 1000).padStart(3, "0")}Z`;
    stamp += 1;
    return current;
  };
  for (let index = 0; index < 1000; index++) {
    if (index % 100 < 18 && (index >= 100 || index >= 4)) {
      window.push(
        makeTurn(window[index >= 100 ? index - 100 : index - 4]!.content, { timestamp: nextTimestamp() }),
      );
    } else {
      window.push(makeTurn(`unique content ${index}`, { timestamp: nextTimestamp() }));
    }
  }
  const identity = (entry: BufferTurn): string => `${entry.role}\u0000${entry.content}`;
  const duplicates = window.length - new Set(window.map(identity)).size;
  assert.equal(duplicates, 176, "fixture sanity: 17.6% exact duplicates");
  const { spy } = await withDrain({ turns: window, results: [DONE] }, async (drain, _spy, drainWindow) => {
    return await drain.run(drainWindow, SINGLE_RUN());
  });
  assert.equal(spy.modelTurnCount(), 824, "exactly the unique turns reach the model: 17.6% fewer");
  assert.equal(spy.modelDuplicates(), 0, "and no text repeats");
  assert.equal(spy.uncoveredShadows(), 0);
});

test("a below-threshold window keeps today's raw skip path", async () => {
  const first = makeTurn("short");
  const duplicate = makeTurn("short", { timestamp: "2026-11-16T12:00:02.000Z" });
  const { spy } = await withDrain(
    { turns: [first, duplicate], results: [DONE], minChars: 10_000 },
    async (drain, _spy, window) => {
      return await drain.run(window, SINGLE_RUN());
    },
  );
  assert.deepEqual(
    spy.calls[0]?.turns.map((seen) => [seen.content, seen.extractionDuplicateOf]),
    [
      ["short", undefined],
      ["short", undefined],
    ],
    "the raw window goes through unmarked — eligibility and skip/clear judge every identity as before",
  );
});

test("a dropped chunk drops its duplicates too, and the recovery copy holds every identity", async () => {
  const first = makeTurn("aaaa");
  const duplicate = makeTurn("aaaa", { timestamp: "2026-11-16T12:00:02.000Z" });
  const second = makeTurn("bbbb", { timestamp: "2026-11-16T12:00:03.000Z" });
  const tail = makeTurn("cccc", { timestamp: "2026-11-16T12:00:04.000Z" });
  let copied: readonly BufferTurn[] = [];
  const { spy, buffer } = await withDrain(
    {
      turns: [first, duplicate, second, tail],
      results: [FAILED, DONE],
      budgetChars: 8,
      dropAfter: 1,
      saveCopy: async (_bufferKey, _reason, turns) => {
        copied = turns;
        return "/recovery/copy.json";
      },
    },
    async (drain, _spy, window) => {
      return await drain.run(window, SINGLE_RUN());
    },
  );
  assert.equal(spy.calls.length, 2, "two chunks: the failing head, then the tail");
  assert.deepEqual(
    copied.map((seen) => seen.content),
    ["aaaa", "aaaa", "bbbb"],
    "the recovery copy holds the chunk's representative, its duplicate, and the next turn",
  );
  assert.deepEqual(
    spy.calls[0]?.turns.map((seen) => [seen.content, seen.extractionDuplicateOf]),
    [
      ["aaaa", undefined],
      ["aaaa", true],
      ["bbbb", undefined],
    ],
    "the dropped chunk carries every identity; the duplicate is marked",
  );
  assert.deepEqual(
    buffer.getTurns("s1").map((seen) => seen.content),
    [],
    "the drop removes every identity in the chunk and the tail drains: nothing left behind",
  );
});
