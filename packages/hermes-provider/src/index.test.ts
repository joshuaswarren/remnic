import assert from "node:assert/strict";
import test from "node:test";

import { HermesClient, HermesError } from "./index.js";

test("recall retries transient server errors according to client policy", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const idempotencyKeys: unknown[] = [];

  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      idempotencyKey?: unknown;
    };
    idempotencyKeys.push(body.idempotencyKey);
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "temporary failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        context: "remembered context",
        results: [{ id: "mem-1", content: "remembered context", score: 1 }],
        count: 1,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    const result = await client.recall("what matters?", {
      idempotencyKey: "recall-retry-test",
    });

    assert.equal(calls, 2);
    assert.equal(typeof idempotencyKeys[0], "string");
    assert.equal(idempotencyKeys[1], idempotencyKeys[0]);
    assert.equal(result.context, "remembered context");
    assert.equal(result.results?.[0]?.id, "mem-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recall remains single-attempt without an idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let sawIdempotencyKey = false;

  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      idempotencyKey?: unknown;
    };
    sawIdempotencyKey ||= body.idempotencyKey !== undefined;
    return new Response(JSON.stringify({ error: "temporary failure" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    await assert.rejects(
      () => client.recall("what matters?"),
      /HTTP 500/,
    );
    assert.equal(calls, 1);
    assert.equal(sawIdempotencyKey, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getMemory treats empty-body 404 responses as not found without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });

    const result = await client.getMemory("missing");

    assert.equal(calls, 1);
    assert.deepEqual(result, { found: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getEntity treats empty-body 404 responses as not found without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });

    const result = await client.getEntity("missing");

    assert.equal(calls, 1);
    assert.deepEqual(result, { found: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("store rejects final 429 immediately without sleeping for Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "rate limited", code: "rate_limited" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "60",
      },
    });
  }) as typeof fetch;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });

    const startedAt = Date.now();
    await assert.rejects(
      () => client.store({ content: "x" }),
      (err: unknown) => (
        err instanceof HermesError &&
        err.status === 429 &&
        err.code === "rate_limited" &&
        err.message === "rate limited"
      ),
    );

    assert.equal(calls, 1);
    assert.ok(Date.now() - startedAt < 500, "final 429 should not wait for Retry-After");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recall ignores malformed Retry-After numeric prefixes", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let calls = 0;
  const observedTimeouts: number[] = [];

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "rate limited", code: "rate_limited" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "60 seconds",
        },
      });
    }
    return new Response(
      JSON.stringify({
        context: "remembered context",
        results: [],
        count: 0,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const delay = Number(timeout ?? 0);
    observedTimeouts.push(delay);
    if (delay === 1000) {
      return originalSetTimeout(handler, 10_000, ...args);
    }
    if (typeof handler === "function") {
      handler(...args);
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 1,
      retryBaseDelayMs: 7,
      timeoutMs: 1000,
    });

    const result = await client.recall("what matters?", {
      idempotencyKey: "retry-after-prefix-test",
    });

    assert.equal(calls, 2);
    assert.equal(result.context, "remembered context");
    assert.ok(observedTimeouts.includes(28), "malformed retry-after should use bounded default backoff");
    assert.equal(observedTimeouts.includes(60_000), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("store retries transient server errors when an idempotency key is supplied", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const idempotencyKeys: unknown[] = [];

  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      idempotencyKey?: unknown;
    };
    idempotencyKeys.push(body.idempotencyKey);
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "temporary failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        memoryId: "mem-1",
        status: "stored",
        idempotencyKey: "store-retry-test",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    const result = await client.store({
      content: "x",
      idempotencyKey: "store-retry-test",
    });

    assert.equal(calls, 2);
    assert.deepEqual(idempotencyKeys, ["store-retry-test", "store-retry-test"]);
    assert.equal(result.memoryId, "mem-1");
    assert.equal(result.status, "stored");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-JSON client errors preserve HTTP status and are not retried", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("not json", { status: 403, statusText: "Forbidden" });
  }) as typeof fetch;

  try {
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:4318",
      authToken: "test-token",
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });

    await assert.rejects(
      () => client.getMemories(),
      (err: unknown) => (
        err instanceof HermesError
        && err.status === 403
        && err.code === "http_403"
        && err.message === "Forbidden"
      ),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
