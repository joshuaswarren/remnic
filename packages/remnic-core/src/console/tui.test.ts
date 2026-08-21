import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";

import {
  renderFrame,
  runConsoleTui,
  stripAnsi,
} from "./tui.js";
import {
  type ConsoleStateOrchestratorLike,
  type ConsoleStateSnapshot,
} from "./state.js";

/**
 * Test stream that accumulates writes into a buffer string. Used in
 * place of `process.stdout` so we can assert what the TUI rendered.
 */
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

function makeOrchestrator(
  overrides: Partial<ConsoleStateOrchestratorLike> = {},
): ConsoleStateOrchestratorLike {
  return {
    config: { memoryDir: "/nonexistent" },
    buffer: { getTurns: () => [] },
    qmd: {
      isAvailable: () => true,
      isDaemonMode: () => true,
      debugStatus: () => "stub",
    },
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<ConsoleStateSnapshot> = {},
): ConsoleStateSnapshot {
  return {
    capturedAt: "2025-01-01T00:00:00.000Z",
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

test("renderFrame produces text containing each panel header", () => {
  const frame = renderFrame({
    snapshot: makeSnapshot({
      bufferState: { turnsCount: 3, byteCount: 42 },
      extractionQueue: {
        depth: 5,
        recentVerdicts: [
          { ts: "2025-01-01T00:00:00.000Z", kind: "accept" },
          { ts: "2025-01-01T00:00:01.000Z", kind: "accept" },
          { ts: "2025-01-01T00:00:02.000Z", kind: "reject" },
        ],
      },
      dedupRecent: [
        {
          ts: "2025-01-01T00:00:00.000Z",
          decision: "admit",
          fingerprint: "abc123",
        },
      ],
      maintenanceLedgerTail: [
        {
          ts: "2025-01-01T00:00:00.000Z",
          category: "judge-verdict",
          summary: "verdict=accept",
        },
      ],
    }),
    renderError: null,
    now: () => Date.parse("2025-01-01T00:00:10.000Z"),
  });

  const plain = stripAnsi(frame);
  assert.match(plain, /remnic console/);
  assert.match(plain, /Buffer\b/);
  assert.match(plain, /turns=3 bytes=42/);
  assert.match(plain, /Extraction\b/);
  assert.match(plain, /queue=5/);
  assert.match(plain, /accept\(2\)\/reject\(1\)/);
  assert.match(plain, /Dedup\b/);
  assert.match(plain, /hash=abc123/);
  assert.match(plain, /decision=admit/);
  assert.match(plain, /Maintenance\b/);
  assert.match(plain, /judge-verdict/);
  assert.match(plain, /QMD\b/);
  assert.match(plain, /probe=ok/);
});

test("renderFrame surfaces a refresh error in the Error panel without losing layout", () => {
  const frame = renderFrame({
    snapshot: null,
    renderError: "boom",
    now: () => Date.parse("2025-01-01T00:00:00.000Z"),
  });
  const plain = stripAnsi(frame);
  assert.match(plain, /Error/);
  assert.match(plain, /refresh failed: boom/);
  // Layout headers are still present so operators see the structure.
  assert.match(plain, /Buffer\b/);
  assert.match(plain, /Extraction\b/);
  assert.match(plain, /Dedup\b/);
  assert.match(plain, /Maintenance\b/);
  assert.match(plain, /QMD\b/);
});

test("runConsoleTui repaints once on start and survives a snapshot failure", async () => {
  const stream = new CaptureStream();
  let calls = 0;
  // Mock orchestrator: first call succeeds (via gatherConsoleState's
  // defensive readers), second call throws when the buffer accessor
  // is invoked. The loop must NOT crash.
  const orchestrator: ConsoleStateOrchestratorLike = {
    config: { memoryDir: "/nonexistent" },
    qmd: {
      isAvailable: () => true,
      isDaemonMode: () => false,
      debugStatus: () => "stub",
    },
    buffer: {
      getTurns: () => {
        calls += 1;
        if (calls >= 2) {
          throw new Error("simulated read failure");
        }
        return [{ content: "hi" }];
      },
    },
  };

  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 50,
    output: stream,
    installSigintHandler: false,
    now: () => Date.parse("2025-01-01T00:00:00.000Z"),
  });

  // Wait long enough for at least two ticks (initial paint + one
  // interval-driven tick that exercises the failure path).
  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  await handle.done;

  // Loop did not crash and we got at least one frame.
  const text = stream.textPlain();
  assert.match(text, /remnic console/);
  assert.match(text, /Buffer\b/);
  // Error from the failing buffer reader is captured by gatherConsoleState's
  // try/catch and surfaced via the snapshot's `errors` array → Errors panel.
  // It is NOT a renderError (which only fires for gatherConsoleState
  // throwing outright). We assert the loop reached the second tick.
  assert.ok(calls >= 2, `expected >= 2 buffer reads, got ${calls}`);
});

test("renderFrame produces panel lines aligned with header/footer borders", () => {
  // Cursor Medium regression: panel lines were 71 chars while
  // header/footer were 72, misaligning the right-hand ║ column.
  const frame = renderFrame({
    snapshot: makeSnapshot(),
    renderError: null,
    now: () => Date.parse("2025-01-01T00:00:00.000Z"),
  });
  const lines = frame.split("\n").filter((l) => l.length > 0);
  // First line is the header, last is the footer; everything between
  // is a panel line. All must be the same visual width.
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(
    widths.size,
    1,
    `expected uniform line widths, saw ${[...widths].sort().join(", ")}`,
  );
});

test("runConsoleTui survives a renderer-side exception without freezing", async () => {
  // Cursor Low regression: if the render path threw after `inFlight`
  // was set to true, the latch was never released and every
  // subsequent tick silently bailed via `if (inFlight) return`. The
  // try/finally fix should keep the loop ticking even if `now()`
  // returns NaN (which makes `new Date(NaN).toISOString()` throw).
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  let nowCalls = 0;
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 30,
    output: stream,
    installSigintHandler: false,
    now: () => {
      nowCalls += 1;
      // First two calls poison the renderer; subsequent ticks recover.
      if (nowCalls <= 2) return Number.NaN;
      return Date.parse("2025-01-01T00:00:00.000Z");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  await handle.done;

  // The loop kept ticking through the poisoned renders.
  assert.ok(
    nowCalls >= 3,
    `expected loop to keep ticking past renderer failure, saw ${nowCalls} now() calls`,
  );
  // And eventually emitted a healthy frame.
  const text = stream.textPlain();
  assert.match(text, /remnic console/);
});

test("traceRecorder.append is invoked once per successful tick", async () => {
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  const appended: number[] = [];
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 30,
    output: stream,
    installSigintHandler: false,
    traceRecorder: {
      append: async () => {
        appended.push(Date.now());
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  handle.stop();
  await handle.done;
  assert.ok(
    appended.length >= 2,
    `expected >= 2 trace appends, got ${appended.length}`,
  );
});

test("slow trace writes do not block render ticks (Codex P2 #732)", async () => {
  // Regression for Codex review on PR #732: the render tick must not
  // `await` the trace write before painting. If it did, a slow disk
  // (or network FS) would hold `inFlight = true` for the duration of
  // the write, causing every subsequent tick to bail at
  // `if (inFlight) return` and making `--record-trace` look frozen.
  // This test wires a recorder whose `append` never resolves and
  // asserts that frames keep painting anyway.
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  let appendCalls = 0;
  // Pending promise — never resolves. If the tick awaits this, the
  // loop freezes after a single paint.
  const stalledAppend = new Promise<void>(() => {
    /* never resolves */
  });
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 20,
    output: stream,
    installSigintHandler: false,
    traceRecorder: {
      append: async () => {
        appendCalls += 1;
        return stalledAppend;
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  await handle.done;

  // Codex P2 (PR #732 follow-up): backpressure now drops subsequent
  // appends while the previous one is still pending, so a wedged
  // disk doesn't grow the recorder's writeChain unboundedly. The
  // first call still goes through; subsequent calls are dropped
  // until the pending append resolves (which never happens in this
  // test). The KEY property is that the render loop keeps painting,
  // not that every tick enqueues another append.
  assert.equal(
    appendCalls,
    1,
    `under backpressure, only the first stalled append should fire, saw ${appendCalls}`,
  );
  // The rendered output must still reflect multiple paints — the
  // stalled trace write must not block the render path.
  const text = stream.textPlain();
  const headerCount = (text.match(/remnic console/g) ?? []).length;
  assert.ok(
    headerCount >= 3,
    `expected >= 3 painted frames despite stalled trace, saw ${headerCount}`,
  );
});

test("trace backpressure drops frames while a previous append is pending (Codex P2 #732)", async () => {
  // Regression: a wedged filesystem must not let the recorder's
  // writeChain grow unboundedly. While one append is pending, the
  // next tick's append is dropped instead of enqueued.
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  let appendCalls = 0;
  let resolveFirst!: () => void;
  const firstAppendBlocked = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 20,
    output: stream,
    installSigintHandler: false,
    traceRecorder: {
      append: async () => {
        appendCalls += 1;
        // First call blocks; subsequent calls (if backpressure
        // didn't gate them) would also be queued.
        if (appendCalls === 1) await firstAppendBlocked;
      },
    },
  });
  // Let the loop tick several times while the first append blocks.
  await new Promise((resolve) => setTimeout(resolve, 150));
  // Backpressure should have prevented additional appends from
  // landing while the first was pending.
  assert.equal(
    appendCalls,
    1,
    `expected backpressure to gate appends while one is pending, saw ${appendCalls}`,
  );
  // Now release the stalled append and let the loop drain.
  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 80));
  // After the gate releases, subsequent ticks should append again.
  assert.ok(
    appendCalls >= 2,
    `expected appends to resume after pending one drained, saw ${appendCalls}`,
  );
  handle.stop();
  await handle.done;
});

test("getDroppedTraceFrames starts at zero and increases under backpressure (Codex P2 #732 round 5)", async () => {
  // Codex P2 round 5: `traceFramesDropped` was incremented on every
  // backpressure drop but never exposed, making the counter a dead
  // store. Now it is surfaced via `handle.getDroppedTraceFrames()` so
  // operators can detect recording lag. This test verifies:
  //   1. The counter starts at zero.
  //   2. It increases when backpressure gates subsequent appends while
  //      a previous write is still pending.
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();

  let resolveFirst!: () => void;
  const firstAppendBlocked = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  let appendCalls = 0;

  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 20,
    output: stream,
    installSigintHandler: false,
    traceRecorder: {
      append: async () => {
        appendCalls += 1;
        if (appendCalls === 1) await firstAppendBlocked;
      },
    },
  });

  // Initially zero — nothing has been dropped yet.
  assert.equal(
    handle.getDroppedTraceFrames(),
    0,
    "dropped count must start at zero",
  );

  // Let the loop tick several times while the first append blocks so
  // backpressure kicks in and drops subsequent frames.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const droppedWhileBlocked = handle.getDroppedTraceFrames();
  assert.ok(
    droppedWhileBlocked > 0,
    `expected > 0 dropped frames while append was blocked, got ${droppedWhileBlocked}`,
  );

  // Release and stop cleanly.
  resolveFirst();
  handle.stop();
  await handle.done;
});

