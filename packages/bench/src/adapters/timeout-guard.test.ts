import assert from "node:assert/strict";
import test from "node:test";

import {
  createTimeoutGuardedIngestionAdapter,
  createTimeoutGuardedAdapter,
  resolveBenchmarkPhaseTimeoutMs,
  resolveBenchmarkProgressLogging,
} from "./timeout-guard.ts";
import type { BenchMemoryAdapter } from "./types.ts";

function makeAdapter(): BenchMemoryAdapter {
  return {
    async store() {},
    async recall() {
      return "ok";
    },
    async search() {
      return [];
    },
    async reset() {},
    async getStats() {
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
    },
    async destroy() {},
  };
}

test("timeout guard rejects a stuck adapter phase", async () => {
  const adapter = makeAdapter();
  adapter.recall = async () => new Promise<string>(() => {});
  let timedOutPhase = "";
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 5,
    onTimeout(phase) {
      timedOutPhase = phase;
    },
  });

  await assert.rejects(
    () => guarded.recall("s", "q"),
    /benchmark phase timed out after 5ms: timeout-test:recall session=s/,
  );
  assert.equal(timedOutPhase, "timeout-test:recall session=s");
});

test("timeout guard preserves and forwards recallWithTrace", async () => {
  const adapter = makeAdapter();
  let receivedSignal: AbortSignal | undefined;
  adapter.recallWithTrace = async (_sessionId, _query, _budget, _options, control) => {
    receivedSignal = control?.signal;
    return {
      text: "ok",
      trace: {
        schemaVersion: 1,
        sensitivity: {
          classification: "restricted",
          contentEncoding: "sha256+length",
          containsGold: false,
        },
        sections: [],
        selections: [],
        lcmCandidates: [],
        budget: {
          requestedChars: 10,
          composedChars: 2,
          returnedChars: 2,
          truncated: false,
        },
      },
    };
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 1_000,
  });

  const result = await guarded.recallWithTrace!("s", "q", 10);
  assert.equal(result.text, "ok");
  assert.ok(receivedSignal);
});

test("timeout guard times out recallWithTrace independently", async () => {
  const adapter = makeAdapter();
  adapter.recallWithTrace = async () => new Promise(() => {});
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 5,
  });

  await assert.rejects(
    () => guarded.recallWithTrace!("s", "q"),
    /benchmark phase timed out after 5ms: timeout-test:recallWithTrace session=s/,
  );
});

test("timeout guard forwards the optional correct surface with phase guarding", async () => {
  const adapter = makeAdapter();
  const correctCalls: Array<{ session: string; text: string; at?: string }> = [];
  adapter.correct = async (sessionId, text, at) => {
    correctCalls.push({ session: sessionId, text, ...(at !== undefined ? { at } : {}) });
    return { applied: true };
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 1000,
  });

  assert.ok(guarded.correct, "guarded adapter must preserve correct()");
  const outcome = await guarded.correct("s", "fix this", "2026-07-05T00:00:00Z");
  assert.deepEqual(outcome, { applied: true });
  assert.deepEqual(correctCalls, [
    { session: "s", text: "fix this", at: "2026-07-05T00:00:00Z" },
  ]);
});

test("timeout guard omits correct when the adapter has none", () => {
  const guarded = createTimeoutGuardedAdapter(makeAdapter(), {
    benchmarkId: "timeout-test",
    timeoutMs: 1000,
  });
  assert.equal(guarded.correct, undefined);
});

test("timeout guard rejects a stuck correct phase", async () => {
  const adapter = makeAdapter();
  adapter.correct = () => {
    const { promise } = Promise.withResolvers<{ applied: boolean }>();
    return promise;
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 5,
  });
  await assert.rejects(
    () => guarded.correct!("s", "fix this"),
    /benchmark phase timed out after 5ms: timeout-test:correct session=s/,
  );
});

