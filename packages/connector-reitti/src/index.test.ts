import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  clearLocationProviders,
  getLocationProvider,
  listLocationProviders,
  registerLocationProvider,
} from "@remnic/core/location";

import {
  REITTI_PROVIDER_ID,
  REITTI_VISITS_CURSOR,
  assertValidIanaTimezone,
  createReittiProvider,
  ensureReittiProviderRegistered,
} from "./index.js";

const TOKEN = "rtt_secret_token_3d7a";
const BASE = "https://reitti.example.invalid";

afterEach(() => {
  clearLocationProviders();
});

type Captured = { url: string; headers: Headers };

function providerWith(
  handler: (request: Captured, call: number) => Response,
  options: Partial<Parameters<typeof createReittiProvider>[0]> = {},
) {
  const requests: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(url), headers: new Headers(init?.headers) };
    requests.push(request);
    return handler(request, requests.length);
  }) as typeof fetch;
  const provider = createReittiProvider({
    baseUrl: BASE,
    token: TOKEN,
    timezone: "UTC",
    fetchImpl,
    sleep: async () => {},
    ...options,
  });
  return { provider, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const TIMELINE_ROW = {
  id: "v1",
  type: "VISIT",
  place: { id: 7, name: "Home", address: null, city: null, type: "HOME" },
  startTime: "2026-08-17T08:00:00Z",
  endTime: "2026-08-17T09:00:00Z",
  transportMode: null,
  distanceMeters: null,
};

const BERLIN_DAY_WINDOW = {
  startUtc: "2026-08-17T22:00:00.000Z",
  endUtc: "2026-08-18T22:00:00.000Z",
};

test("invalid provider config throws: token, baseUrl, timezone, visitsFallback", () => {
  const valid = { baseUrl: BASE, token: TOKEN, timezone: "UTC" };
  assert.throws(() => createReittiProvider({ ...valid, token: " " }), TypeError);
  assert.throws(() => createReittiProvider({ ...valid, baseUrl: "nope" }), RangeError);
  assert.throws(() => createReittiProvider({ ...valid, baseUrl: "file://host" }), RangeError);
  assert.throws(() => createReittiProvider({ ...valid, timezone: "Bogus/Zone" }), RangeError);
  assert.throws(() => createReittiProvider({ ...valid, visitsFallback: "yes" as never }), TypeError);
});

test("the provider satisfies the core registry contract and registers idempotently", () => {
  const { provider } = providerWith(() => json([]));
  assert.equal(provider.id, REITTI_PROVIDER_ID);
  assert.equal(provider.displayName, "Reitti");

  assert.equal(ensureReittiProviderRegistered({ baseUrl: BASE, token: TOKEN, timezone: "UTC", fetchImpl: (async () => json([])) as typeof fetch, sleep: async () => {} }), true);
  assert.deepEqual(listLocationProviders(), ["reitti"]);
  assert.equal(
    ensureReittiProviderRegistered({ baseUrl: BASE, token: TOKEN, timezone: "UTC", fetchImpl: (async () => json([])) as typeof fetch, sleep: async () => {} }),
    false,
    "a second registration is a no-op, not a duplicate-id error",
  );
  assert.ok(getLocationProvider("reitti"));
  assert.throws(() => registerLocationProvider(provider), /already registered/);
});

test("fetchObservations derives the local date from the window and forwards date + timezone", async () => {
  const { provider, requests } = providerWith(
    () => json([{ ...TIMELINE_ROW, startTime: "2026-08-18T08:00:00Z", endTime: "2026-08-18T09:00:00Z" }]),
    { timezone: "Europe/Berlin" },
  );
  const page = await provider.fetchObservations(BERLIN_DAY_WINDOW);
  assert.match(requests[0]?.url ?? "", /\/api\/v1\/timeline\?date=2026-08-18&timezone=Europe%2FBerlin$/);
  assert.equal(page.observations.length, 2);
  assert.equal(page.nextCursor, null);
});

test("an empty timeline day is an explicit empty page, not an error or a fallback", async () => {
  const { provider, requests } = providerWith((_req, call) => (call === 1 ? json([]) : json({ places: [] })), {
    visitsFallback: true,
  });
  const page = await provider.fetchObservations({
    startUtc: "2026-08-17T00:00:00.000Z",
    endUtc: "2026-08-18T00:00:00.000Z",
  });
  assert.deepEqual(page, { observations: [], nextCursor: REITTI_VISITS_CURSOR });
  assert.equal(requests.length, 1);

  const second = await provider.fetchObservations({
    startUtc: "2026-08-17T00:00:00.000Z",
    endUtc: "2026-08-18T00:00:00.000Z",
    cursor: REITTI_VISITS_CURSOR,
  });
  assert.match(requests[1]?.url ?? "", /\/api\/v1\/visits\?/);
  assert.equal(second.nextCursor, null);
});

test("without the fallback, an empty timeline day terminates immediately", async () => {
  const { provider, requests } = providerWith(() => json([]), { visitsFallback: false });
  const page = await provider.fetchObservations({
    startUtc: "2026-08-17T00:00:00.000Z",
    endUtc: "2026-08-18T00:00:00.000Z",
  });
  assert.deepEqual(page, { observations: [], nextCursor: null });
  assert.equal(requests.length, 1);
});

test("a visits fallback page normalizes intervals under the summary place", async () => {
  const visitsPayload = {
    places: [
      {
        placeInfo: { id: 7, name: "Home", address: null, city: null, type: "HOME" },
        visits: [{ startTime: "2026-08-17T08:00:00Z", endTime: "2026-08-17T09:00:00Z" }],
      },
    ],
  };
  let call = 0;
  const { provider } = providerWith(() => {
    call += 1;
    return call === 1 ? json([]) : json(visitsPayload);
  }, { visitsFallback: true });
  const window = { startUtc: "2026-08-17T00:00:00.000Z", endUtc: "2026-08-18T00:00:00.000Z" };
  await provider.fetchObservations(window);
  const fallback = await provider.fetchObservations({ ...window, cursor: REITTI_VISITS_CURSOR });
  assert.equal(fallback.observations.length, 2);
  assert.ok(fallback.observations.every((o) => o.place.id === "reitti:place:7"));
});

test("an unknown cursor is rejected loudly", async () => {
  const { provider } = providerWith(() => json([]));
  await assert.rejects(
    provider.fetchObservations({
      startUtc: "2026-08-17T00:00:00.000Z",
      endUtc: "2026-08-18T00:00:00.000Z",
      cursor: "page-9",
    }),
    TypeError,
  );
});

test("an invalid window is rejected before any request", async () => {
  const { provider, requests } = providerWith(() => json([]));
  await assert.rejects(
    provider.fetchObservations({ startUtc: "2026-08-18T00:00:00.000Z", endUtc: "2026-08-17T00:00:00.000Z" }),
    RangeError,
  );
  assert.equal(requests.length, 0);
});

test("verify reports ok on a reachable instance and auth failure on 401/403 without the token", async () => {
  const ok = await providerWith(() => json([])).provider.verify();
  assert.deepEqual(ok, { ok: true });

  for (const status of [401, 403]) {
    const result = await providerWith(() => json({}, status)).provider.verify();
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /rejected the token/);
    assert.equal((result.detail ?? "").includes(TOKEN), false);
  }
});