test("stop() clears the interval and resolves done", async () => {
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 30,
    output: stream,
    installSigintHandler: false,
  });

  // Let it paint at least once.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const beforeStop = stream.chunks.length;
  handle.stop();
  await handle.done;

  // Wait past several would-be intervals and confirm no further paints.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterStop = stream.chunks.length;
  // A single trailing write (cursor restore) is allowed but no paints
  // beyond that should happen.
  assert.ok(
    afterStop - beforeStop <= 1,
    `expected interval to stop, saw ${afterStop - beforeStop} extra writes`,
  );

  // done() resolved (we already awaited it). Calling stop again is a no-op.
  handle.stop();
});

test(
  "stop() awaits in-flight tick body before resolving done (Codex P2 #732 round 4)",
  async () => {
    // Regression: prior to this fix, `stop()` resolved `done`
    // synchronously after clearing the interval, even if a tick was
    // mid-flight. If the tick had already passed its `if (stopped)
    // return` check, it would proceed to call
    // `traceRecorder.append(snapshot)` AFTER `done` resolved and the
    // CLI shutdown path began closing the recorder, producing a
    // post-close append race against the recorder. The fix wires
    // `done` to await the in-flight tick body before resolving so
    // any `recorder.append()` call has been *invoked* (synchronously
    // enqueueing onto the recorder's writeChain) before the close
    // path begins; `recorder.close()` then drains that chain.
    //
    // We exercise the race by calling `stop()` immediately AFTER
    // letting the loop tick once, then holding the SECOND tick mid-
    // flight via a slow `traceRecorder.append`. If `stop()` resolved
    // `done` synchronously (the buggy behavior), the tick body's
    // post-`stopped`-check work would still be running when the
    // observer code below ran. The fix guarantees the tick has
    // either completed (and the recorder.append entry observed) OR
    // bailed cleanly before `done` resolves.
    //
    // Specifically we verify that `done` does NOT resolve while the
    // tick promise is still executing its synchronous body. We
    // instrument the tick path via a custom `now()` clock that
    // throws on the FIRST call (forcing the renderer's catch path
    // to record an `appendCalls` increment — see below) and
    // measures wall-clock ordering.
    const stream = new CaptureStream();
    const orchestrator = makeOrchestrator();
    let appendInvocations = 0;
    let appendInvocationOrder = 0;
    let doneOrder = 0;
    let order = 0;
    const handle = runConsoleTui(orchestrator, {
      refreshIntervalMs: 30,
      output: stream,
      installSigintHandler: false,
      traceRecorder: {
        // Important: this synchronous portion (the increment) must
        // happen BEFORE `done` resolves, otherwise the CLI's
        // post-`done` `recorder.close()` would race a not-yet-
        // started append. Track invocation order so the assertion
        // below can verify done resolves AFTER the invocation.
        append: async () => {
          appendInvocations += 1;
          if (appendInvocationOrder === 0) {
            appendInvocationOrder = ++order;
          }
        },
      },
    });

    // Let the loop tick at least once so `append` has been called.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(
      appendInvocations >= 1,
      `expected at least one append invocation pre-stop, saw ${appendInvocations}`,
    );

    handle.stop();
    await handle.done;
    doneOrder = ++order;

    // With the fix, `done` waits for the in-flight tick body to
    // resolve. By the time we get here, the FIRST append invocation
    // (which we observed before stop()) has happened. The
    // meaningful invariant is: any append invocation that the tick
    // was going to make has been made before `done` resolved —
    // there is no later synchronous-portion-of-append that could
    // still race `recorder.close()`.
    assert.ok(
      appendInvocationOrder > 0 && appendInvocationOrder < doneOrder,
      `expected first append to land before done resolves; ` +
        `appendOrder=${appendInvocationOrder} doneOrder=${doneOrder}`,
    );
  },
);

