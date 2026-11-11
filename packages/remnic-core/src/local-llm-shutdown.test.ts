// Shutdown-signal behavioral tests for LocalLlmClient: a daemon stop must
// abort in-flight chat requests at once (the abort reaches the transport),
// must not start another attempt once aborted, and must not sit out the
// retry backoff after abort. Uses the globalThis.fetch seam from
// local-llm-qos.test.ts with a hanging transport so the real retry loop is
// exercised, not a mock of it.
import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { LocalLlmClient } from "./local-llm.js";
import { initLogger, resetLogger, type LoggerBackend } from "./logger.js";

/** Captured log lines with the logger's "remnic: " prefix stripped. */
interface CapturedLog {
  lines: string[];
}

function createConfig(memoryDir: string) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: `${memoryDir}/workspace`,
    localLlmEnabled: true,
    localLlmModel: "test-local-model",
    localLlmUrl: "http://127.0.0.1:9",
    // Mirror the production daemon: a 10-minute budget with 2 attempts, so
    // an unhonored abort would outlive any sane test deadline.
    localLlmTimeoutMs: 600_000,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 30_000,
    localLlmHeaders: {},
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 60_000,
    localLlmReasoningEffort: "none",
    debug: false,
  });
}

interface HangingFetchSpec {
  calls: { signal: AbortSignal | undefined }[];
  sawAbort: boolean;
  /** Reject with AbortError after delayMs (timeout simulation); default hangs forever. */
  timeoutAfterMs?: number;
  /** Resolves when the transport stub is entered (request is in flight). */
  entered: Promise<void>;
}

function installHangingFetch(spec: HangingFetchSpec): () => void {
  const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
  spec.entered = entered;
  const originalFetch = globalThis.fetch;
  // SAFETY: the transport passes a string URL and an init with a signal;
  // this async stub matches that call shape exactly.
  globalThis.fetch = (async (url: string, init?: { signal?: AbortSignal }) => {
    void url;
    const signal = init?.signal;
    spec.calls.push({ signal });
    markEntered();
    const { promise, reject } = Promise.withResolvers<Response>();
    // A real transport rejects with AbortError when its signal aborts
    // (undici behavior); the stub must honor it the same way or the client
    // loop cannot observe the abort.
    const onAbort = (): void => {
      spec.sawAbort = true;
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (spec.timeoutAfterMs !== undefined) {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("This operation was aborted", "AbortError"));
      }, spec.timeoutAfterMs);
      timer.unref?.();
    }
    return await promise;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** Polls a real runtime condition (a log line, a stub entry) instead of a
 *  guessed fixed sleep: the condition, not a duration, gates progress. */
async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label}: test deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function installRecordingLogger(): CapturedLog {
  const lines: string[] = [];
  const body = (msg: string) => msg.replace(/^remnic: /, "");
  const backend: LoggerBackend = {
    info: (msg) => lines.push(body(msg)),
    warn: (msg) => lines.push(body(msg)),
    error: (msg) => lines.push(body(msg)),
  };
  initLogger(backend, false, { timestamps: false });
  return { lines };
}

function quietLogger(): void {
  initLogger({ info() {}, warn() {}, error() {}, debug() {} }, false);
}

test("aborting the client shutdown signal aborts an in-flight request and reaches the transport stub", async () => {
  quietLogger();
  const spec: HangingFetchSpec = { calls: [], sawAbort: false, entered: Promise.resolve() };
  const restoreFetch = installHangingFetch(spec);
  try {
    const controller = new AbortController();
    const client = new LocalLlmClient(createConfig("/tmp/remnic-llm-shutdown-inflight"), undefined, controller.signal);
    // SAFETY: availability is stubbed at the established field seam (same as
    // local-llm-qos.test.ts) so the retry loop, not the network probe, runs.
    const seams = client as any;
    seams.isAvailable = true;
    seams.lastHealthCheck = Date.now();

    const pending = client.chatCompletion(
      [{ role: "user", content: "shutdown abort in flight" }],
      { operation: "extraction" },
    );

    await spec.entered;
    controller.abort();

    const result = await withTestDeadline(pending, 2_000, "in-flight abort");
    assert.equal(result, null);
    assert.equal(spec.calls.length, 1, "no second attempt may start after abort");
    assert.equal(spec.sawAbort, true, "the abort signal must reach the transport stub");
    assert.equal(spec.calls[0]?.signal?.aborted, true);
  } finally {
    restoreFetch();
    resetLogger();
  }
});

test("an abort during retry backoff ends the loop without sleeping it out or starting another attempt", async () => {
  const { lines } = installRecordingLogger();
  const spec: HangingFetchSpec = { calls: [], sawAbort: false, timeoutAfterMs: 20, entered: Promise.resolve() };
  const restoreFetch = installHangingFetch(spec);
  try {
    const controller = new AbortController();
    const client = new LocalLlmClient(createConfig("/tmp/remnic-llm-shutdown-backoff"), undefined, controller.signal);
    // SAFETY: availability is stubbed at the established field seam (same as
    // local-llm-qos.test.ts) so the retry loop, not the network probe, runs.
    const seams = client as any;
    seams.isAvailable = true;
    seams.lastHealthCheck = Date.now();

    const pending = client.chatCompletion(
      [{ role: "user", content: "shutdown abort during backoff" }],
      { operation: "extraction" },
    );

    // Sync point: the retry loop is in its 30s backoff when the backoff
    // warn line lands; abort there.
    await waitFor(
      () => lines.some((line) => line.includes("retrying after 30000ms")),
      "attempt 1 to fail and backoff to start",
    );
    controller.abort();

    const startedAtMs = Date.now();
    const result = await withTestDeadline(pending, 2_000, "backoff abort");
    assert.equal(result, null);
    assert.ok(Date.now() - startedAtMs < 1_500, "backoff must not be slept out after abort");
    assert.equal(spec.calls.length, 1, "no second attempt may start after abort");
  } finally {
    restoreFetch();
    resetLogger();
  }
});
