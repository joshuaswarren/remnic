import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConnectorApiError,
  describeNetworkError,
  discardResponseBody,
  retryAfterHeaderMs,
  retryingFetch,
  stripTrailingSlashes,
} from "./http-retry.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function scriptFetch(script: Array<() => Response | Promise<Response>>): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  return {
    fetchImpl: (async () => {
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      return step();
    }) as typeof fetch,
    calls: () => calls,
  };
}

test("retries 5xx with exponential backoff, then returns the success response", async () => {
  const sleeps: number[] = [];
  const { fetchImpl, calls } = scriptFetch([
    () => jsonResponse({}, 502),
    () => jsonResponse({}, 503),
    () => jsonResponse({ ok: true }),
  ]);
  const response = await retryingFetch("https://api.example.invalid/v1", {
    init: { method: "GET" },
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    networkError: () => new ConnectorApiError("network"),
    retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls(), 3);
  assert.deepEqual(sleeps, [1_000, 2_000]);
});

test("exhausted retries on 5xx throw the vendor retryable error", async () => {
  const sleeps: number[] = [];
  const { fetchImpl, calls } = scriptFetch([() => jsonResponse({}, 503)]);
  await assert.rejects(
    retryingFetch("https://api.example.invalid", {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      networkError: () => new ConnectorApiError("network"),
      retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
    }),
    (err: unknown) => err instanceof ConnectorApiError && err.status === 503,
  );
  assert.equal(calls(), 4);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000]);
});

test("exhausted network failures call networkError with attempt count and timeout flag", async () => {
  const pathy = new Error("connect ECONNREFUSED /home/user/.cache/loader.js");
  (pathy as NodeJS.ErrnoException).code = "ECONNREFUSED";
  const { fetchImpl } = scriptFetch([
    () => Promise.reject(pathy),
  ]);
  let seen: { attempts: number; timedOut: boolean } | undefined;
  await assert.rejects(
    retryingFetch("https://api.example.invalid", {
      fetchImpl,
      sleep: async () => {},
      networkError: (err, attempts, context) => {
        seen = { attempts, ...context };
        return new ConnectorApiError(`failed after ${attempts}: ${describeNetworkError(err)}`);
      },
      retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
    }),
    (err: unknown) =>
      err instanceof ConnectorApiError && err.message === "failed after 4: Error (ECONNREFUSED)",
  );
  assert.deepEqual(seen, { attempts: 4, timedOut: false });
});

test("a caller abort mid-flight rethrows the raw error without retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { promise, reject } = Promise.withResolvers<never>();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("This operation was aborted", "AbortError")),
    );
    return promise;
  }) as typeof fetch;
  const pending = retryingFetch("https://api.example.invalid", {
    fetchImpl,
    signal: controller.signal,
    sleep: async () => {
      throw new Error("must not sleep after a caller abort");
    },
    networkError: () => new ConnectorApiError("network"),
    retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
  });
  const finished = assert.rejects(
    pending,
    (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  );
  controller.abort();
  await finished;
  assert.equal(calls, 1);
});

test("Retry-After seconds and HTTP-date override the exponential backoff, capped", async () => {
  const sleeps: number[] = [];
  const options = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    networkError: () => new ConnectorApiError("network"),
    retryableError: (r: Response) => new ConnectorApiError(`responded ${r.status}`, r.status),
  };
  {
    const { fetchImpl } = scriptFetch([
      () => jsonResponse({}, 429, { "retry-after": "7" }),
      () => jsonResponse([]),
    ]);
    await retryingFetch("https://api.example.invalid", { fetchImpl, ...options });
    assert.deepEqual(sleeps, [7_000]);
  }
  {
    sleeps.length = 0;
    const { fetchImpl } = scriptFetch([
      () => jsonResponse({}, 429, { "retry-after": "120" }),
      () => jsonResponse([]),
    ]);
    await retryingFetch("https://api.example.invalid", { fetchImpl, ...options });
    assert.deepEqual(sleeps, [30_000], "hostile Retry-After is capped at maxRetryDelayMs");
  }
  {
    sleeps.length = 0;
    const soon = new Date(Date.now() + 3_000).toUTCString();
    const { fetchImpl } = scriptFetch([
      () => jsonResponse({}, 429, { "retry-after": soon }),
      () => jsonResponse([]),
    ]);
    await retryingFetch("https://api.example.invalid", { fetchImpl, ...options });
    assert.ok(sleeps[0] !== undefined && sleeps[0] > 2_000 && sleeps[0] <= 3_000, `HTTP-date delay, got ${sleeps[0]}`);
  }
});

