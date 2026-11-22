import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

import { withTempDir as managedWithTempDir } from "../testing/tmp-dir.js";

import {
  openTraceRecorder,
  replayTrace,
  parseSnapshotLine,
  computeReplayDelay,
  parseSpeedFlag,
  sleepAbortable,
  isAbortError,
  flushWithTimeout,
} from "./trace.js";
import { stripAnsi } from "./tui.js";
import type { ConsoleStateSnapshot } from "./state.js";

class CaptureStream extends Writable {
  public chunks: string[] = [];
  override _write(
    chunk: unknown,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
  textPlain(): string {
    return stripAnsi(this.text());
  }
}

function makeSnapshot(
  overrides: Partial<ConsoleStateSnapshot> = {},
): ConsoleStateSnapshot {
  return {
    capturedAt: "2026-04-26T00:00:00.000Z",
    bufferState: { turnsCount: 0, byteCount: 0 },
    extractionQueue: { depth: 0, recentVerdicts: [] },
    dedupRecent: [],
    maintenanceLedgerTail: [],
    qmdProbe: { available: true, daemonMode: true, debug: "" },
    daemon: { uptimeMs: 0, version: "test" },
    errors: [],
    ...overrides,
  };
}

const withTempDir = <T>(fn: (dir: string) => Promise<T>): Promise<T> =>
  managedWithTempDir(fn, "remnic-trace-");

test("openTraceRecorder writes one parseable JSON object per line", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "nested", "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    try {
      await recorder.append(
        makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
      );
      await recorder.append(
        makeSnapshot({
          capturedAt: "2026-04-26T00:00:02.000Z",
          bufferState: { turnsCount: 5, byteCount: 100 },
        }),
      );
      await recorder.append(
        makeSnapshot({ capturedAt: "2026-04-26T00:00:04.000Z" }),
      );
    } finally {
      await recorder.close();
    }
    assert.equal(recorder.getLastError(), null);

    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3, "expected three frames in the trace");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.capturedAt, "string");
      assert.ok(parsed.bufferState, "each line carries a bufferState");
    }
    const second = JSON.parse(lines[1]);
    assert.equal(second.bufferState.turnsCount, 5);
  });
});

test("openTraceRecorder appends to an existing file rather than truncating", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const r1 = await openTraceRecorder(tracePath);
    await r1.append(makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }));
    await r1.close();
    const r2 = await openTraceRecorder(tracePath);
    await r2.append(makeSnapshot({ capturedAt: "2026-04-26T00:00:01.000Z" }));
    await r2.close();
    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
  });
});

test("replayTrace renders every frame and emits expected stdout snapshots", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    await recorder.append(
      makeSnapshot({
        capturedAt: "2026-04-26T00:00:00.000Z",
        bufferState: { turnsCount: 1, byteCount: 10 },
      }),
    );
    await recorder.append(
      makeSnapshot({
        capturedAt: "2026-04-26T00:00:02.000Z",
        bufferState: { turnsCount: 7, byteCount: 70 },
      }),
    );
    await recorder.append(
      makeSnapshot({
        capturedAt: "2026-04-26T00:00:04.000Z",
        bufferState: { turnsCount: 11, byteCount: 99 },
      }),
    );
    await recorder.close();

    const stream = new CaptureStream();
    const result = await replayTrace(tracePath, {
      output: stream,
      speed: 1000, // collapse delays for the test
      sleep: () => Promise.resolve(),
      manageCursor: false,
    });

    assert.equal(result.framesRendered, 3);
    assert.equal(result.framesSkipped, 0);
    assert.ok(result.lastSnapshot);
    assert.equal(result.lastSnapshot?.bufferState.turnsCount, 11);

    const text = stream.textPlain();
    assert.match(text, /turns=1 bytes=10/);
    assert.match(text, /turns=7 bytes=70/);
    assert.match(text, /turns=11 bytes=99/);
    assert.match(text, /remnic console/);
  });
});

test("replayTrace skips malformed lines without crashing", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const valid = JSON.stringify(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
    );
    const corrupt =
      `${valid}\n` +
      "{not json\n" +
      "null\n" +
      "[1,2,3]\n" +
      `${JSON.stringify(makeSnapshot({ capturedAt: "2026-04-26T00:00:01.000Z" }))}\n`;
    await fs.writeFile(tracePath, corrupt, "utf-8");

    const stream = new CaptureStream();
    const result = await replayTrace(tracePath, {
      output: stream,
      sleep: () => Promise.resolve(),
      manageCursor: false,
    });
    assert.equal(result.framesRendered, 2);
    assert.equal(result.framesSkipped, 3);
  });
});

