import assert from "node:assert/strict";
import test from "node:test";

import {
  RemnicClient,
  RemnicHttpError,
  RemnicRequestAbortedError,
  chunkObservePayload,
  isTransientNetworkError,
  type ObserveMessage,
} from "./client.js";
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

test("RemnicClient rejects invalid timeout overrides", async () => {
  const client = new RemnicClient(baseConfig());

  for (const timeoutMs of [0, -1, Number.NaN, 1.5]) {
    await assert.rejects(
      () => client.health({ timeoutMs }),
      /Request timeoutMs must be a positive integer/,
    );
  }
});

test("RemnicClient forwards caller aborts to MCP tool requests", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const controller = new AbortController();
  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 100 });
  const request = client.mcpTool("remnic.recall", {}, { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    () => request,
    (err) => {
      assert.ok(err instanceof RemnicRequestAbortedError);
      return true;
    },
  );
});

test("RemnicClient forwards caller aborts to observe requests", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const controller = new AbortController();
  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 100 });
  const request = client.observe("session", "/cwd", [{ role: "user", content: "observe" }], {
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(
    () => request,
    (err) => {
      assert.ok(err instanceof RemnicRequestAbortedError);
      return true;
    },
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
    recallTimeoutThreshold: 7,
    recallTimeoutWindow: 10,
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

test("RemnicHttpError carries the daemon's machine-readable error code (issue #2215)", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ ok: false, ready: false, warmupAttempts: 154, lastError: "StartupSyncPendingError", code: "not_ready" }),
      { status: 503, statusText: "Service Unavailable" },
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient(baseConfig());

  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.ok(err instanceof RemnicHttpError);
      assert.equal(err.status, 503);
      assert.equal(err.code, "not_ready");
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


test("truncateObserveMessage drops bulky rawContent and parts so the chunk fits (#1600, review cursor+codex)", () => {
  const config = baseConfig();
  // A live Pi observe message carries the full original payload in rawContent
  // and parsed parts — both dominate the serialized size.
  const huge: ObserveMessage = {
    role: "assistant",
    content: "small rendered text",
    rawContent: { big: "x".repeat(200000) },
    parts: [{ kind: "tool_result", payload: { output: "y".repeat(200000) } }],
  };
  const chunks = chunkObservePayload(config, "sess", "/cwd", [huge], 50000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].messages.length, 1);
  const out = chunks[0].messages[0];
  assert.match(out.content, /\[Remnic observe truncated/);
  assert.equal(out.rawContent, undefined, "rawContent must be dropped on truncation");
  assert.equal(out.parts, undefined, "parts must be dropped on truncation");
  const bytes = new TextEncoder().encode(JSON.stringify(chunks[0])).length;
  assert.ok(bytes <= 50000, `truncated chunk ${bytes} exceeds cap even after dropping raw fields`);
});

test("chunkObservePayload never overshoots the cap once array commas are counted (review cursor)", () => {
  const config = baseConfig();
  // Many small messages near the cap boundary exercise the comma accounting.
  const messages: ObserveMessage[] = Array.from({ length: 200 }, (_, i) => ({
    role: "user" as const,
    content: "m" + String(i).padStart(3, "0"),
  }));
  const chunks = chunkObservePayload(config, "sess", "/cwd", messages, 3000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const bytes = new TextEncoder().encode(JSON.stringify(chunk)).length;
    assert.ok(bytes <= 3000, `chunk ${bytes} bytes exceeds 3000 cap`);
  }
});

// ---------------------------------------------------------------------------
// Review (cursor + codex): retries must share one deadline; single-chunk
// observe must use the turn budget, not the 60s general budget (#1602/#1626).
// ---------------------------------------------------------------------------

test("requestWithRetry keeps retries within the shared per-turn budget instead of a fresh timeout per attempt (#1602/#1626, review cursor+codex)", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("The socket connection was closed unexpectedly.");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  // Budget (50ms) is smaller than the first exponential backoff (200ms), so a
  // retry would already be past the deadline. The old code retried with a fresh
  // full timeout each attempt; the new code aborts before the retry.
  const client = new RemnicClient({ ...baseConfig(), observeMaxRetries: 3 });
  await assert.rejects(
    () => client.recall("query", "sess", "/cwd", { timeoutMs: 50, maxRetries: 3 }),
    /exceeded the 50ms budget before retry/,
  );
  assert.equal(calls, 1, "the shared deadline stopped further retries instead of looping");
});

test("single-chunk observe is bounded by the turn budget, not the general request budget (#1626, review cursor)", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  // General budget 60s, turn budget 30ms. A single small message must time out
  // at the TURN budget (30ms), proving the single-chunk path no longer falls
  // back to the 60s general budget the way the multi-chunk path never did.
  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 60000, turnRequestTimeoutMs: 30 });
  await assert.rejects(
    () => client.observe("sess", "/cwd", [{ role: "user", content: "hi" }]),
    /Remnic request timed out after 30ms/,
  );
  assert.equal(calls, 1);
});

test("chunkObservePayload truncates oversize messages even when the per-message budget is tiny (review cursor)", () => {
  const config = baseConfig();
  // Tight cap chosen so the envelope overhead leaves a small-but-positive
  // per-message budget (<=1024). Previously this returned ONE untruncated
  // envelope and could overshoot the cap; now each message is truncated/packed.
  const huge: ObserveMessage = { role: "assistant", content: "a".repeat(50000) };
  const chunks = chunkObservePayload(config, "sess", "/cwd", [huge], 800);
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) {
    const bytes = new TextEncoder().encode(JSON.stringify(chunk)).length;
    assert.ok(bytes <= 800, `truncated chunk ${bytes} bytes exceeds 800 cap`);
  }
  assert.match(
    chunks[0].messages[0].content,
    /\[Remnic observe truncated/,
    "oversize message was truncated rather than passed through",
  );
});

test("requestWithRetry bails before the backoff sleep when the budget is smaller than the backoff (review cursor)", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("The socket connection was closed unexpectedly.");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new RemnicClient({ ...baseConfig(), observeMaxRetries: 3 });
  // Budget (50ms) is far below the first 200ms exponential backoff. The old
  // code slept the full 200ms before detecting the overshoot; the fix checks
  // before sleeping, so we bail in well under the backoff.
  const start = Date.now();
  await assert.rejects(
    () => client.recall("query", "sess", "/cwd", { timeoutMs: 50, maxRetries: 3 }),
    /exceeded the 50ms budget before retry/,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 150, `bailed before the 200ms backoff (elapsed ${elapsed}ms)`);
  assert.equal(calls, 1);
});

test("recall shares a per-turn deadline across retries even when the caller omits timeoutMs (review cursor)", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("The socket connection was closed unexpectedly.");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new RemnicClient({ ...baseConfig(), turnRequestTimeoutMs: 50, observeMaxRetries: 3 });
  await assert.rejects(
    () => client.recall("query", "sess", "/cwd"),
    /exceeded the 50ms budget before retry/,
  );
  assert.equal(calls, 1, "recall defaulted to the turn budget and stopped retries instead of looping unbounded");
});
