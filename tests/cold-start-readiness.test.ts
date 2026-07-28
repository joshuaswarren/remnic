import assert from "node:assert/strict";
import test from "node:test";

import { type EngramAccessService, EngramAccessHttpServer } from "@remnic/core";
import { RemoteSearchBackend } from "@remnic/core/search/remote-backend";
import {
  completeStartupReadiness,
  parseServerConfig,
  runStartupSearchWarmup,
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
    degraded: false,
  });
});

test("persistent warm-up failure keeps health at 503 and reports rising attempt state", async () => {
  // degradedAfterAttempts: 0 pins the strict gate so this test's contract
  // (health stays 503 forever) survives the degraded-mode default (issue #2215).
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
    degradedAfterAttempts: 0,
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

test("persistent warm-up failure opens the gate in degraded mode and health answers 200 with degraded info (issue #2215)", async () => {
  const readiness = { ready: false, warmupAttempts: 0, degraded: false };
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
  const gateOpened = Promise.withResolvers<void>();

  const readinessTask = completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => {
      throw new TypeError("search backend unavailable");
    },
    timeoutMs: 100,
    retryIntervalMs: 5,
    degradedAfterAttempts: 2,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
      gateOpened.resolve();
    },
    shutdownSignal: shutdown.signal,
  });

  try {
    await gateOpened.promise;
    assert.equal(readiness.degraded, true);
    assert.ok(readiness.warmupAttempts >= 2);

    const response = await fetchHealth(status.port, "Bearer test-token");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      ok: boolean;
      degraded?: boolean;
      warmupAttempts?: number;
      lastError?: string | null;
    };
    assert.equal(body.ok, true);
    assert.equal(body.degraded, true);
    assert.ok((body.warmupAttempts ?? 0) >= 2);
    assert.equal(body.lastError, "TypeError");

    // The unauthenticated 503 short-circuit no longer fires once degraded.
    assert.equal((await fetchHealth(status.port)).status, 401);
  } finally {
    shutdown.abort();
    assert.equal(await readinessTask, "cancelled");
    await server.stop();
  }
});

test("a warm-up success after degraded mode clears the degraded flag", async () => {
  const readiness = { ready: false, warmupAttempts: 0, degraded: false };
  let gateOpens = 0;

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => {
      if (readiness.warmupAttempts < 3) throw new Error("still cold");
    },
    timeoutMs: 100,
    retryIntervalMs: 1,
    degradedAfterAttempts: 1,
    state: readiness,
    openGate: () => {
      gateOpens += 1;
      readiness.ready = true;
    },
  });

  assert.equal(outcome, "warmed");
  assert.deepEqual(readiness, {
    ready: true,
    warmupAttempts: 3,
    lastError: null,
    degraded: false,
  });
  // Opened once for the degraded transition, again on recovery — idempotent.
  assert.ok(gateOpens >= 2);
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

test("a fail-open degraded search result stays cold and retries", async () => {
  const readiness = { ready: false, warmupAttempts: 0 };
  let searches = 0;

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async (signal) =>
      runStartupSearchWarmup({
        signal,
        isAvailable: () => true,
        search: async (onDegradation) => {
          searches += 1;
          if (searches === 1) onDegradation("daemon_loading");
          return [];
        },
      }),
    timeoutMs: 100,
    retryIntervalMs: 1,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
    },
  });

  assert.equal(outcome, "warmed");
  assert.equal(searches, 2);
  assert.equal(readiness.warmupAttempts, 2);
  assert.equal(readiness.ready, true);
});

test("readiness waits for startup sync before running the warm-up", async () => {
  const readiness = { ready: false, warmupAttempts: 0 };
  let syncChecks = 0;
  let warmupCalls = 0;

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.resolve(),
    prepareWarmup: async () => {
      syncChecks += 1;
      return syncChecks >= 3;
    },
    warmup: async () => {
      warmupCalls += 1;
    },
    timeoutMs: 100,
    retryIntervalMs: 1,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
    },
  });

  assert.equal(outcome, "warmed");
  assert.equal(syncChecks, 3);
  assert.equal(warmupCalls, 1);
  assert.equal(readiness.ready, true);
});