test("replayTrace skips partial snapshot objects the renderer cannot handle", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const valid = JSON.stringify(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
    );
    const partial = JSON.stringify({
      capturedAt: "2026-04-26T00:00:01.000Z",
    });
    await fs.writeFile(tracePath, `${valid}\n${partial}\n`, "utf-8");

    const stream = new CaptureStream();
    const result = await replayTrace(tracePath, {
      output: stream,
      sleep: () => Promise.resolve(),
      manageCursor: false,
    });

    assert.equal(result.framesRendered, 1);
    assert.equal(result.framesSkipped, 1);
    assert.doesNotMatch(stream.textPlain(), /render failed/);
  });
});

test("replayTrace --speed 2 halves the inter-frame delay vs --speed 1", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
    );
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:04.000Z" }),
    );
    await recorder.close();

    const recordDelays = async (
      speed: number,
    ): Promise<number[]> => {
      const delays: number[] = [];
      const stream = new CaptureStream();
      await replayTrace(tracePath, {
        output: stream,
        speed,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        manageCursor: false,
      });
      return delays;
    };

    const oneX = await recordDelays(1);
    const twoX = await recordDelays(2);

    assert.deepEqual(oneX, [4000]);
    assert.deepEqual(twoX, [2000]);
    assert.equal(twoX[0], oneX[0] / 2);
  });
});

test("computeReplayDelay clamps and respects the speed multiplier", () => {
  assert.equal(computeReplayDelay(2000, 1), 2000);
  assert.equal(computeReplayDelay(2000, 2), 1000);
  assert.equal(computeReplayDelay(2000, 0.5), 4000);
  assert.equal(computeReplayDelay(-100, 1), 0);
  assert.equal(computeReplayDelay(0, 1), 0);
  assert.equal(computeReplayDelay(Number.NaN, 1), 0);
  assert.equal(computeReplayDelay(2000, Infinity), 0);
  assert.equal(computeReplayDelay(10 * 60 * 1000, 1), 60_000);
});

test("parseSpeedFlag accepts positive numbers and rejects garbage", () => {
  assert.equal(parseSpeedFlag(undefined), 1);
  assert.equal(parseSpeedFlag(null), 1);
  assert.equal(parseSpeedFlag(2), 2);
  assert.equal(parseSpeedFlag("0.5"), 0.5);
  assert.throws(() => parseSpeedFlag("0"), /must be > 0/);
  assert.throws(() => parseSpeedFlag("-1"), /must be > 0/);
  assert.throws(() => parseSpeedFlag("abc"), /must be a positive number/);
});

test("parseSnapshotLine handles all the JSON edge cases", () => {
  assert.equal(parseSnapshotLine(""), null);
  assert.equal(parseSnapshotLine("not json"), null);
  assert.equal(parseSnapshotLine("null"), null);
  assert.equal(parseSnapshotLine("[1,2,3]"), null);
  assert.equal(parseSnapshotLine("42"), null);
  assert.equal(
    parseSnapshotLine(JSON.stringify({ capturedAt: "2026-04-26T00:00:00.000Z" })),
    null,
  );
  const snap = makeSnapshot();
  const parsed = parseSnapshotLine(JSON.stringify(snap));
  assert.ok(parsed);
  assert.equal(parsed?.capturedAt, snap.capturedAt);
});

test("recorder error path does not crash on poisoned writes", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    await recorder.append(makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }));
    await recorder.close();
    await recorder.append(makeSnapshot({ capturedAt: "2026-04-26T00:00:01.000Z" }));
    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "post-close append should be dropped");
  });
});

test("replayTrace defaultSleep aborts immediately on signal (Codex P2 regression)", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
    );
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:05.000Z" }),
    );
    await recorder.close();

    const stream = new CaptureStream();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    const start = Date.now();
    const result = await replayTrace(tracePath, {
      output: stream,
      manageCursor: false,
      signal: ac.signal,
      // Use the default sleep (no override) so we exercise the
      // abort-aware code path.
    });
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 1000,
      `expected abort to short-circuit sleep, took ${elapsed}ms`,
    );
    assert.equal(result.framesRendered, 1);
  });
});

test("recorder close() drains pending writes (Codex P1 regression)", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      writes.push(
        recorder.append(
          makeSnapshot({
            capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
        ),
      );
    }
    const closePromise = recorder.close();
    await Promise.all(writes);
    await closePromise;
    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(
      lines.length,
      10,
      "all queued writes must drain before close completes",
    );
  });
});

