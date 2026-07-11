import assert from "node:assert/strict";
import test from "node:test";

import { type EngramAccessService, EngramAccessHttpServer } from "@remnic/core";
import {
  completeStartupReadiness,
  parseServerConfig,
} from "../packages/remnic-server/src/index.js";

async function fetchHealth(port: number, authorization?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/engram/v1/health`, {
    headers: authorization ? { authorization } : undefined,
  });
}

test("health stays at 503 until the startup warm-up completes, then resumes auth responses", async () => {
  const warmup = Promise.withResolvers<void>();
  const readiness = { ready: false, warmupAttempts: 0 };
  const service = {
    health: async () => ({ ok: true }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    readiness: () => readiness,
  });
  const status = await server.start();
  const shutdown = new AbortController();
  const readinessTask = completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => warmup.promise,
    timeoutMs: 1_000,
    retryIntervalMs: 10,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
    },
    shutdownSignal: shutdown.signal,
  });

  try {
    const coldResponse = await fetchHealth(status.port);
    assert.equal(coldResponse.status, 503);
    assert.deepEqual(await coldResponse.json(), {
      ok: false,
      ready: false,
      warmupAttempts: 1,
      lastError: null,
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
    shutdown.abort();
    await readinessTask;
    await server.stop();
  }
});

test("a successful retry opens readiness on attempt N", async () => {
  const readiness = { ready: false, warmupAttempts: 0 };
  let calls = 0;
  const outcome = await completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("search backend unavailable");
    },
    timeoutMs: 100,
    retryIntervalMs: 1,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
    },
  });

  assert.equal(outcome, "warmed");
  assert.deepEqual(readiness, {
    ready: true,
    warmupAttempts: 3,
    lastError: null,
  });
});

test("persistent warm-up failure keeps health at 503 and reports rising attempt state", async () => {
  const readiness = { ready: false, warmupAttempts: 0 };
  const shutdown = new AbortController();
  const service = {
    health: async () => ({ ok: true }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    readiness: () => readiness,
  });
  const status = await server.start();
  const twoAttempts = Promise.withResolvers<void>();

  const readinessTask = completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => {
      if (readiness.warmupAttempts >= 2) twoAttempts.resolve();
      throw new TypeError("bad search path");
    },
    timeoutMs: 100,
    retryIntervalMs: 5,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
    },
    shutdownSignal: shutdown.signal,
  });

  try {
    await twoAttempts.promise;
    const response = await fetchHealth(status.port);
    assert.equal(response.status, 503);
    const body = await response.json() as {
      ready: boolean;
      warmupAttempts: number;
      lastError: string;
    };
    assert.equal(body.ready, false);
    assert.ok(body.warmupAttempts >= 2);
    assert.equal(body.lastError, "TypeError");
  } finally {
    shutdown.abort();
    assert.equal(await readinessTask, "cancelled");
    await server.stop();
  }
});

test("shutdown during retry delay never opens readiness", async () => {
  const readiness = { ready: false, warmupAttempts: 0 };
  const shutdown = new AbortController();
  let gateOpenCount = 0;
  const firstFailure = Promise.withResolvers<void>();

  const readinessTask = completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => {
      firstFailure.resolve();
      throw new Error("still cold");
    },
    timeoutMs: 100,
    retryIntervalMs: 1_000,
    state: readiness,
    openGate: () => {
      gateOpenCount += 1;
    },
    shutdownSignal: shutdown.signal,
  });

  await firstFailure.promise;
  shutdown.abort();

  assert.equal(await readinessTask, "cancelled");
  assert.equal(gateOpenCount, 0);
  assert.equal(readiness.ready, false);
});

test("the emergency override opens readiness at once and logs the exposure", async () => {
  const readiness = { ready: false, warmupAttempts: 0 };
  const errors: string[] = [];
  let warmupCalls = 0;

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.withResolvers<void>().promise,
    warmup: async () => {
      warmupCalls += 1;
    },
    override: true,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
    },
    error: (message) => errors.push(message),
  });

  assert.equal(outcome, "overridden");
  assert.equal(warmupCalls, 0);
  assert.deepEqual(readiness, {
    ready: true,
    warmupAttempts: 0,
    lastError: null,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /emergency readiness override.*cold search backend.*traffic/i);
});

test("server config accepts the emergency readiness override", () => {
  assert.equal(parseServerConfig({ readinessOverride: true }).readinessOverride, true);
});
