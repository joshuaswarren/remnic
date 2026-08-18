import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REITTI_AUTH_MODES,
  ReittiApiError,
  ReittiClient,
  assertValidIanaTimezone,
  normalizeReittiBaseUrl,
} from "./client.js";

const TOKEN = "rtt_secret_token_9f1c";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

type CapturedRequest = { url: string; headers: Headers };

function capturingFetch(
  handler: (request: CapturedRequest, call: number) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(url), headers: new Headers(init?.headers) };
    requests.push(request);
    return handler(request, requests.length);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const noSleep = async () => {};

function baseOptions(overrides: Partial<ConstructorParameters<typeof ReittiClient>[0]> = {}) {
  return { baseUrl: "https://reitti.example.invalid", token: TOKEN, sleep: noSleep, ...overrides };
}

test("constructor rejects a missing or blank token", () => {
  assert.throws(() => new ReittiClient(baseOptions({ token: "" })), TypeError);
  assert.throws(() => new ReittiClient(baseOptions({ token: "   " })), TypeError);
});

test("baseUrl must be an absolute http(s) URL; trailing slashes strip without changing the path", () => {
  assert.throws(() => normalizeReittiBaseUrl("not a url"), RangeError);
  assert.throws(() => normalizeReittiBaseUrl("ftp://host/"), RangeError);
  assert.equal(normalizeReittiBaseUrl("https://host/"), "https://host");
  assert.equal(normalizeReittiBaseUrl("https://host/reitti/"), "https://host/reitti");
  assert.equal(normalizeReittiBaseUrl("https://host:8443/reitti///"), "https://host:8443/reitti");
});

test("default auth mode sends exactly X-API-Token; bearer sends exactly Authorization", async () => {
  const tokenAuth = capturingFetch(() => jsonResponse([]));
  await new ReittiClient(baseOptions({ fetchImpl: tokenAuth.fetchImpl })).fetchTimeline({
    date: "2026-08-17",
    timezone: "UTC",
  });
  assert.equal(tokenAuth.requests[0]?.headers.get("x-api-token"), TOKEN);
  assert.equal(tokenAuth.requests[0]?.headers.get("authorization"), null);

  const bearerAuth = capturingFetch(() => jsonResponse([]));
  await new ReittiClient(
    baseOptions({ authMode: "bearer", fetchImpl: bearerAuth.fetchImpl }),
  ).fetchTimeline({ date: "2026-08-17", timezone: "UTC" });
  assert.equal(bearerAuth.requests[0]?.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(bearerAuth.requests[0]?.headers.get("x-api-token"), null);
});

test("an unknown auth mode is rejected against the allow-list", () => {
  assert.throws(
    () => new ReittiClient(baseOptions({ authMode: "both" as never })),
    (err: unknown) => err instanceof RangeError && err.message.includes(REITTI_AUTH_MODES.join(", ")),
  );
});

test("fetchTimeline forwards date and IANA timezone in the query", async () => {
  const { fetchImpl, requests } = capturingFetch(() => jsonResponse([]));
  await new ReittiClient(baseOptions({ fetchImpl })).fetchTimeline({
    date: "2026-08-17",
    timezone: "Europe/Berlin",
  });
  assert.match(requests[0]?.url ?? "", /\/api\/v1\/timeline\?date=2026-08-17&timezone=Europe%2FBerlin$/);
});

test("fetchTimeline validates the date and timezone before any request", async () => {
  const { fetchImpl, requests } = capturingFetch(() => jsonResponse([]));
  const client = new ReittiClient(baseOptions({ fetchImpl }));
  await assert.rejects(client.fetchTimeline({ date: "2026-13-40", timezone: "UTC" }), RangeError);
  await assert.rejects(client.fetchTimeline({ date: "2026-08-17", timezone: "Not/AZone" }), RangeError);
  assert.equal(requests.length, 0);
  assert.throws(() => assertValidIanaTimezone("Also/Bogus"), RangeError);
});

const visitRow = (overrides: Record<string, unknown> = {}) => ({
  id: "tl-1",
  resourceId: 11,
  type: "VISIT",
  place: { id: 7, name: "Home", address: null, city: null, type: "HOME" },
  path: "encoded-polyline-ignore",
  startTime: "2026-08-17T08:00:00Z",
  endTime: "2026-08-17T09:00:00Z",
  formattedDuration: "1h",
  distanceMeters: null,
  transportMode: null,
  editable: false,
  ...overrides,
});

test("a valid timeline payload parses into validated entries", async () => {
  const { fetchImpl } = capturingFetch(() => jsonResponse([visitRow()]));
  const entries = await new ReittiClient(baseOptions({ fetchImpl })).fetchTimeline({
    date: "2026-08-17",
    timezone: "UTC",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, "VISIT");
  assert.equal(entries[0]?.place?.name, "Home");
});

test("an empty timeline array is a valid empty result, not an error", async () => {
  const { fetchImpl } = capturingFetch(() => jsonResponse([]));
  const entries = await new ReittiClient(baseOptions({ fetchImpl })).fetchTimeline({
    date: "2026-08-17",
    timezone: "UTC",
  });
  assert.deepEqual(entries, []);
});

test("malformed timeline payloads fail with a typed schema error", async () => {
  const cases: Array<[string, unknown]> = [
    ["non-array body", { entries: [] }],
    ["row is not an object", ["nope"]],
    ["missing id", [{ type: "VISIT", startTime: "2026-08-17T08:00:00Z", endTime: "2026-08-17T09:00:00Z" }]],
    ["bad type enum", [visitRow({ type: "STOP" })]],
    ["bad transport mode enum", [visitRow({ type: "TRIP", transportMode: "TELEPORT" })]],
    ["bad place type enum", [visitRow({ place: { id: 1, name: "X", type: "CASTLE" } })]],
    ["non-ISO startTime", [visitRow({ startTime: "yesterday" })]],
    ["negative distance", [visitRow({ distanceMeters: -5 })]],
    ["place is a string", [visitRow({ place: "home" })]],
  ];
  for (const [name, body] of cases) {
    const { fetchImpl } = capturingFetch(() => jsonResponse(body));
    const client = new ReittiClient(baseOptions({ fetchImpl }));
    await assert.rejects(
      client.fetchTimeline({ date: "2026-08-17", timezone: "UTC" }),
      (err: unknown) => err instanceof ReittiApiError && err.kind === "schema",
      `case "${name}" must reject with kind schema`,
    );
  }
});

test("fetchVisits parses place summaries and validates the shape", async () => {
  const payload = {
    places: [
      {
        placeInfo: { id: 7, name: "Home", address: null, city: "Berlin", type: "HOME" },
        visits: [{ id: 99, startTime: "2026-08-17T08:00:00Z", endTime: "2026-08-17T09:00:00Z", durationSeconds: 3600 }],
        totalDurationMs: 3_600_000,
        visitCount: 1,
        color: "#3388ff",
      },
    ],
  };
  const { fetchImpl, requests } = capturingFetch(() => jsonResponse(payload));
  const summaries = await new ReittiClient(baseOptions({ fetchImpl })).fetchVisits({
    date: "2026-08-17",
    timezone: "UTC",
  });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.visits.length, 1);
  assert.match(requests[0]?.url ?? "", /\/api\/v1\/visits\?date=2026-08-17&timezone=UTC$/);

  const broken = capturingFetch(() => jsonResponse({ places: "yes" }));
  await assert.rejects(
    new ReittiClient(baseOptions({ fetchImpl: broken.fetchImpl })).fetchVisits({ date: "2026-08-17", timezone: "UTC" }),
    (err: unknown) => err instanceof ReittiApiError && err.kind === "schema",
  );
});

test("401 and 403 map to a non-retryable auth error and are fetched exactly once", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl, requests } = capturingFetch(() => jsonResponse({ error: "denied" }, status));
    const client = new ReittiClient(baseOptions({ fetchImpl, sleep: noSleep }));
    await assert.rejects(
      client.fetchTimeline({ date: "2026-08-17", timezone: "UTC" }),
      (err: unknown) => err instanceof ReittiApiError && err.kind === "auth" && err.status === status,
    );
    assert.equal(requests.length, 1, `status ${status} must not be retried`);
  }
});