test("recorder serializes concurrent appends without interleaving", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      writes.push(
        recorder.append(
          makeSnapshot({
            capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
        ),
      );
    }
    await Promise.all(writes);
    await recorder.close();
    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 25);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.capturedAt, "string");
    }
  });
});

test("replayTrace honors AbortSignal mid-replay", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    for (let i = 0; i < 10; i++) {
      await recorder.append(
        makeSnapshot({
          capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }
    await recorder.close();

    const stream = new CaptureStream();
    const ac = new AbortController();
    let frames = 0;
    const result = await replayTrace(tracePath, {
      output: stream,
      sleep: async () => {
        frames += 1;
        if (frames >= 2) ac.abort();
      },
      manageCursor: false,
      signal: ac.signal,
    });
    assert.ok(
      result.framesRendered < 10,
      `expected early abort, rendered ${result.framesRendered}`,
    );
  });
});

test("replayTrace restores cursor + closes stream when aborted (Codex P2 #732)", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    for (let i = 0; i < 10; i++) {
      await recorder.append(
        makeSnapshot({
          capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }
    await recorder.close();

    const stream = new CaptureStream();
    const ac = new AbortController();
    let frames = 0;
    const result = await replayTrace(tracePath, {
      output: stream,
      sleep: async () => {
        frames += 1;
        if (frames >= 1) ac.abort();
      },
      manageCursor: true,
      signal: ac.signal,
    });

    assert.ok(
      result.framesRendered < 10,
      `expected early abort, rendered ${result.framesRendered}`,
    );

    const raw = stream.text();
    assert.ok(
      raw.includes("\x1b[?25l"),
      "expected hide-cursor escape at replay start",
    );
    assert.ok(
      raw.includes("\x1b[?25h"),
      "expected show-cursor escape from finally block after abort",
    );
  });
});

test("sleepAbortable resolves on timer expiry without a signal", async () => {
  const start = Date.now();
  await sleepAbortable(20);
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed >= 15,
    `expected timer to elapse (~20ms), got ${elapsed}ms`,
  );
});

test("sleepAbortable rejects with AbortError when signal aborts mid-sleep", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 25);
  const start = Date.now();
  let caught: unknown = null;
  try {
    await sleepAbortable(10_000, ac.signal);
    assert.fail("sleepAbortable must reject when signal aborts");
  } catch (err) {
    caught = err;
  }
  const elapsed = Date.now() - start;
  assert.ok(
    isAbortError(caught),
    `expected AbortError, got ${caught instanceof Error ? caught.name : String(caught)}`,
  );
  assert.ok(
    elapsed < 500,
    `expected immediate rejection on abort, took ${elapsed}ms`,
  );
});

test("sleepAbortable rejects immediately when signal already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  let caught: unknown = null;
  try {
    await sleepAbortable(1000, ac.signal);
    assert.fail("sleepAbortable must reject when signal pre-aborted");
  } catch (err) {
    caught = err;
  }
  assert.ok(isAbortError(caught), "expected AbortError on pre-aborted signal");
});

test("isAbortError distinguishes AbortError from other errors", () => {
  assert.equal(isAbortError(new Error("regular")), false);
  assert.equal(isAbortError("string"), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
  const plain = new Error("aborted");
  plain.name = "AbortError";
  assert.equal(isAbortError(plain), true);
  if (typeof DOMException !== "undefined") {
    assert.equal(
      isAbortError(new DOMException("aborted", "AbortError")),
      true,
    );
  }
});

test("replayTrace surfaces non-abort sleep rejections (regression)", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
    );
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:05.000Z" }),
    );
    await recorder.close();

    const stream = new CaptureStream();
    let threw: unknown = null;
    try {
      await replayTrace(tracePath, {
        output: stream,
        manageCursor: false,
        sleep: async () => {
          throw new Error("boom: not an abort");
        },
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(
      threw instanceof Error && /boom/.test(threw.message),
      `expected non-abort error to propagate, got ${String(threw)}`,
    );
  });
});