test("timeout guard aborts adapter phase work on timeout", async () => {
  const adapter = makeAdapter();
  let sawAbort = false;
  let delayedSideEffect = false;
  let sideEffectTimer: ReturnType<typeof setTimeout> | undefined;
  adapter.store = (_sessionId, _messages, control) =>
    new Promise<never>((_, reject) => {
      sideEffectTimer = setTimeout(() => {
        delayedSideEffect = true;
      }, 25);
      const signal = control?.signal;
      const onAbort = () => {
        sawAbort = true;
        if (sideEffectTimer) {
          clearTimeout(sideEffectTimer);
        }
        reject(signal?.reason);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 5,
  });

  await assert.rejects(
    () => guarded.store("s", [{ role: "user", content: "hello" }]),
    /benchmark phase timed out after 5ms: timeout-test:store session=s messages=1/,
  );
  assert.equal(sawAbort, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(delayedSideEffect, false);
});

test("timeout guard preserves caller abort signal without phase timeout", async () => {
  const adapter = makeAdapter();
  let sawAbort = false;
  adapter.store = (_sessionId, _messages, control) =>
    new Promise<never>((_, reject) => {
      const signal = control?.signal;
      const onAbort = () => {
        sawAbort = true;
        reject(signal?.reason);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
  });
  const controller = new AbortController();
  const storePromise = guarded.store(
    "s",
    [{ role: "user", content: "hello" }],
    { signal: controller.signal },
  );

  controller.abort(new Error("caller aborted"));

  await assert.rejects(() => storePromise, /caller aborted/);
  assert.equal(sawAbort, true);
});

test("timeout guard merges caller abort signal with phase timeout signal", async () => {
  const adapter = makeAdapter();
  let sawAbort = false;
  adapter.search = (_query, _limit, _sessionId, control) =>
    new Promise<never>((_, reject) => {
      const signal = control?.signal;
      const onAbort = () => {
        sawAbort = true;
        reject(signal?.reason);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 1000,
  });
  const controller = new AbortController();
  const searchPromise = guarded.search("q", 5, "s", {
    signal: controller.signal,
  });

  controller.abort(new Error("caller aborted search"));

  await assert.rejects(() => searchPromise, /caller aborted search/);
  assert.equal(sawAbort, true);
});

test("timeout guard removes merged caller abort listeners after successful phases", async () => {
  const adapter = makeAdapter();
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 100,
  });
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let activeAbortListeners = 0;
  const trackedAdd: AbortSignal["addEventListener"] = (
    ...args: Parameters<AbortSignal["addEventListener"]>
  ) => {
    const [type] = args;
    if (type === "abort") activeAbortListeners += 1;
    return originalAdd(...args);
  };
  const trackedRemove: AbortSignal["removeEventListener"] = (
    ...args: Parameters<AbortSignal["removeEventListener"]>
  ) => {
    const [type] = args;
    if (type === "abort") activeAbortListeners -= 1;
    return originalRemove(...args);
  };
  signal.addEventListener = trackedAdd;
  signal.removeEventListener = trackedRemove;

  await guarded.getStats("s", { signal });
  await guarded.getStats("s", { signal });

  assert.equal(activeAbortListeners, 0);
});

test("timeout guard forwards recall options", async () => {
  const adapter = makeAdapter();
  let forwardedAsOf = "";
  adapter.recall = async (_sessionId, _query, _budgetChars, options) => {
    forwardedAsOf = options?.asOf ?? "";
    return "ok";
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 100,
  });

  assert.equal(
    await guarded.recall("s", "q", 1000, { asOf: "2026-05-10T12:00:00Z" }),
    "ok",
  );
  assert.equal(forwardedAsOf, "2026-05-10T12:00:00Z");
});

test("timeout guard wraps responder and judge calls", async () => {
  const adapter = makeAdapter();
  adapter.responder = {
    async respond() {
      return {
        text: "answer",
        tokens: { input: 1, output: 1 },
        latencyMs: 1,
        model: "fake",
      };
    },
  };
  adapter.judge = {
    async score() {
      return 1;
    },
  };

  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 100,
  });

  assert.equal(
    (await guarded.responder?.respond("q", "r"))?.text,
    "answer",
  );
  assert.equal(await guarded.judge?.score("q", "p", "e"), 1);
});

test("timeout guard forwards responder identity when the inner responder declares one", () => {
  const adapter = makeAdapter();
  adapter.responder = {
    async respond() {
      return {
        text: "answer",
        tokens: { input: 1, output: 1 },
        latencyMs: 1,
        model: "fake",
      };
    },
    identity() {
      return "responder:fake";
    },
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 100,
  });
  assert.equal(guarded.responder?.identity?.(), "responder:fake");
});