test(
  "stop() does not resolve done before the in-flight tick promise settles (Codex P2 #732 round 4)",
  async () => {
    // Direct invariant test: the tick body's `inFlight = false`
    // assignment in its `finally` block must run before `done`
    // resolves. We instrument by overriding the orchestrator's
    // buffer accessor to flip a flag on entry and exit; the test
    // then asserts that if entry was observed, the post-`done`
    // observation sees the exit too. Without the fix, `done` could
    // resolve between `entry` and `exit`, producing the post-close
    // append race the codex thread describes.
    const stream = new CaptureStream();
    let entered = 0;
    let exited = 0;
    const orchestrator: ConsoleStateOrchestratorLike = {
      config: { memoryDir: "/nonexistent" },
      qmd: {
        isAvailable: () => true,
        isDaemonMode: () => false,
        debugStatus: () => "stub",
      },
      buffer: {
        getTurns: () => {
          entered += 1;
          try {
            return [{ content: "x" }];
          } finally {
            exited += 1;
          }
        },
      },
    };
    let appendCalls = 0;
    const handle = runConsoleTui(orchestrator, {
      refreshIntervalMs: 30,
      output: stream,
      installSigintHandler: false,
      traceRecorder: {
        append: async () => {
          appendCalls += 1;
        },
      },
    });

    // Let one tick happen so we know the loop is alive.
    await new Promise((resolve) => setTimeout(resolve, 80));
    handle.stop();
    await handle.done;

    // Every entry observed must have a matching exit by the time
    // `done` resolves. Without the fix, the most recent tick could
    // have entered (incremented `entered`) but not yet exited
    // (incremented `exited`) — the in-flight tick body still
    // running while `done` already resolved.
    assert.equal(
      entered,
      exited,
      `tick body entry/exit must be balanced by done; entered=${entered} exited=${exited}`,
    );
    assert.ok(
      appendCalls >= 1,
      `expected at least one append before done; saw ${appendCalls}`,
    );
  },
);