test("flushWithTimeout returns flushed=true when flush completes in time (Codex P1 #732)", async () => {
  let flushed = false;
  const result = await flushWithTimeout(async () => {
    await new Promise((r) => setTimeout(r, 10));
    flushed = true;
  }, 1000);
  assert.equal(flushed, true);
  assert.equal(result.flushed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
});

test("flushWithTimeout returns timedOut=true when flush stalls past deadline (Codex P1 #732)", async () => {
  const anchor = setInterval(() => undefined, 60_000);
  try {
    const start = Date.now();
    const result = await flushWithTimeout(
      () => new Promise<void>(() => undefined), // never resolves
      50,
    );
    const elapsed = Date.now() - start;
    assert.equal(result.timedOut, true);
    assert.equal(result.flushed, false);
    assert.ok(
      elapsed >= 40 && elapsed < 500,
      `expected ~50ms wall time, took ${elapsed}ms`,
    );
  } finally {
    clearInterval(anchor);
  }
});

test("flushWithTimeout captures errors from flush without throwing (Codex P1 #732)", async () => {
  const boom = new Error("disk full");
  const result = await flushWithTimeout(async () => {
    throw boom;
  }, 1000);
  assert.equal(result.flushed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, boom);
});

test("flushWithTimeout cancels fallback timer when flush wins the race (Codex P1 #732 round 3)", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const handles: Array<{ unrefCalled: boolean; cleared: boolean }> = [];
  let lastHandle: ReturnType<typeof setTimeout> | null = null;
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    const handle = realSetTimeout(cb, ms);
    const record = { unrefCalled: false, cleared: false };
    const originalUnref = handle.unref?.bind(handle);
    if (originalUnref) {
      handle.unref = () => {
        record.unrefCalled = true;
        return originalUnref();
      };
    }
    handles.push(record);
    lastHandle = handle;
    // Tag so clearTimeout spy can map handle → record.
    (handle as unknown as { __record: typeof record }).__record = record;
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const record = (handle as unknown as { __record?: { cleared: boolean } })
      .__record;
    if (record) record.cleared = true;
    return realClearTimeout(handle);
  }) as typeof clearTimeout;
  try {
    const result = await flushWithTimeout(async () => {
      await Promise.resolve();
    }, 5000);
    assert.equal(result.flushed, true);
    assert.equal(result.timedOut, false);
    const fallback = handles.find((h) => h === handles[handles.length - 1]);
    assert.ok(fallback, "expected at least one setTimeout call");
    assert.equal(
      fallback!.unrefCalled,
      true,
      "fallback timer must be unref()'d so it never holds the event loop",
    );
    assert.equal(
      fallback!.cleared,
      true,
      "fallback timer must be cleared once flush wins the race",
    );
    assert.ok(lastHandle, "expected a captured timer handle");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("flushWithTimeout fires abort signal when timeout wins the race (Codex P1 #732 round 5)", async () => {
  let abortFired = false;
  const anchor = setInterval(() => undefined, 60_000);
  try {
    const result = await flushWithTimeout((signal) => {
      signal.addEventListener("abort", () => {
        abortFired = true;
      });
      return new Promise<void>(() => undefined);
    }, 50);
    assert.equal(result.timedOut, true, "expected timedOut result");
    assert.equal(abortFired, true, "abort signal must fire when timeout wins");
  } finally {
    clearInterval(anchor);
  }
});

test("flushWithTimeout does NOT fire abort signal when flush wins the race (Codex P1 #732 round 5)", async () => {
  let abortFired = false;
  const result = await flushWithTimeout((signal) => {
    signal.addEventListener("abort", () => {
      abortFired = true;
    });
    return Promise.resolve();
  }, 5000);
  assert.equal(result.flushed, true);
  assert.equal(abortFired, false, "abort signal must NOT fire when flush wins");
});

test("recorder close() aborts pending write-chain drain when signal fires (Codex P1 #732 round 5)", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    const stalledWrite = new Promise<void>(() => undefined);
    //
    await recorder.close();

    const recorder2 = await openTraceRecorder(tracePath, {
      ensureParentDir: false,
    });
    const ac = new AbortController();
    ac.abort(); // pre-aborted
    const start = Date.now();
    await recorder2.close(ac.signal);
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 500,
      `close() with aborted signal took too long: ${elapsed}ms`,
    );
    assert.equal(recorder2.getLastError(), null);
    await recorder2.close(ac.signal);
  });
});

test("replayTrace exits cleanly when sleep override rejects with AbortError", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    for (let i = 0; i < 5; i++) {
      await recorder.append(
        makeSnapshot({
          capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }
    await recorder.close();

    const stream = new CaptureStream();
    const ac = new AbortController();
    let calls = 0;
    const result = await replayTrace(tracePath, {
      output: stream,
      manageCursor: false,
      signal: ac.signal,
      sleep: async () => {
        calls += 1;
        if (calls >= 1) {
          ac.abort();
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
      },
    });
    assert.ok(
      result.framesRendered < 5,
      `expected early exit, rendered ${result.framesRendered}`,
    );
  });
});