test("a vendor retryAfterMs override wins over the header; null falls back", async () => {
  const sleeps: number[] = [];
  const { fetchImpl } = scriptFetch([
    () => jsonResponse({ retryAfter: "2" }, 429),
    () => jsonResponse([]),
  ]);
  await retryingFetch("https://api.example.invalid", {
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retryAfterMs: async (response) => {
      const body = (await response.clone().json()) as { retryAfter?: unknown };
      const parsed = Number(body?.retryAfter);
      return Number.isFinite(parsed) && parsed > 0 ? parsed * 1_000 : null;
    },
    networkError: () => new ConnectorApiError("network"),
    retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
  });
  assert.deepEqual(sleeps, [2_000]);
});

test("non-retryable statuses are returned to the caller untouched", async () => {
  const { fetchImpl, calls } = scriptFetch([() => jsonResponse({ error: "nope" }, 404)]);
  const response = await retryingFetch("https://api.example.invalid", {
    fetchImpl,
    sleep: async () => {},
    networkError: () => new ConnectorApiError("network"),
    retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
  });
  assert.equal(response.status, 404);
  assert.equal(calls(), 1);
});

test("buildInit runs once; retries reuse the same init", async () => {
  const tokens: string[] = [];
  const { fetchImpl } = scriptFetch([
    () => jsonResponse({}, 429),
    () => jsonResponse([]),
  ]);
  const seenAuth: (string | null)[] = [];
  const fetchSpy = (async (url: string | URL | Request, init?: RequestInit) => {
    seenAuth.push(new Headers(init?.headers).get("authorization"));
    return fetchImpl(url, init);
  }) as typeof fetch;
  await retryingFetch("https://api.example.invalid", {
    fetchImpl: fetchSpy,
    sleep: async () => {},
    buildInit: async () => {
      const token = `tok-${tokens.length}`;
      tokens.push(token);
      return {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: "{}",
      };
    },
    networkError: () => new ConnectorApiError("network"),
    retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
  });
  assert.deepEqual(seenAuth, ["Bearer tok-0", "Bearer tok-0"]);
  assert.equal(tokens.length, 1);
});

test("buildInit failures run once, propagate unwrapped, and never fetch", async () => {
  const failure = new ConnectorApiError("grant revoked: re-authorize");
  let builds = 0;
  const { fetchImpl, calls } = scriptFetch([]);
  await assert.rejects(
    retryingFetch("https://api.example.invalid", {
      fetchImpl,
      sleep: async () => {},
      buildInit: async () => {
        builds += 1;
        throw failure;
      },
      networkError: (err, attempts) =>
        new ConnectorApiError(`network after ${attempts}: ${String(err)}`),
      retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
    }),
    (err: unknown) => err === failure,
  );
  assert.equal(builds, 1);
  assert.equal(calls(), 0);
});

test("backoffBaseMs, maxRetries, and maxRetryDelayMs are honored", async () => {
  const sleeps: number[] = [];
  const { fetchImpl } = scriptFetch([() => jsonResponse({}, 500)]);
  await assert.rejects(
    retryingFetch("https://api.example.invalid", {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 2,
      backoffBaseMs: 500,
      maxRetryDelayMs: 8_000,
      networkError: () => new ConnectorApiError("network"),
      retryableError: (r) => new ConnectorApiError(`responded ${r.status}`, r.status),
    }),
    ConnectorApiError,
  );
  assert.deepEqual(sleeps, [500, 1_000]);
});

test("retryAfterHeaderMs parses seconds and rejects garbage", () => {
  assert.equal(retryAfterHeaderMs(jsonResponse({}, 429, { "retry-after": "1.5" }), 30_000), 1_500);
  assert.equal(retryAfterHeaderMs(jsonResponse({}, 429, { "retry-after": "" }), 30_000), undefined);
  assert.equal(retryAfterHeaderMs(jsonResponse({}, 429, { "retry-after": "soon" }), 30_000), undefined);
  assert.equal(retryAfterHeaderMs(jsonResponse({}, 429), 30_000), undefined);
});

test("stripTrailingSlashes and discardResponseBody behave as documented", async () => {
  assert.equal(stripTrailingSlashes("https://api.example.invalid///"), "https://api.example.invalid");
  assert.equal(stripTrailingSlashes("/"), "");
  const response = jsonResponse({ b: 1 }, 429);
  discardResponseBody(response);
  await response.body?.cancel();
});
