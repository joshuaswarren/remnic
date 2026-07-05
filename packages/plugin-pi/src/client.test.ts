import assert from "node:assert/strict";
import test from "node:test";

import { RemnicClient, RemnicHttpError, chunkObservePayload, isTransientNetworkError, type ObserveMessage } from "./client.js";
import type { RemnicPiConfig } from "./config.js";

test("RemnicClient reports request timeouts with actionable context", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 1 });

  await assert.rejects(
    () => client.health(),
    /Remnic request timed out after 1ms/,
  );
});

test("RemnicClient allows startup callers to use a shorter timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 60000 });

  await assert.rejects(
    () => client.health({ timeoutMs: 2 }),
    /Remnic request timed out after 2ms/,
  );
});

test("RemnicClient ignores a non-positive timeout override and uses the general budget", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 7 });

  // A 0/negative/NaN override would make setTimeout abort immediately; the client
  // must reject it and fall back to requestTimeoutMs (reported as 7ms here).
  await assert.rejects(
    () => client.health({ timeoutMs: 0 }),
    /Remnic request timed out after 7ms/,
  );
});

function baseConfig(): RemnicPiConfig {
  return {
    remnicDaemonUrl: "http://127.0.0.1:4318",
    recallMode: "auto",
    recallTopK: 8,
    recallBudgetChars: 12000,
    recallEnabled: true,
    observeEnabled: true,
    observeSkipExtraction: false,
    compactionEnabled: true,
    mcpToolsEnabled: true,
    statusEnabled: true,
    requestTimeoutMs: 60000,
    startupRequestTimeoutMs: 1000,
    turnRequestTimeoutMs: 20000,
    observeMaxBytes: 102400,
    observeMaxRetries: 2,
    daemonCooldownMs: 5000,
  };
}

test("RemnicClient preserves HTTP status for non-JSON daemon errors", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient(baseConfig());

  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.ok(err instanceof RemnicHttpError);
      assert.equal(err.status, 502);
      assert.match(err.message, /Bad Gateway/);
      return true;
    },
  );
});

test("RemnicClient preserves HTTP status for non-JSON internal server errors", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient(baseConfig());

  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.ok(err instanceof RemnicHttpError);
      assert.equal(err.status, 500);
      assert.match(err.message, /Internal Server Error/);
      return true;
    },
  );
});


test("RemnicClient reports invalid JSON clearly for successful daemon responses", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not-json", { status: 200, statusText: "OK" });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient(baseConfig());

  await assert.rejects(
    () => client.health(),
    /Invalid JSON response from Remnic daemon/,
  );
});


// ---------------------------------------------------------------------------
// Issue #1600: 413 on large turns — observe chunking & truncation
// ---------------------------------------------------------------------------

test("chunkObservePayload splits a batch that exceeds the byte cap", () => {
  const config = baseConfig();
  const messages: ObserveMessage[] = [
    { role: "assistant", content: "x".repeat(40000) },
    { role: "user", content: "y".repeat(40000) },
    { role: "user", content: "z".repeat(40000) },
  ];
  const chunks = chunkObservePayload(config, "sess", "/cwd", messages, 50000);
  assert.ok(chunks.length >= 2, `expected chunking, got ${chunks.length}`);
  for (const chunk of chunks) {
    const bytes = new TextEncoder().encode(JSON.stringify(chunk)).length;
    assert.ok(bytes <= 50000, `chunk ${bytes} bytes exceeds 50000 cap`);
  }
});

test("chunkObservePayload truncates a single oversized message instead of dropping it", () => {
  const config = baseConfig();
  const huge: ObserveMessage = { role: "assistant", content: "a".repeat(200000) };
  const chunks = chunkObservePayload(config, "sess", "/cwd", [huge], 50000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].messages.length, 1);
  assert.match(chunks[0].messages[0].content, /\[Remnic observe truncated/);
  const bytes = new TextEncoder().encode(JSON.stringify(chunks[0])).length;
  assert.ok(bytes <= 50000, `truncated chunk ${bytes} exceeds cap`);
});

