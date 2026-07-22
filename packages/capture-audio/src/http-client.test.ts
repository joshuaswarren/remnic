import assert from "node:assert/strict";
import { test } from "node:test";

import { DesktopApiError, DesktopCaptureClient, DESKTOP_DEFAULT_BASE_URL } from "./http-client.js";
import type { DaemonConversation } from "./spool.js";

type FetchCall = { url: string; headers: Record<string, string> };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function conversationsPayload(
  conversations: DaemonConversation[],
  nextCursor: string | null = null,
): unknown {
  return { conversations, nextCursor };
}

function finalConversation(id: string): DaemonConversation {
  return {
    id,
    startedAtUtc: "2026-06-10T14:00:00.000Z",
    endedAtUtc: "2026-06-10T14:12:00.000Z",
    state: "final",
    segmentCount: 1,
    segments: [
      {
        textRaw: "Let's ship the connector today.",
        speakerKey: "cluster-1",
        isWearer: true,
        channel: "mic",
        startUtc: "2026-06-10T14:00:01.000Z",
        endUtc: "2026-06-10T14:00:04.000Z",
      },
    ],
  };
}

function makeClient(
  responses: Array<Response | Error>,
  options: { token?: string } = {},
): { client: DesktopCaptureClient; calls: FetchCall[]; sleeps: number[] } {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  const client = new DesktopCaptureClient({
    token: options.token,
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

test("verifyAuth returns ok:true when the daemon reports healthy", async () => {
  const { client, calls } = makeClient([
    jsonResponse({ ok: true, version: "9.14.0", platform: "linux", capturing: false }),
  ]);
  const result = await client.verifyAuth();
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, `${DESKTOP_DEFAULT_BASE_URL}/v1/health`);
});

test("verifyAuth maps 401 to ok:false with token guidance (not a backend error)", async () => {
  const { client } = makeClient([jsonResponse({ error: "unauthorized" }, 401)]);
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /401/);
  assert.doesNotMatch(result.detail ?? "", /500/);
});

test("verifyAuth maps a 500 backend failure to ok:false, distinct from 401", async () => {
  // 5xx is retried, so supply enough responses to exhaust the retries.
  const { client, sleeps } = makeClient([
    jsonResponse({ error: "internal error" }, 500),
    jsonResponse({ error: "internal error" }, 500),
    jsonResponse({ error: "internal error" }, 500),
    jsonResponse({ error: "internal error" }, 500),
  ]);
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /500/);
  assert.doesNotMatch(result.detail ?? "", /401/);
  assert.ok(sleeps.length >= 1, "5xx should back off before retrying");
});

test("listConversations returns an empty page as success, never an error", async () => {
  const { client } = makeClient([jsonResponse(conversationsPayload([], null))]);
  const page = await client.listConversations({
    date: "2026-06-10",
    timezone: "America/Chicago",
  });
  assert.deepEqual(page, { conversations: [], nextCursor: null });
});

test("listConversations forwards params + bearer token and surfaces the cursor", async () => {
  const { client, calls } = makeClient(
    [jsonResponse(conversationsPayload([finalConversation("conv_a")], "conv_b"))],
    { token: "secret-token-not-real" },
  );
  const page = await client.listConversations({
    date: "2026-06-10",
    timezone: "America/Chicago",
    cursor: "prev-cursor",
  });
  assert.equal(page.conversations.length, 1);
  assert.equal(page.conversations[0].id, "conv_a");
  assert.equal(page.nextCursor, "conv_b");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/conversations");
  assert.equal(url.searchParams.get("date"), "2026-06-10");
  assert.equal(url.searchParams.get("timezone"), "America/Chicago");
  assert.equal(url.searchParams.get("cursor"), "prev-cursor");
  assert.equal(calls[0].headers["Authorization"], "Bearer secret-token-not-real");
});

test("listConversations omits Authorization when no token is configured (loopback)", async () => {
  const { client, calls } = makeClient([jsonResponse(conversationsPayload([]))]);
  await client.listConversations({ date: "2026-06-10", timezone: "UTC" });
  assert.equal(calls[0].headers["Authorization"], undefined);
});

test("listConversations rejects a malformed body loudly (backend failure, not empty)", async () => {
  const { client } = makeClient([jsonResponse({ unexpected: true })]);
  await assert.rejects(
    () => client.listConversations({ date: "2026-06-10", timezone: "UTC" }),
    (err: unknown) => err instanceof DesktopApiError,
  );
});

test("listConversations throws on a 5xx backend failure with the status", async () => {
  const { client } = makeClient([
    jsonResponse({ error: "internal error" }, 500),
    jsonResponse({ error: "internal error" }, 500),
    jsonResponse({ error: "internal error" }, 500),
    jsonResponse({ error: "internal error" }, 500),
  ]);
  await assert.rejects(
    () => client.listConversations({ date: "2026-06-10", timezone: "UTC" }),
    (err: unknown) => err instanceof DesktopApiError && err.status === 500,
  );
});

test("non-retryable 4xx surfaces immediately with the status", async () => {
  const { client, calls } = makeClient([jsonResponse({ error: "bad date" }, 400)]);
  await assert.rejects(
    () => client.listConversations({ date: "nope", timezone: "UTC" }),
    (err: unknown) => err instanceof DesktopApiError && err.status === 400,
  );
  assert.equal(calls.length, 1);
});
