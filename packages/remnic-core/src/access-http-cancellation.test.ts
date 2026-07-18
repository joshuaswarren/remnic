import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService, type EngramAccessRecallRequest } from "./access-service.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitFor<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

test("HTTP recall aborts in-flight work when the client disconnects", async () => {
  const recallStarted = deferred<void>();
  const recallSettled = deferred<void>();
  const forceRelease = deferred<void>();
  let observedSignal: AbortSignal | undefined;
  const service = {
    recall: async (input: EngramAccessRecallRequest) => {
      observedSignal = input.abortSignal;
      recallStarted.resolve();
      try {
        await Promise.race([
          forceRelease.promise,
          new Promise<void>((_resolve, reject) => {
            input.abortSignal?.addEventListener(
              "abort",
              () => reject(input.abortSignal?.reason),
              { once: true },
            );
          }),
        ]);
      } finally {
        recallSettled.resolve();
      }
      if (input.abortSignal?.aborted) {
        throw input.abortSignal.reason;
      }
      return {} as never;
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });
  const status = await server.start();

  try {
    const client = httpRequest({
      host: "127.0.0.1",
      port: status.port,
      path: "/engram/v1/recall",
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
    });
    client.on("error", () => {});
    client.end(JSON.stringify({ query: "slow recall" }));

    await waitFor(recallStarted.promise);
    assert.ok(observedSignal, "the HTTP request signal must reach the recall service");
    client.destroy();

    await waitFor(recallSettled.promise);
    assert.equal(observedSignal.aborted, true);
  } finally {
    forceRelease.resolve();
    await server.stop();
  }
});

test("a queued recall rejects immediately on abort — before the holder releases — and never starts", async () => {
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let secondStarted = false;
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const lockHost = service as unknown as {
    recallSemaphores: Map<string, unknown>;
    orchestrator: { config: Record<string, unknown> };
    withRecallConcurrency<T>(
      principal: string,
      abortSignal: AbortSignal | undefined,
      operation: (queueWaitMs: number) => Promise<T>,
    ): Promise<T>;
  };
  lockHost.recallSemaphores = new Map();
  // limit=1 => the second recall must queue behind the first.
  lockHost.orchestrator = { config: { recallMaxConcurrentPerPrincipal: 1 } };

  const first = lockHost.withRecallConcurrency("principal", undefined, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const controller = new AbortController();
  const second = lockHost.withRecallConcurrency("principal", controller.signal, async () => {
    secondStarted = true;
  });
  controller.abort();

  // The queued recall rejects on abort WITHOUT waiting for the holder to
  // release — the #1906 behavior change (the old width-1 lock only re-checked
  // the abort signal after acquiring). The holder is still held here.
  await assert.rejects(waitFor(second), (error: Error) => error.name === "AbortError");
  assert.equal(secondStarted, false);

  releaseFirst.resolve();
  await first;
});

test("an aborted queued recall does not poison the per-principal recall lane", async () => {
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let secondStarted = false;
  let thirdStarted = false;
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const lockHost = service as unknown as {
    recallSemaphores: Map<string, unknown>;
    orchestrator: { config: Record<string, unknown> };
    withRecallConcurrency<T>(
      principal: string,
      abortSignal: AbortSignal | undefined,
      operation: (queueWaitMs: number) => Promise<T>,
    ): Promise<T>;
  };
  lockHost.recallSemaphores = new Map();
  lockHost.orchestrator = { config: { recallMaxConcurrentPerPrincipal: 1 } };

  const first = lockHost.withRecallConcurrency("principal", undefined, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const controller = new AbortController();
  const second = lockHost.withRecallConcurrency("principal", controller.signal, async () => {
    secondStarted = true;
  });
  const third = lockHost.withRecallConcurrency("principal", undefined, async () => {
    thirdStarted = true;
  });
  controller.abort();
  releaseFirst.resolve();

  await first;
  await assert.rejects(waitFor(second), (error: Error) => error.name === "AbortError");
  await waitFor(third);
  assert.equal(secondStarted, false);
  assert.equal(thirdStarted, true);
});

function makeRecallServiceProbe(): {
  service: EngramAccessService;
  setExecuteRecall: (execute: () => Promise<void>) => void;
  requestFingerprint: () => unknown;
  stored: () => boolean;
} {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  let executeRecall = async () => {};
  let capturedFingerprint: unknown;
  let didStore = false;
  const host = service as unknown as {
    recallSemaphores: Map<string, unknown>;
    recallInFlight: Map<string, unknown>;
    orchestrator: { config: Record<string, unknown> };
    resolveRequestPrincipal: () => string;
    executeRecall: () => Promise<{ response: Record<string, never>; budgetRecordPrincipal: null }>;
    handleIdempotentRead: (options: {
      requestFingerprint: unknown;
      execute: () => Promise<Record<string, never>>;
    }) => Promise<Record<string, never>>;
  };
  host.recallSemaphores = new Map();
  host.recallInFlight = new Map();
  host.orchestrator = {
    config: { recallMaxConcurrentPerPrincipal: 4, recallSingleFlightEnabled: true },
  };
  host.resolveRequestPrincipal = () => "principal";
  host.executeRecall = async () => {
    await executeRecall();
    return { response: {}, budgetRecordPrincipal: null };
  };
  host.handleIdempotentRead = async (options) => {
    capturedFingerprint = options.requestFingerprint;
    const response = await options.execute();
    didStore = true;
    return response;
  };
  return {
    service,
    setExecuteRecall: (execute) => {
      executeRecall = execute;
    },
    requestFingerprint: () => capturedFingerprint,
    stored: () => didStore,
  };
}

test("recall excludes its abort signal from the idempotency fingerprint", async () => {
  const probe = makeRecallServiceProbe();
  await probe.service.recall({
    query: "same payload",
    idempotencyKey: "same-key",
    abortSignal: new AbortController().signal,
  });

  assert.equal(
    Object.hasOwn(probe.requestFingerprint() as object, "abortSignal"),
    false,
  );
});

test("recall does not store a result when the pipeline consumes an abort", async () => {
  const probe = makeRecallServiceProbe();
  const controller = new AbortController();
  probe.setExecuteRecall(async () => {
    controller.abort();
  });

  await assert.rejects(
    probe.service.recall({
      query: "cancelled",
      idempotencyKey: "cancelled-key",
      abortSignal: controller.signal,
    }),
    (error: Error) => error.name === "AbortError",
  );
  assert.equal(probe.stored(), false);
});