test("429 retries with the injected sleep, then surfaces a rate-limit error with the status", async () => {
  const { fetchImpl, requests } = capturingFetch(() => jsonResponse({}, 429));
  const sleeps: number[] = [];
  const client = new ReittiClient({
    ...baseOptions({ fetchImpl }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(
    client.fetchTimeline({ date: "2026-08-17", timezone: "UTC" }),
    (err: unknown) => err instanceof ReittiApiError && err.kind === "rate-limit" && err.status === 429,
  );
  assert.equal(requests.length, 4);
  assert.equal(sleeps.length, 3);
});

test("5xx is retried with backoff, then succeeds without advancing state", async () => {
  const { fetchImpl, requests } = capturingFetch((_req, call) =>
    call < 3 ? jsonResponse({ error: "boom" }, 503) : jsonResponse([visitRow()]),
  );
  const sleeps: number[] = [];
  const entries = await new ReittiClient({
    ...baseOptions({ fetchImpl }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  }).fetchTimeline({ date: "2026-08-17", timezone: "UTC" });
  assert.equal(entries.length, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [1_000, 2_000]);
});

test("Retry-After seconds override the exponential backoff", async () => {
  const sleeps: number[] = [];
  const { fetchImpl } = capturingFetch((_req, call) =>
    call === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "7" } }) : jsonResponse([]),
  );
  await new ReittiClient({
    ...baseOptions({ fetchImpl }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  }).fetchTimeline({ date: "2026-08-17", timezone: "UTC" });
  assert.deepEqual(sleeps, [7_000]);
});

test("a non-JSON body fails with kind invalid-json and no retry", async () => {
  const { fetchImpl, requests } = capturingFetch(() => new Response("<html/>", { status: 200 }));
  await assert.rejects(
    new ReittiClient(baseOptions({ fetchImpl })).fetchTimeline({ date: "2026-08-17", timezone: "UTC" }),
    (err: unknown) => err instanceof ReittiApiError && err.kind === "invalid-json",
  );
  assert.equal(requests.length, 1);
});

test("a request timeout is a retryable timeout error, distinct from the caller's abort", async () => {
  // The fetch hangs until the client's own timeout signal aborts it. The
  // ref'd fallback timer keeps the event loop alive across attempts —
  // AbortSignal.timeout timers are unref'd and alone would drain the loop.
  const requests: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url));
    const { promise, reject } = Promise.withResolvers<never>();
    const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    const fallback = setTimeout(abort, 5_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(fallback);
      abort();
    });
    return promise;
  }) as typeof fetch;
  await assert.rejects(
    new ReittiClient(baseOptions({ fetchImpl, timeoutMs: 10 })).fetchTimeline({
      date: "2026-08-17",
      timezone: "UTC",
    }),
    (err: unknown) => err instanceof ReittiApiError && err.kind === "timeout",
  );
  assert.equal(requests.length, 4, "timeout is retried up to the bound");
});