test("provider errors are typed and never carry the token", async () => {
  const { provider } = providerWith(() => json({}, 500));
  await assert.rejects(
    provider.fetchObservations({ startUtc: "2026-08-17T00:00:00.000Z", endUtc: "2026-08-18T00:00:00.000Z" }),
    (err: unknown) => {
      assert.equal(err instanceof Error && err.message.includes(TOKEN), false);
      return err instanceof Error && err.name === "ReittiApiError";
    },
  );
});

test("observations always fall inside the requested window", async () => {
  const spillRow = { ...TIMELINE_ROW, startTime: "2026-08-16T20:00:00Z", endTime: "2026-08-17T01:30:00Z" };
  const { provider } = providerWith(() => json([spillRow]));
  const page = await provider.fetchObservations({
    startUtc: "2026-08-17T00:00:00.000Z",
    endUtc: "2026-08-18T00:00:00.000Z",
  });
  assert.equal(page.observations.length, 2);
  assert.ok(page.observations.every((o) => o.observedAtUtc >= "2026-08-17T00:00:00.000Z"));
  assert.ok(page.observations.every((o) => o.observedAtUtc < "2026-08-18T00:00:00.000Z"));
});

test("verify rethrows a caller abort instead of reporting the provider unavailable", async () => {
  const controller = new AbortController();
  const { provider } = providerWith(() => {
    controller.abort();
    throw new DOMException("This operation was aborted", "AbortError");
  });
  await assert.rejects(
    provider.verify(controller.signal),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("legacy assertValidIanaTimezone still resolves and validates identically", async () => {
  // Pre-rename consumers import assertValidIanaTimezone from the package
  // entry; it must keep resolving with the same throw behavior and warn
  // about the rename exactly once per process.
  const warnings: Array<string | undefined> = [];
  const onWarning = (warning: Error & { code?: string }) => warnings.push(warning.code);
  process.on("warning", onWarning);
  try {
    assertValidIanaTimezone("Europe/Helsinki");
    assert.throws(() => assertValidIanaTimezone(""), TypeError);
    assert.throws(() => assertValidIanaTimezone("Also/Bogus"), RangeError);
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  } finally {
    process.off("warning", onWarning);
  }
  assert.deepEqual(warnings, ["REMNIC_DEP_REITTI_ASSERT_VALID_IANA_TIMEZONE"]);
});
