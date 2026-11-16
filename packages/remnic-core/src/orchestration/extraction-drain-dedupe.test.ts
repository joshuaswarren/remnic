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

/** Ten-char contents so a 20-char budget packs exactly two representatives per chunk. */
const tenChars = (tag: string): string => tag.padEnd(10, "0");

test("a duplicate between two chunks is cleared with the chunk before it", async () => {
  const a = makeTurn(tenChars("aaaa"));
  const b = makeTurn(tenChars("bbbb"), { timestamp: "2026-11-16T12:00:01.000Z" });
  const aAgain = makeTurn(tenChars("aaaa"), { timestamp: "2026-11-16T12:00:02.000Z" });
  const c = makeTurn(tenChars("cccc"), { timestamp: "2026-11-16T12:00:03.000Z" });
  const { spy, buffer } = await withDrain(
    { turns: [a, b, aAgain, c], results: [DONE, DONE], budgetChars: 20 },
    async (drain, _spy, window) => {
      return await drain.run(window, SINGLE_RUN());
    },
  );
  assert.equal(spy.calls.length, 2, "two chunks");
  assert.deepEqual(
    buffer.getTurns("s1"),
    [],
    "the gap duplicate rides with the preceding chunk: nothing left behind after success",
  );
});

test("a duplicate after the last representative is cleared with the last chunk", async () => {
  const a = makeTurn(tenChars("aaaa"));
  const b = makeTurn(tenChars("bbbb"), { timestamp: "2026-11-16T12:00:01.000Z" });
  const c = makeTurn(tenChars("cccc"), { timestamp: "2026-11-16T12:00:02.000Z" });
  const aAgain = makeTurn(tenChars("aaaa"), { timestamp: "2026-11-16T12:00:03.000Z" });
  const { spy, buffer } = await withDrain(
    { turns: [a, b, c, aAgain], results: [DONE, DONE], budgetChars: 20 },
    async (drain, _spy, window) => {
      return await drain.run(window, SINGLE_RUN());
    },
  );
  assert.equal(spy.calls.length, 2, "two chunks");
  assert.deepEqual(
    buffer.getTurns("s1"),
    [],
    "the trailing duplicate rides with the last chunk: nothing left behind after success",
  );
});

/** Seeded PRNG so the property run is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

test("chunks partition every window: each turn cleared once, model never sees a duplicate", async () => {
  // A window's first turn is always a representative by construction — there is no
  // earlier occurrence to duplicate — so windows never start with a duplicate.
  const random = mulberry32(3443);
  for (let trial = 0; trial < 12; trial++) {
    const size = 6 + Math.floor(random() * 10);
    const window: BufferTurn[] = [];
    let stamp = 0;
    const nextTimestamp = (): string => {
      const current = `2026-11-16T13:${String(Math.floor(stamp / 60) % 60).padStart(2, "0")}:${String(stamp % 60).padStart(2, "0")}.${String(stamp % 1000).padStart(3, "0")}Z`;
      stamp += 1;
      return current;
    };
    for (let index = 0; index < size; index++) {
      if (index > 0 && random() < 0.3) {
        const source = Math.floor(random() * index);
        window.push(makeTurn(window[source]!.content, { timestamp: nextTimestamp() }));
      } else {
        window.push(makeTurn(`${trial}-${index}`.padEnd(10, "0"), { timestamp: nextTimestamp() }));
      }
    }
    const identity = (entry: BufferTurn): string => `${entry.timestamp}|${entry.content}`;
    const budget = 10 * (1 + Math.floor(random() * 3));
    const { spy, buffer } = await withDrain(
      { turns: window, results: Array.from({ length: window.length }, () => DONE), budgetChars: budget },
      async (drain, _spy, drainWindow) => {
        return await drain.run(drainWindow, SINGLE_RUN());
      },
    );
    const chunked = spy.calls.flatMap((call) => call.turns);
    assert.deepEqual(
      chunked.map(identity),
      window.map(identity),
      `trial ${trial}: chunks partition the window — every turn exactly once, in order`,
    );
    const modelSeen = spy.calls.flatMap((call) => modelTurnsOf(call).map((seen) => `${seen.role}\u0000${seen.content}`));
    assert.equal(modelSeen.length, new Set(modelSeen).size, `trial ${trial}: the model never sees a duplicate`);
    assert.deepEqual(buffer.getTurns("s1"), [], `trial ${trial}: a fully successful drain clears the whole window`);
  }
});

test("a failed chunk keeps its identities; its gap duplicate drains on the retry pass", async () => {
  // Window [A, B | C, A-dup]: chunk 1 holds A and B; the gap duplicate sits before
  // chunk 2's span, so it rides with chunk 2. Below the drop threshold a retained
  // failure STOPS the drain, so on the failing pass chunk 2 (and the duplicate) are
  // not attempted; on the retry pass both chunks succeed and the duplicate drains
  // with chunk 2. If the failing chunk is eventually dropped instead, its recovery
  // side-file copy holds its identities — the duplicate's text is identical to its
  // representative's, so no content is lost either way (ACCEPTED TRADE-OFF, also
  // documented in the PR).
  const a = makeTurn(tenChars("aaaa"));
  const b = makeTurn(tenChars("bbbb"), { timestamp: "2026-11-16T12:00:01.000Z" });
  const c = makeTurn(tenChars("cccc"), { timestamp: "2026-11-16T12:00:02.000Z" });
  const aAgain = makeTurn(tenChars("aaaa"), { timestamp: "2026-11-16T12:00:03.000Z" });
  const { spy, buffer } = await withDrain(
    { turns: [a, b, c, aAgain], results: [FAILED, DONE, DONE], budgetChars: 20 },
    async (drain, runSpy, window, liveBuffer) => {
      const failed = await drain.run(window, SINGLE_RUN());
      assert.equal(failed.status, "skipped", "chunk 1 fails and retains");
      assert.equal(runSpy.calls.length, 1, "a retained failure stops the drain before chunk 2");
      assert.deepEqual(
        liveBuffer.getTurns("s1").map((seen) => seen.timestamp),
        [a.timestamp, b.timestamp, c.timestamp, aAgain.timestamp],
        "nothing cleared: chunk 1's identities stay retained, the duplicate still rides with chunk 2",
      );
      return await drain.run(window, SINGLE_RUN());
    },
  );
  assert.equal(spy.calls.length, 3, "retry: both chunks run and succeed");
  assert.deepEqual(
    spy.calls[2]?.turns.map((seen) => [seen.content, seen.extractionDuplicateOf]),
    [
      [tenChars("cccc"), undefined],
      [tenChars("aaaa"), true],
    ],
    "on the retry the gap duplicate rides with chunk 2, marked — the model never re-reads A's text",
  );
  assert.deepEqual(buffer.getTurns("s1"), [], "the retry pass drains every identity, including the gap duplicate");
});