test("timeout guard omits responder identity when the inner responder has none", () => {
  const adapter = makeAdapter();
  adapter.responder = {
    async respond() {
      return {
        text: "answer",
        tokens: { input: 1, output: 1 },
        latencyMs: 1,
        model: "fake",
      };
    },
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 100,
  });
  assert.equal(guarded.responder?.identity, undefined);
});

test("timeout guard merges caller abort signal for responder calls", async () => {
  const adapter = makeAdapter();
  let sawAbort = false;
  adapter.responder = {
    respond(_question, _recalledText, control) {
      return new Promise<never>((_, reject) => {
        const signal = control?.signal;
        const onAbort = () => {
          sawAbort = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 1000,
  });
  const controller = new AbortController();
  const responsePromise = guarded.responder!.respond("q", "r", {
    signal: controller.signal,
  });

  controller.abort(new Error("caller aborted responder"));

  await assert.rejects(() => responsePromise, /caller aborted responder/);
  assert.equal(sawAbort, true);
});

test("timeout guard merges caller abort signal for judge calls", async () => {
  const adapter = makeAdapter();
  let sawAbort = false;
  adapter.judge = {
    score(_question, _predicted, _expected, control) {
      return new Promise<never>((_, reject) => {
        const signal = control?.signal;
        const onAbort = () => {
          sawAbort = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 1000,
  });
  const controller = new AbortController();
  const scorePromise = guarded.judge!.score("q", "p", "e", {
    signal: controller.signal,
  });

  controller.abort(new Error("caller aborted judge"));

  await assert.rejects(() => scorePromise, /caller aborted judge/);
  assert.equal(sawAbort, true);
});

test("timeout guard aborts responder phase work on timeout", async () => {
  const adapter = makeAdapter();
  let sawAbort = false;
  adapter.responder = {
    respond(_question, _recalledText, control) {
      return new Promise<never>((_, reject) => {
        const signal = control?.signal;
        const onAbort = () => {
          sawAbort = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 5,
  });

  await assert.rejects(
    () => guarded.responder!.respond("q", "r"),
    /benchmark phase timed out after 5ms: timeout-test:respond/,
  );
  assert.equal(sawAbort, true);
});

test("timeout guard waits briefly for aborted phase cleanup", async () => {
  const adapter = makeAdapter();
  let cleanedUp = false;
  adapter.responder = {
    respond(_question, _recalledText, control) {
      return new Promise<never>((_, reject) => {
        control?.signal?.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              cleanedUp = true;
              reject(control.signal?.reason);
            }, 20);
          },
          { once: true },
        );
      });
    },
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 5,
  });

  await assert.rejects(
    () => guarded.responder!.respond("q", "r"),
    /benchmark phase timed out after 5ms: timeout-test:respond/,
  );
  assert.equal(cleanedUp, true);
});

test("timeout guard aborts judge phase work on timeout", async () => {
  const adapter = makeAdapter();
  let sawAbort = false;
  adapter.judge = {
    async score() {
      return 0;
    },
    scoreWithMetrics(_question, _predicted, _expected, control) {
      return new Promise<never>((_, reject) => {
        const signal = control?.signal;
        const onAbort = () => {
          sawAbort = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 5,
  });

  await assert.rejects(
    () => guarded.judge!.scoreWithMetrics!("q", "p", "e"),
    /benchmark phase timed out after 5ms: timeout-test:judge.scoreWithMetrics/,
  );
  assert.equal(sawAbort, true);
});

test("timeout guard uses a separate drain timeout", async () => {
  const adapter = makeAdapter();
  adapter.drain = async () => new Promise<void>(() => {});
  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    timeoutMs: 100,
    drainTimeoutMs: 5,
  });

  await assert.rejects(
    () => guarded.drain!(),
    /benchmark phase timed out after 5ms: timeout-test:drain/,
  );
});

test("timeout guard supports a drain-only timeout", async () => {
  const adapter = makeAdapter();
  let responderReceivedSignal = false;
  adapter.drain = async () => new Promise<void>(() => {});
  adapter.responder = {
    async respond(_question, _recalledText, control) {
      responderReceivedSignal = control?.signal !== undefined;
      return {
        text: "answer",
        tokens: { input: 1, output: 1 },
        latencyMs: 1,
        model: "fake",
      };
    },
  };

  const guarded = createTimeoutGuardedAdapter(adapter, {
    benchmarkId: "timeout-test",
    drainTimeoutMs: 5,
  });

  assert.equal(await guarded.recall("s", "q"), "ok");
  assert.equal((await guarded.responder?.respond("q", "r"))?.text, "answer");
  assert.equal(responderReceivedSignal, false);
  await assert.rejects(
    () => guarded.drain!(),
    /benchmark phase timed out after 5ms: timeout-test:drain/,
  );
});

test("resolveBenchmarkPhaseTimeoutMs prefers explicit benchmark config", () => {
  assert.equal(
    resolveBenchmarkPhaseTimeoutMs({
      remnicConfig: { benchmarkPhaseTimeoutMs: 123 },
      systemProvider: {
        provider: "openai",
        model: "fake",
        retryOptions: { timeoutMs: 456 },
      },
    }),
    123,
  );
});

test("resolveBenchmarkPhaseTimeoutMs coerces string config values", () => {
  assert.equal(
    resolveBenchmarkPhaseTimeoutMs({
      remnicConfig: { benchmarkPhaseTimeoutMs: "123" },
    }),
    123,
  );
});

test("resolveBenchmarkPhaseTimeoutMs falls back to provider timeout", () => {
  assert.equal(
    resolveBenchmarkPhaseTimeoutMs({
      systemProvider: {
        provider: "openai",
        model: "fake",
        retryOptions: { timeoutMs: 456 },
      },
    }),
    456,
  );
});

test("resolveBenchmarkPhaseTimeoutMs ignores transport-only provider timeouts", () => {
  assert.equal(
    resolveBenchmarkPhaseTimeoutMs({
      systemProvider: {
        provider: "codex-cli",
        model: "gpt-5.6-luna",
        providerRequestTimeoutMs: 180_000,
      },
      judgeProvider: {
        provider: "codex-cli",
        model: "gpt-5.6-terra",
        providerRequestTimeoutMs: 180_000,
      },
    }),
    undefined,
  );
});

test("resolveBenchmarkProgressLogging coerces boolean-like string config", () => {
  assert.equal(resolveBenchmarkProgressLogging({ benchmarkHarnessProgress: "true" }), true);
  assert.equal(resolveBenchmarkProgressLogging({ benchmarkHarnessProgress: "0" }), false);
});

test("timeout guard wraps ingestion adapter calls", async () => {
  let destroyed = false;
  const guarded = createTimeoutGuardedIngestionAdapter(
    {
      async ingest() {
        return new Promise(() => {});
      },
      async getMemoryGraph() {
        return { entities: [], links: [], pages: [] };
      },
      async reset() {},
      async destroy() {
        destroyed = true;
      },
    },
    {
      benchmarkId: "timeout-test",
      timeoutMs: 5,
      onTimeout: () => {
        destroyed = true;
      },
    },
  );

  await assert.rejects(
    () => guarded.ingest("/tmp/input"),
    /benchmark phase timed out after 5ms: timeout-test:ingestion.ingest inputDir=\/tmp\/input/,
  );
  assert.equal(destroyed, true);
});

test("timeout guard preserves ingestion adapter drain hook", async () => {
  let drained = false;
  const guarded = createTimeoutGuardedIngestionAdapter(
    {
      async ingest() {
        return { commandsIssued: [], promptsShown: [], errors: [], durationMs: 0 };
      },
      async getMemoryGraph() {
        return { entities: [], links: [], pages: [] };
      },
      async reset() {},
      async drain() {
        drained = true;
      },
      async destroy() {},
    },
    {
      benchmarkId: "timeout-test",
      timeoutMs: 100,
    },
  );

  assert.equal(typeof guarded.drain, "function");
  await guarded.drain?.();
  assert.equal(drained, true);
});

test("timeout guard uses separate ingestion drain timeout", async () => {
  const guarded = createTimeoutGuardedIngestionAdapter(
    {
      async ingest() {
        return { commandsIssued: [], promptsShown: [], errors: [], durationMs: 0 };
      },
      async getMemoryGraph() {
        return { entities: [], links: [], pages: [] };
      },
      async reset() {},
      async drain() {
        return new Promise<void>(() => {});
      },
      async destroy() {},
    },
    {
      benchmarkId: "timeout-test",
      timeoutMs: 100,
      drainTimeoutMs: 5,
    },
  );

  await assert.rejects(
    () => guarded.drain!(),
    /benchmark phase timed out after 5ms: timeout-test:ingestion.drain/,
  );
});
