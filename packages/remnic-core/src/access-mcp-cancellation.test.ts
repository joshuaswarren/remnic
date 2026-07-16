import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { abortError } from "./abort-error.js";
import { EngramAccessHttpServer } from "./access-http.js";
import { EngramMcpServer } from "./access-mcp.js";
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

function mcpBody(name: string, query = "slow recall"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: { query } },
  });
}

function sendMcp(port: number, name: string): {
  client: ReturnType<typeof httpRequest>;
  response: Promise<string>;
} {
  const response = deferred<string>();
  const client = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => response.resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", response.reject);
  });
  client.on("error", (error) => response.reject(error));
  client.end(mcpBody(name));
  return { client, response: response.promise };
}

test("MCP recall aborts in-flight work without writing a JSON-RPC error after disconnect", async () => {
  const recallStarted = deferred<void>();
  const recallSettled = deferred<void>();
  const forceRelease = deferred<void>();
  let observedSignal: AbortSignal | undefined;
  let responseStarted = false;
  const service = {
    recall: async (input: EngramAccessRecallRequest) => {
      observedSignal = input.abortSignal;
      recallStarted.resolve();
      try {
        await Promise.race([
          forceRelease.promise,
          new Promise<void>((_resolve, reject) => {
            input.abortSignal?.addEventListener("abort", () => reject(input.abortSignal?.reason), { once: true });
          }),
        ]);
      } finally {
        recallSettled.resolve();
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
      path: "/mcp",
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
    }, (res) => {
      responseStarted = true;
      res.resume();
    });
    client.on("error", () => {});
    client.end(mcpBody("remnic.recall"));

    await waitFor(recallStarted.promise);
    assert.ok(observedSignal, "the HTTP request signal must reach the MCP recall service");
    client.destroy();

    await waitFor(recallSettled.promise);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason?.name, "AbortError");
    assert.equal(responseStarted, false, "a disconnected client must not receive a JSON-RPC error response");
  } finally {
    forceRelease.resolve();
    await server.stop();
  }
});

test("MCP recall_xray forwards the signal and preserves the original AbortError", async () => {
  const controller = new AbortController();
  const reason = abortError("caller disconnected");
  let observedSignal: AbortSignal | undefined;
  const service = {
    recallXray: async (input: { abortSignal?: AbortSignal }) => {
      observedSignal = input.abortSignal;
      controller.abort(reason);
      return { snapshotFound: false };
    },
  } as unknown as EngramAccessService;
  const mcp = new EngramMcpServer(service);

  await assert.rejects(
    mcp.handleRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "remnic.recall_xray", arguments: { query: "why" } },
      },
      { abortSignal: controller.signal },
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(observedSignal, controller.signal);
});

test("standalone MCP calls leave recall cancellation undefined", async () => {
  let observedSignal: AbortSignal | undefined;
  const service = {
    recall: async (input: EngramAccessRecallRequest) => {
      observedSignal = input.abortSignal;
      return {} as never;
    },
  } as unknown as EngramAccessService;
  const mcp = new EngramMcpServer(service);

  const response = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "remnic.recall", arguments: { query: "live" } },
  });

  assert.equal(observedSignal, undefined);
  assert.equal((response?.result as { isError?: boolean } | undefined)?.isError, false);
});

test("a disconnected MCP recall queued on the budget lock never starts and does not poison the lock", async () => {
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondQueued = deferred<void>();
  const secondAborted = deferred<void>();
  const secondSettled = deferred<void>();
  let secondStarted = false;
  let thirdStarted = false;
  let callCount = 0;

  const lockService = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const lockHost = lockService as unknown as {
    budgetLocks: Map<string, Promise<void>>;
    withBudgetLock<T>(
      principal: string,
      abortSignal: AbortSignal | undefined,
      operation: () => Promise<T>,
    ): Promise<T>;
  };
  lockHost.budgetLocks = new Map();

  const service = {
    recall: async (input: EngramAccessRecallRequest) => {
      callCount += 1;
      const call = callCount;
      if (call === 2) {
        input.abortSignal?.addEventListener("abort", () => secondAborted.resolve(), { once: true });
        secondQueued.resolve();
      }
      try {
        return await lockHost.withBudgetLock("principal", input.abortSignal, async () => {
          if (call === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          } else if (call === 2) {
            secondStarted = true;
          } else {
            thirdStarted = true;
          }
          return {} as never;
        });
      } finally {
        if (call === 2) secondSettled.resolve();
      }
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
    const first = sendMcp(status.port, "remnic.recall");
    await waitFor(firstStarted.promise);

    const second = sendMcp(status.port, "remnic.recall");
    second.response.catch(() => {});
    await waitFor(secondQueued.promise);
    second.client.destroy();
    await waitFor(secondAborted.promise);
    releaseFirst.resolve();

    await waitFor(first.response);
    await waitFor(secondSettled.promise);
    assert.equal(secondStarted, false);

    const third = sendMcp(status.port, "remnic.recall");
    await waitFor(third.response);
    assert.equal(thirdStarted, true);
  } finally {
    releaseFirst.resolve();
    await server.stop();
  }
});