test("observe chunks an oversize batch into multiple POSTs under the cap (#1600)", async (t) => {
  const originalFetch = globalThis.fetch;
  const bodyBytes: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    bodyBytes.push(new TextEncoder().encode(body).length);
    return new Response(JSON.stringify({ count: 1 }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new RemnicClient({ ...baseConfig(), observeMaxBytes: 50000 });
  const messages = Array.from({ length: 5 }, (_, i) => ({
    role: "user" as const,
    content: "x".repeat(20000) + String(i),
  }));
  const result = await client.observe("sess", "/cwd", messages);

  assert.ok(bodyBytes.length >= 2, `expected chunking into multiple POSTs, got ${bodyBytes.length}`);
  for (const b of bodyBytes) assert.ok(b <= 50000, `chunk ${b} exceeds cap`);
  assert.equal(result.count, bodyBytes.length);
});

test("observe 413 error message includes the body size for operator tuning (#1600)", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("request_body_too_large", { status: 413, statusText: "Request Entity Too Large" });
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new RemnicClient(baseConfig());
  await assert.rejects(
    () => client.observe("sess", "/cwd", [{ role: "user", content: "big" }]),
    (err: unknown) => {
      assert.ok(err instanceof RemnicHttpError, "expected RemnicHttpError");
      assert.equal((err as RemnicHttpError).status, 413);
      assert.match((err as RemnicHttpError).message, /observed body \d+ bytes/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Issue #1602: transient socket close — observe retries instead of dropping
// ---------------------------------------------------------------------------

test("isTransientNetworkError classifies connection-level failures", () => {
  assert.ok(isTransientNetworkError(new Error("The socket connection was closed unexpectedly.")));
  assert.ok(isTransientNetworkError(new Error("fetch failed: ECONNRESET")));
  assert.ok(isTransientNetworkError(new Error("write EPIPE")));
  assert.ok(!isTransientNetworkError(new RemnicHttpError(500, "boom")));
  assert.ok(!isTransientNetworkError(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
  assert.ok(!isTransientNetworkError(new Error("offline")));
  assert.ok(!isTransientNetworkError("string error"));
});

test("observe retries on transient socket close and succeeds (#1602)", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("The socket connection was closed unexpectedly. For more information, pass \`verbose: true\` in the second argument to fetch()");
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new RemnicClient({ ...baseConfig(), observeMaxRetries: 2 });
  const result = await client.observe("sess", "/cwd", [{ role: "user", content: "hello" }]);

  assert.equal(calls, 2, "first attempt failed transiently, second succeeded");
  assert.deepEqual(result, { ok: true });
});

test("observe does not retry on HTTP 500 (only transient connection errors)", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new RemnicClient({ ...baseConfig(), observeMaxRetries: 3 });
  await assert.rejects(() => client.observe("sess", "/cwd", [{ role: "user", content: "hi" }]));
  assert.equal(calls, 1, "HTTP errors are not retried");
});

test("observe gives up after exhausting the retry budget on repeated transient failures", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("The socket connection was closed unexpectedly.");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new RemnicClient({ ...baseConfig(), observeMaxRetries: 2 });
  await assert.rejects(
    () => client.observe("sess", "/cwd", [{ role: "user", content: "hi" }]),
    /socket connection was closed/,
  );
  assert.equal(calls, 3, "1 initial + 2 retries");
});

// ---------------------------------------------------------------------------
// Issue #1626: bounded per-turn timeout + daemon-reachability circuit breaker
// ---------------------------------------------------------------------------

test("recall honors a turn-scoped timeout override below the general budget (#1626)", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 60000 });
  await assert.rejects(
    () => client.recall("query", "sess", "/cwd", { timeoutMs: 40 }),
    /Remnic request timed out after 40ms/,
  );
});

test("circuit breaker reports unreachable during cooldown and recovers (#1626)", () => {
  const client = new RemnicClient(baseConfig());
  assert.ok(client.isReachable(), "fresh client is reachable");
  client.markUnreachable(5000);
  assert.ok(!client.isReachable(), "in cooldown after failure");
  client.markReachable();
  assert.ok(client.isReachable(), "reachable again after success");
});
