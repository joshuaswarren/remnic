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

test("a disconnected recall queued on the principal budget lock never starts", async () => {
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let secondStarted = false;
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const lockHost = service as unknown as {
    budgetLocks: Map<string, Promise<void>>;
    withBudgetLock<T>(
      principal: string,
      abortSignal: AbortSignal | undefined,
      operation: () => Promise<T>,
    ): Promise<T>;
  };
  lockHost.budgetLocks = new Map();

  const first = lockHost.withBudgetLock("principal", undefined, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const controller = new AbortController();
  const second = lockHost.withBudgetLock("principal", controller.signal, async () => {
    secondStarted = true;
  });
  controller.abort();
  releaseFirst.resolve();

  await first;
  await assert.rejects(waitFor(second), (error: Error) => error.name === "AbortError");
  assert.equal(secondStarted, false);
});

test("an aborted queued recall does not poison the principal budget lock", async () => {
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let secondStarted = false;
  let thirdStarted = false;
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const lockHost = service as unknown as {
    budgetLocks: Map<string, Promise<void>>;
    withBudgetLock<T>(
      principal: string,
      abortSignal: AbortSignal | undefined,
      operation: () => Promise<T>,
    ): Promise<T>;
  };
  lockHost.budgetLocks = new Map();

  const first = lockHost.withBudgetLock("principal", undefined, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const controller = new AbortController();
  const second = lockHost.withBudgetLock("principal", controller.signal, async () => {
    secondStarted = true;
  });
  const third = lockHost.withBudgetLock("principal", undefined, async () => {
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
