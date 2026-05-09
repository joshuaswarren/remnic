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
