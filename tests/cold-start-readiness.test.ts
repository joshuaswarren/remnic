import assert from "node:assert/strict";
import test from "node:test";

import { type EngramAccessService, EngramAccessHttpServer } from "@remnic/core";
import { completeStartupReadiness } from "../packages/remnic-server/src/index.js";

async function fetchHealth(port: number, authorization?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/engram/v1/health`, {
    headers: authorization ? { authorization } : undefined,
  });
}

test("health stays at 503 until the startup warm-up completes, then resumes auth responses", async () => {
  const warmup = Promise.withResolvers<void>();
  let ready = false;
  const service = {
    health: async () => ({ ok: true }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    isReady: () => ready,
  });
  const status = await server.start();

  const readinessTask = completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => warmup.promise,
    timeoutMs: 1_000,
    openGate: () => {
      ready = true;
    },
  });

  try {
    const coldResponse = await fetchHealth(status.port);
    assert.equal(coldResponse.status, 503);
    assert.deepEqual(await coldResponse.json(), {
      ok: false,
      ready: false,
      code: "not_ready",
    });

    warmup.resolve();
    await readinessTask;

    assert.equal((await fetchHealth(status.port)).status, 401);
    assert.equal(
      (await fetchHealth(status.port, "Bearer test-token")).status,
      200,
    );
  } finally {
    warmup.resolve();
    await readinessTask;
    await server.stop();
  }
});

test("warm-up failure opens the readiness gate and logs the failure", async () => {
  let gateOpenCount = 0;
  const warnings: string[] = [];

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => {
      throw new Error("search backend unavailable");
    },
    timeoutMs: 1_000,
    openGate: () => {
      gateOpenCount += 1;
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(outcome, "failed-open");
  assert.equal(gateOpenCount, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /warm-up failed.*search backend unavailable/i);
});

test("warm-up timeout aborts the query, opens the gate, and logs the timeout", async () => {
  let receivedSignal: AbortSignal | undefined;
  let gateOpenCount = 0;
  const warnings: string[] = [];

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async (signal) => {
      receivedSignal = signal;
      return Promise.withResolvers<void>().promise;
    },
    timeoutMs: 10,
    openGate: () => {
      gateOpenCount += 1;
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(outcome, "failed-open");
  assert.equal(gateOpenCount, 1);
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /warm-up timed out after 10ms/i);
});
