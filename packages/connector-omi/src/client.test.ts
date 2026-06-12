import assert from "node:assert/strict";
import { test } from "node:test";

import { OmiApiError, OmiClient } from "./client.js";

type FetchCall = { url: string; headers: Record<string, string> };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  responses: Array<Response | Error>,
): { client: OmiClient; calls: FetchCall[]; sleeps: number[] } {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  const client = new OmiClient({
    apiKey: "sk_synthetic_not_real",
    appId: "app-123",
    userId: "uid-456",
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

test("constructor demands key, appId, and userId with actionable messages", () => {
  assert.throws(
    () => new OmiClient({ apiKey: "", appId: "a", userId: "u" }),
    /OMI_API_KEY/,
  );
  assert.throws(
    () => new OmiClient({ apiKey: "sk_x", appId: " ", userId: "u" }),
    /appId/,
  );
  assert.throws(
    () => new OmiClient({ apiKey: "sk_x", appId: "a", userId: "" }),
    /userId/,
  );
});

test("listConversations sends uid, day bounds, repeated statuses, and unlimited segments", async () => {
  const { client, calls } = makeClient([
    jsonResponse({ conversations: [] }),
  ]);
  const page = await client.listConversations({
    startIso: "2026-06-10T00:00:00-05:00",
    endIso: "2026-06-11T00:00:00-05:00",
  });
  assert.equal(page.conversations.length, 0);
  assert.equal(page.nextOffset, null);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v2/integrations/app-123/conversations");
  assert.equal(url.searchParams.get("uid"), "uid-456");
  assert.equal(url.searchParams.get("start_date"), "2026-06-10T00:00:00-05:00");
  assert.equal(url.searchParams.get("end_date"), "2026-06-11T00:00:00-05:00");
  assert.equal(url.searchParams.get("max_transcript_segments"), "-1");
  assert.equal(url.searchParams.get("include_discarded"), "false");
  assert.deepEqual(url.searchParams.getAll("statuses"), ["completed"]);
  assert.equal(calls[0].headers.Authorization, "Bearer sk_synthetic_not_real");
});

test("offset pagination advances only on full pages", async () => {
  const fullPage = {
    conversations: Array.from({ length: 100 }, (_, index) => ({
      id: `c${index}`,
    })),
  };
  const { client } = makeClient([
    jsonResponse(fullPage),
    jsonResponse({ conversations: [{ id: "last" }] }),
  ]);
  const first = await client.listConversations({
    startIso: "2026-06-10T00:00:00Z",
    endIso: "2026-06-11T00:00:00Z",
  });
  assert.equal(first.nextOffset, 100);
  const second = await client.listConversations({
    startIso: "2026-06-10T00:00:00Z",
    endIso: "2026-06-11T00:00:00Z",
    offset: first.nextOffset ?? 0,
  });
  assert.equal(second.nextOffset, null);
});

test("listMemories paginates with uid and validates the envelope", async () => {
  const { client, calls } = makeClient([
    jsonResponse({ memories: [{ id: "m1", content: "User likes tea." }] }),
  ]);
  const page = await client.listMemories();
  assert.equal(page.memories.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v2/integrations/app-123/memories");
  assert.equal(url.searchParams.get("uid"), "uid-456");

  const { client: badClient } = makeClient([jsonResponse({})]);
  await assert.rejects(badClient.listMemories(), /unexpected memories shape/);
});

test("FastAPI detail strings surface in errors without leaking the key", async () => {
  const { client } = makeClient([
    jsonResponse({ detail: "App is not enabled for this user" }, 403),
  ]);
  await assert.rejects(
    client.listConversations({
      startIso: "2026-06-10T00:00:00Z",
      endIso: "2026-06-11T00:00:00Z",
    }),
    (err: unknown) =>
      err instanceof OmiApiError &&
      err.status === 403 &&
      err.detail === "App is not enabled for this user" &&
      !err.message.includes("sk_synthetic_not_real"),
  );
});

test("retries 429 honoring Retry-After and 5xx with backoff", async () => {
  const { client, sleeps } = makeClient([
    new Response(JSON.stringify({ detail: "Rate limit exceeded." }), {
      status: 429,
      headers: { "Retry-After": "3" },
    }),
    jsonResponse({}, 502),
    jsonResponse({ conversations: [] }),
  ]);
  const page = await client.listConversations({
    startIso: "2026-06-10T00:00:00Z",
    endIso: "2026-06-11T00:00:00Z",
  });
  assert.equal(page.conversations.length, 0);
  assert.deepEqual(sleeps, [3_000, 2_000]);
});

test("verifyAuth reduces foreign network failures to name + code", async () => {
  const pathy = new Error("connect ETIMEDOUT /home/someone/.cache/loader/path.js");
  (pathy as NodeJS.ErrnoException).code = "ETIMEDOUT";
  const { client } = makeClient([pathy, pathy, pathy, pathy]);
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  // The exhausted-retry OmiApiError message carries the scrubbed code…
  assert.match(result.detail ?? "", /ETIMEDOUT|Error/);
  // …and never the raw path.
  assert.ok(!(result.detail ?? "").includes("/home/someone"));
});

test("verifyAuth maps the authorization chain to actionable detail", async () => {
  {
    const { client } = makeClient([
      jsonResponse({ detail: "Invalid API key" }, 403),
    ]);
    const result = await client.verifyAuth();
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /Invalid API key/);
    assert.match(result.detail ?? "", /read_conversations|not enabled|key rejected/);
  }
  {
    const { client } = makeClient([jsonResponse({ detail: "not found" }, 404)]);
    const result = await client.verifyAuth();
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /appId/);
  }
  {
    const { client } = makeClient([jsonResponse({ conversations: [] })]);
    assert.deepEqual(await client.verifyAuth(), { ok: true });
  }
});
