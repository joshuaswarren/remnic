import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIFELOGS_MAX_PAGE_SIZE,
  LimitlessApiError,
  LimitlessClient,
} from "./client.js";

type FetchCall = { url: string; headers: Record<string, string> };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lifelogsPayload(ids: string[], nextCursor?: string): unknown {
  return {
    data: {
      lifelogs: ids.map((id) => ({
        id,
        title: `Lifelog ${id}`,
        startTime: "2026-06-10T09:00:00-05:00",
        endTime: "2026-06-10T09:30:00-05:00",
        contents: [],
      })),
    },
    meta: { lifelogs: { nextCursor, count: ids.length } },
  };
}

function makeClient(
  responses: Array<Response | Error>,
  calls: FetchCall[] = [],
): { client: LimitlessClient; calls: FetchCall[]; sleeps: number[] } {
  const sleeps: number[] = [];
  const client = new LimitlessClient({
    apiKey: "test-key-not-real",
    fetchImpl: (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      calls.push({ url: String(input), headers });
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected extra fetch call");
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

test("constructor rejects a missing API key with an actionable message", () => {
  assert.throws(
    () => new LimitlessClient({ apiKey: "  " }),
    /LIMITLESS_API_KEY/,
  );
});

test("listLifelogs sends the documented params and auth header", async () => {
  const { client, calls } = makeClient([jsonResponse(lifelogsPayload(["a"]))]);
  const page = await client.listLifelogs({
    date: "2026-06-10",
    timezone: "America/Chicago",
  });
  assert.equal(page.lifelogs.length, 1);
  assert.equal(page.nextCursor, null);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/lifelogs");
  assert.equal(url.searchParams.get("date"), "2026-06-10");
  assert.equal(url.searchParams.get("timezone"), "America/Chicago");
  assert.equal(url.searchParams.get("limit"), String(LIFELOGS_MAX_PAGE_SIZE));
  assert.equal(url.searchParams.get("includeContents"), "true");
  assert.equal(url.searchParams.get("includeMarkdown"), "false");
  assert.equal(calls[0].headers["X-API-Key"], "test-key-not-real");
});

test("listLifelogs forwards the pagination cursor and surfaces nextCursor", async () => {
  const { client, calls } = makeClient([
    jsonResponse(lifelogsPayload(["b"], "cursor-2")),
  ]);
  const page = await client.listLifelogs({
    date: "2026-06-10",
    timezone: "UTC",
    cursor: "cursor-1",
  });
  assert.equal(page.nextCursor, "cursor-2");
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("cursor"), "cursor-1");
});

test("retries 429 honoring the string retryAfter body field", async () => {
  const { client, sleeps } = makeClient([
    jsonResponse({ error: "API key is rate limited", retryAfter: "2" }, 429),
    jsonResponse(lifelogsPayload(["a"])),
  ]);
  const page = await client.listLifelogs({ date: "2026-06-10", timezone: "UTC" });
  assert.equal(page.lifelogs.length, 1);
  assert.deepEqual(sleeps, [2_000]);
});

test("retries 5xx with exponential backoff and eventually throws", async () => {
  const { client, sleeps } = makeClient([
    jsonResponse({}, 500),
    jsonResponse({}, 502),
    jsonResponse({}, 503),
    jsonResponse({}, 504),
  ]);
  await assert.rejects(
    client.listLifelogs({ date: "2026-06-10", timezone: "UTC" }),
    (err: unknown) => err instanceof LimitlessApiError && err.status === 504,
  );
  assert.equal(sleeps.length, 3);
});

test("non-retryable 4xx fails immediately without the API key in the message", async () => {
  const { client, calls } = makeClient([jsonResponse({}, 400)]);
  await assert.rejects(
    client.listLifelogs({ date: "2026-06-10", timezone: "UTC" }),
    (err: unknown) =>
      err instanceof LimitlessApiError &&
      err.status === 400 &&
      !err.message.includes("test-key-not-real"),
  );
  assert.equal(calls.length, 1);
});

test("exhausted network retries surface the error code, never raw Node text", async () => {
  const pathy = new Error("connect ECONNREFUSED /home/someone/.cache/loader/path.js");
  (pathy as NodeJS.ErrnoException).code = "ECONNREFUSED";
  const { client } = makeClient([pathy, pathy, pathy, pathy]);
  await assert.rejects(
    client.listLifelogs({ date: "2026-06-10", timezone: "UTC" }),
    (err: unknown) =>
      err instanceof LimitlessApiError &&
      err.message.includes("ECONNREFUSED") &&
      !err.message.includes("/home/someone"),
  );
});

test("malformed response shape is rejected loudly", async () => {
  const { client } = makeClient([jsonResponse({ data: {} })]);
  await assert.rejects(
    client.listLifelogs({ date: "2026-06-10", timezone: "UTC" }),
    /unexpected \/v1\/lifelogs shape/,
  );
});

test("verifyAuth maps 401 to ok:false with guidance", async () => {
  const { client } = makeClient([jsonResponse({}, 401)]);
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /Developer settings/);
});

test("verifyAuth returns ok:true on success", async () => {
  const { client } = makeClient([jsonResponse(lifelogsPayload([]))]);
  const result = await client.verifyAuth();
  assert.equal(result.ok, true);
});
