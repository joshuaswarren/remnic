import assert from "node:assert/strict";
import { test } from "node:test";

import { BeeApiError, BeeClient, BEE_DEFAULT_BASE_URL } from "./client.js";

type FetchCall = { url: string; headers: Record<string, string> };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  responses: Array<Response | Error>,
  options: { token?: string; baseUrl?: string } = {},
): { client: BeeClient; calls: FetchCall[]; sleeps: number[] } {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  const client = new BeeClient({
    ...options,
    fetchImpl: (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
      });
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

test("proxy mode is the default and sends no Authorization header", async () => {
  const { client, calls } = makeClient([
    jsonResponse({ conversations: [], next_cursor: null }),
  ]);
  await client.listConversations();
  assert.ok(calls[0].url.startsWith(BEE_DEFAULT_BASE_URL));
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(client.usingLocalProxy, true);
});

test("direct mode sends the Bearer token", async () => {
  const { client, calls } = makeClient(
    [jsonResponse({ conversations: [], next_cursor: null })],
    { token: "synthetic-token", baseUrl: "https://bee.example.test" },
  );
  await client.listConversations();
  assert.equal(calls[0].headers.Authorization, "Bearer synthetic-token");
  assert.equal(client.usingLocalProxy, false);
});

test("listConversations forwards cursor and surfaces next_cursor (string or number)", async () => {
  const { client, calls } = makeClient([
    jsonResponse({
      conversations: [{ id: 1, start_time: 1_780_000_000_000 }],
      next_cursor: "abc",
    }),
    jsonResponse({
      conversations: [{ id: 2, start_time: 1_779_900_000_000 }],
      next_cursor: 17799,
    }),
  ]);
  const first = await client.listConversations();
  assert.equal(first.nextCursor, "abc");
  const second = await client.listConversations({ cursor: first.nextCursor });
  assert.equal(second.nextCursor, "17799");
  const url = new URL(calls[1].url);
  assert.equal(url.searchParams.get("cursor"), "abc");
});

test("getConversation accepts both bare and wrapped detail shapes", async () => {
  const detail = {
    id: 5,
    start_time: 1_780_000_000_000,
    transcriptions: [{ utterances: [{ text: "hi", speaker: "0", spoken_at: 1_780_000_000_500 }] }],
  };
  {
    const { client } = makeClient([jsonResponse(detail)]);
    const result = await client.getConversation(5);
    assert.equal(result?.id, 5);
  }
  {
    const { client } = makeClient([jsonResponse({ conversation: detail })]);
    const result = await client.getConversation(5);
    assert.equal(result?.id, 5);
  }
  {
    const { client } = makeClient([jsonResponse({ nonsense: true })]);
    assert.equal(await client.getConversation(5), null);
  }
});

test("a 404 detail fetch returns null instead of aborting the day", async () => {
  const { client } = makeClient([jsonResponse({ error: "not found" }, 404)]);
  assert.equal(await client.getConversation(404404), null);
  // Non-404 failures still throw (after retries for 5xx).
  const { client: failing } = makeClient([
    jsonResponse({}, 500),
    jsonResponse({}, 502),
    jsonResponse({}, 503),
    jsonResponse({}, 504),
  ]);
  await assert.rejects(failing.getConversation(1), /responded 504/);
});

test("listFacts requests confirmed facts and validates the envelope", async () => {
  const { client, calls } = makeClient([
    jsonResponse({ facts: [{ id: 1, text: "User likes tea." }], next_cursor: null }),
  ]);
  const page = await client.listFacts();
  assert.equal(page.facts.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("confirmed"), "true");

  const { client: badClient } = makeClient([jsonResponse({})]);
  await assert.rejects(badClient.listFacts(), /unexpected \/v1\/facts shape/);
});

test("retries 5xx with backoff and eventually throws", async () => {
  const { client, sleeps } = makeClient([
    jsonResponse({}, 502),
    jsonResponse({}, 503),
    jsonResponse({ conversations: [], next_cursor: null }),
  ]);
  const page = await client.listConversations();
  assert.equal(page.conversations.length, 0);
  assert.equal(sleeps.length, 2);
});

test("network failure in proxy mode points at `bee proxy`", async () => {
  const { client } = makeClient([
    new Error("ECONNREFUSED"),
    new Error("ECONNREFUSED"),
    new Error("ECONNREFUSED"),
    new Error("ECONNREFUSED"),
  ]);
  await assert.rejects(
    client.listConversations(),
    (err: unknown) =>
      err instanceof BeeApiError && /is `bee proxy` running\?/.test(err.message),
  );
});

test("verifyAuth maps 401 to actionable guidance and never leaks the token", async () => {
  const { client } = makeClient([jsonResponse({ error: "unauthorized" }, 401)], {
    token: "synthetic-token",
    baseUrl: "https://bee.example.test",
  });
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /bee login/);
  assert.ok(!(result.detail ?? "").includes("synthetic-token"));
});

test("isLocalProxyUrl compares hostnames exactly, not by prefix", async () => {
  const { isLocalProxyUrl } = await import("./client.js");
  assert.equal(isLocalProxyUrl("http://127.0.0.1:8787"), true);
  assert.equal(isLocalProxyUrl("http://localhost:8787"), true);
  assert.equal(isLocalProxyUrl("http://[::1]:8787"), true);
  assert.equal(isLocalProxyUrl("http://127.0.0.1.evil.example"), false);
  assert.equal(isLocalProxyUrl("https://bee.example.test"), false);
  assert.equal(isLocalProxyUrl("not a url"), false);
});

test("verifyAuth keeps actionable Bee API status detail for non-auth errors", async () => {
  const { client } = makeClient([jsonResponse({}, 500), jsonResponse({}, 502), jsonResponse({}, 503), jsonResponse({}, 504)]);
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /Bee API responded 504/);
  assert.ok(!(result.detail ?? "").includes("bee proxy ("), "API errors are not proxy-reachability guidance");
});

test("verifyAuth reports proxy reachability problems distinctly", async () => {
  const { client } = makeClient([
    new Error("ECONNREFUSED"),
    new Error("ECONNREFUSED"),
    new Error("ECONNREFUSED"),
    new Error("ECONNREFUSED"),
  ]);
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /is `bee proxy` running\?/);
});
