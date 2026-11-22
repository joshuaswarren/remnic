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
  assert.match(plain, /Buffer\b/);
  assert.match(plain, /Extraction\b/);
  assert.match(plain, /Dedup\b/);
  assert.match(plain, /Maintenance\b/);
  assert.match(plain, /QMD\b/);
});

test("runConsoleTui repaints once on start and survives a snapshot failure", async () => {
  const stream = new CaptureStream();
  let calls = 0;
  const orchestrator: ConsoleStateOrchestratorLike = {
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

  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  await handle.done;

  const text = stream.textPlain();
  assert.match(text, /remnic console/);
  assert.match(text, /Buffer\b/);
  assert.ok(calls >= 2, `expected >= 2 buffer reads, got ${calls}`);
});

test("renderFrame produces panel lines aligned with header/footer borders", () => {
  const frame = renderFrame({
    snapshot: makeSnapshot(),
    renderError: null,
    now: () => Date.parse("2025-01-01T00:00:00.000Z"),
  });
  const lines = frame.split("\n").filter((l) => l.length > 0);
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(
    widths.size,
    1,
    `expected uniform line widths, saw ${[...widths].sort().join(", ")}`,
  );
});

test("runConsoleTui survives a renderer-side exception without freezing", async () => {
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  let nowCalls = 0;
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 30,
    output: stream,
    installSigintHandler: false,
    now: () => {
      nowCalls += 1;
      if (nowCalls <= 2) return Number.NaN;
      return Date.parse("2025-01-01T00:00:00.000Z");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  await handle.done;

  assert.ok(
    nowCalls >= 3,
    `expected loop to keep ticking past renderer failure, saw ${nowCalls} now() calls`,
  );
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
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  let appendCalls = 0;
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

  assert.equal(
    appendCalls,
    1,
    `under backpressure, only the first stalled append should fire, saw ${appendCalls}`,
  );
  const text = stream.textPlain();
  const headerCount = (text.match(/remnic console/g) ?? []).length;
  assert.ok(
    headerCount >= 3,
    `expected >= 3 painted frames despite stalled trace, saw ${headerCount}`,
  );
});

test("trace backpressure drops frames while a previous append is pending (Codex P2 #732)", async (t) => {
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
        if (appendCalls === 1) await firstAppendBlocked;
      },
    },
  });
  t.after(() => {
    resolveFirst();
    handle.stop();
    return handle.done;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    appendCalls,
    1,
    `expected backpressure to gate appends while one is pending, saw ${appendCalls}`,
  );
  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(
    appendCalls >= 2,
    `expected appends to resume after pending one drained, saw ${appendCalls}`,
  );
});

test("getDroppedTraceFrames starts at zero and increases under backpressure (Codex P2 #732 round 5)", async (t) => {
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
  t.after(() => {
    resolveFirst();
    handle.stop();
    return handle.done;
  });

  assert.equal(
    handle.getDroppedTraceFrames(),
    0,
    "dropped count must start at zero",
  );

  await new Promise((resolve) => setTimeout(resolve, 150));

  const droppedWhileBlocked = handle.getDroppedTraceFrames();
  assert.ok(
    droppedWhileBlocked > 0,
    `expected > 0 dropped frames while append was blocked, got ${droppedWhileBlocked}`,
  );
});

test("stop() clears the interval and resolves done", async () => {
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 30,
    output: stream,
    installSigintHandler: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const beforeStop = stream.chunks.length;
  handle.stop();
  await handle.done;

  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterStop = stream.chunks.length;
  assert.ok(
    afterStop - beforeStop <= 1,
    `expected interval to stop, saw ${afterStop - beforeStop} extra writes`,
  );

  handle.stop();
});

test(
  "stop() awaits in-flight tick body before resolving done (Codex P2 #732 round 4)",
  async (t) => {
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
        append: async () => {
          appendInvocations += 1;
          if (appendInvocationOrder === 0) {
            appendInvocationOrder = ++order;
          }
        },
      },
    });
    t.after(() => {
      handle.stop();
      return handle.done;
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(
      appendInvocations >= 1,
      `expected at least one append invocation pre-stop, saw ${appendInvocations}`,
    );

    handle.stop();
    await handle.done;
    doneOrder = ++order;

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
    const stream = new CaptureStream();
    let entered = 0;
    let exited = 0;
    const orchestrator: ConsoleStateOrchestratorLike = {
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

    await new Promise((resolve) => setTimeout(resolve, 80));
    handle.stop();
    await handle.done;

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