test("remote search failures report degradation instead of a healthy empty result", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) =>
    String(input).endsWith("/health")
      ? new Response(null, { status: 200 })
      : new Response(null, { status: 503 });

  const backend = new RemoteSearchBackend({
    baseUrl: "http://127.0.0.1:1",
    timeoutMs: 100,
  });
  assert.equal(await backend.probe(), true);
  const degradations: Array<{ backend: string; code: string }> = [];

  const results = await backend.search("warm-up", undefined, 1, undefined, {
    onDegradation: (degradation) => degradations.push(degradation),
  });

  assert.deepEqual(results, []);
  assert.deepEqual(degradations, [{
    backend: "remote",
    code: "remote_error",
    detail: "HTTP 503",
  }]);
});

test("intentionally disabled search opens readiness without a warm-up", async () => {
  const readiness = { ready: false, warmupAttempts: 0 };
  let warmupCalls = 0;

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.withResolvers<void>().promise,
    warmup: async () => {
      warmupCalls += 1;
    },
    skipWarmup: () => true,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
    },
  });

  assert.equal(outcome, "search-disabled");
  assert.equal(warmupCalls, 0);
  assert.deepEqual(readiness, {
    ready: true,
    warmupAttempts: 0,
    lastError: null,
    degraded: false,
  });
});

test("a backend that becomes no-op during sync opens readiness on the next retry", async () => {
  const readiness = { ready: false, warmupAttempts: 0 };
  let searchDisabled = false;
  let syncCalls = 0;
  let warmupCalls = 0;

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.resolve(),
    prepareWarmup: async () => {
      syncCalls += 1;
      searchDisabled = true;
      return syncCalls >= 2;
    },
    warmup: async () => {
      warmupCalls += 1;
    },
    skipWarmup: () => searchDisabled,
    retryIntervalMs: 1,
    state: readiness,
    openGate: () => {
      readiness.ready = true;
    },
  });

  assert.equal(outcome, "search-disabled");
  assert.equal(warmupCalls, 0);
  assert.equal(readiness.ready, true);
});

test("shutdown cancels readiness while deferred initialization is pending", async () => {
  const shutdown = new AbortController();
  const pendingInit = Promise.withResolvers<void>();
  let gateOpenCount = 0;
  const readinessTask = completeStartupReadiness({
    deferredReady: pendingInit.promise,
    warmup: async () => undefined,
    state: { ready: false, warmupAttempts: 0 },
    openGate: () => {
      gateOpenCount += 1;
    },
    shutdownSignal: shutdown.signal,
  });

  shutdown.abort();

  assert.equal(await readinessTask, "cancelled");
  assert.equal(gateOpenCount, 0);
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
    degraded: false,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /emergency readiness override.*cold search backend.*traffic/i);
});

test("server config accepts the emergency readiness override", () => {
  assert.equal(parseServerConfig({ readinessOverride: true }).readinessOverride, true);
});

test("server config parses the degraded-readiness attempts knob (issue #2215)", () => {
  assert.equal(parseServerConfig({}).readinessDegradedAfterAttempts, 3);
  assert.equal(parseServerConfig({ readinessDegradedAfterAttempts: 0 }).readinessDegradedAfterAttempts, 0);
  assert.equal(parseServerConfig({ readinessDegradedAfterAttempts: "5" }).readinessDegradedAfterAttempts, 5);
  assert.throws(() => parseServerConfig({ readinessDegradedAfterAttempts: -1 }));
  assert.throws(() => parseServerConfig({ readinessDegradedAfterAttempts: "many" }));
  // Blank strings must be rejected, not coerced to 0 (= strict gate) by Number("").
  assert.throws(() => parseServerConfig({ readinessDegradedAfterAttempts: "" }));
  assert.throws(() => parseServerConfig({ readinessDegradedAfterAttempts: "  " }));
});