test("the caller's abort propagates unwrapped, unretried, and before any request", async () => {
  const { promise, reject } = Promise.withResolvers<never>();
  reject(new DOMException("This operation was aborted", "AbortError"));
  void promise.catch(() => {});
  const { fetchImpl, requests } = capturingFetch(() => promise as Promise<Response>);
  const controller = new AbortController();
  controller.abort();
  const client = new ReittiClient(baseOptions({ fetchImpl }));
  await assert.rejects(
    client.fetchTimeline({ date: "2026-08-17", timezone: "UTC", signal: controller.signal }),
    (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  );
  assert.equal(requests.length, 0, "an aborted caller must not fire even one request");
});

test("an abort mid-flight rethrows the caller's error raw and is never retried", async () => {
  const controller = new AbortController();
  const requests: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url));
    const { promise, reject } = Promise.withResolvers<never>();
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("This operation was aborted", "AbortError")),
    );
    return promise;
  }) as typeof fetch;
  const pending = new ReittiClient(baseOptions({ fetchImpl })).fetchTimeline({
    date: "2026-08-17",
    timezone: "UTC",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  );
  assert.equal(requests.length, 1, "a mid-flight abort must not be retried");
});

test("a declared content-length over the bound rejects without reading the body", async () => {
  const { fetchImpl, requests } = capturingFetch(
    () => jsonResponse({ padding: "x".repeat(64) }, 200, { "content-length": "999999999" }),
  );
  await assert.rejects(
    new ReittiClient(baseOptions({ fetchImpl, maxResponseBytes: 1024 })).fetchTimeline({
      date: "2026-08-17",
      timezone: "UTC",
    }),
    (err: unknown) => err instanceof ReittiApiError && err.kind === "response-too-large",
  );
  assert.equal(requests.length, 1);
});

test("a streaming body over the bound rejects mid-read", async () => {
  const bigBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4096).fill(65));
      controller.enqueue(new Uint8Array(4096).fill(66));
      controller.close();
    },
  });
  const oversized = new Response(bigBody, { status: 200, headers: { "content-length": "8192" } });
  const fetchImpl = (async () => oversized) as typeof fetch;
  await assert.rejects(
    new ReittiClient(baseOptions({ fetchImpl, maxResponseBytes: 1024 })).fetchTimeline({
      date: "2026-08-17",
      timezone: "UTC",
    }),
    (err: unknown) => err instanceof ReittiApiError && err.kind === "response-too-large",
  );
});

test("the token never appears in any error message", async () => {
  const messages: string[] = [];
  const record = (err: unknown) => {
    if (err instanceof Error) messages.push(err.message);
  };
  const failing: Array<() => Promise<unknown>> = [
    () =>
      new ReittiClient(baseOptions({ fetchImpl: capturingFetch(() => jsonResponse({}, 401)).fetchImpl })).fetchTimeline({
        date: "2026-08-17",
        timezone: "UTC",
      }),
    () =>
      new ReittiClient(baseOptions({ fetchImpl: capturingFetch(() => jsonResponse({}, 429)).fetchImpl, sleep: noSleep }))
        .fetchTimeline({ date: "2026-08-17", timezone: "UTC" }),
    () =>
      new ReittiClient(baseOptions({ fetchImpl: capturingFetch(() => new Response("nope")).fetchImpl })).fetchTimeline({
        date: "2026-08-17",
        timezone: "UTC",
      }),
    () =>
      new ReittiClient(baseOptions({ fetchImpl: capturingFetch(() => jsonResponse({ places: 3 })).fetchImpl }))
        .fetchVisits({ date: "2026-08-17", timezone: "UTC" }),
    () =>
      new ReittiClient(baseOptions({ fetchImpl: capturingFetch(() => jsonResponse("not-an-array")).fetchImpl }))
        .fetchTimeline({ date: "2026-08-17", timezone: "UTC" }),
  ];
  for (const attempt of failing) {
    try {
      await attempt();
    } catch (err) {
      record(err);
    }
  }
  assert.equal(messages.length, failing.length);
  for (const message of messages) {
    assert.equal(message.includes(TOKEN), false, `token leaked into: ${message}`);
  }
});
