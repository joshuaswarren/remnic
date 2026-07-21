import assert from "node:assert/strict";
import { test } from "node:test";

import { FirefliesApiError, FirefliesClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function transcriptsBody(transcripts: unknown[]): unknown {
  return { data: { transcripts } };
}

test("constructor throws an actionable error when the API key is missing", () => {
  assert.throws(() => new FirefliesClient({ apiKey: "" }), (err: unknown) => {
    assert.ok(err instanceof FirefliesApiError);
    assert.match(err.message, /REMNIC_FIREFLIES_API_KEY/);
    return true;
  });
});

test("listTranscripts posts a GraphQL query with the day window and skip", async () => {
  let captured: { url: string; body: unknown; auth: string | null } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(url),
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    };
    return jsonResponse(transcriptsBody([{ id: "t1", title: "Sync" }]));
  }) as typeof fetch;

  const client = new FirefliesClient({ apiKey: "grn_test", fetchImpl });
  const page = await client.listTranscripts({
    fromDate: "2026-03-10T06:00:00.000Z",
    toDate: "2026-03-11T05:00:00.000Z",
    skip: 50,
  });

  assert.equal(page.transcripts.length, 1);
  assert.equal(page.transcripts[0]?.id, "t1");
  assert.equal(page.hadFullPage, false);
  assert.equal(captured?.url, "https://api.fireflies.ai/graphql");
  assert.equal(captured?.auth, "Bearer grn_test");
  assert.equal(
    (captured?.body as { variables: { fromDate: string; skip: number } }).variables.skip,
    50,
  );
});

test("hadFullPage is true when a full page of results returns", async () => {
  const full = Array.from({ length: 50 }, (_unused, i) => ({ id: `t${i}` }));
  const fetchImpl = (async () => jsonResponse(transcriptsBody(full))) as typeof fetch;
  const client = new FirefliesClient({ apiKey: "grn_test", fetchImpl });
  const page = await client.listTranscripts({ fromDate: "a", toDate: "b" });
  assert.equal(page.transcripts.length, 50);
  assert.equal(page.hadFullPage, true);
});

test("a GraphQL errors array is a backend failure, never an empty result", async () => {
  const fetchImpl = (async () =>
    jsonResponse({ errors: [{ message: "Something went wrong" }] })) as typeof fetch;
  const client = new FirefliesClient({ apiKey: "grn_test", fetchImpl });
  await assert.rejects(
    client.listTranscripts({ fromDate: "a", toDate: "b" }),
    (err: unknown) => {
      assert.ok(err instanceof FirefliesApiError);
      assert.match(err.message, /GraphQL error/);
      return true;
    },
  );
});

test("verifyAuth reports a bad key on HTTP 401", async () => {
  const fetchImpl = (async () => jsonResponse({ errors: ["nope"] }, 401)) as typeof fetch;
  const client = new FirefliesClient({ apiKey: "grn_bad", fetchImpl });
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /rejected the API key/);
});

test("verifyAuth reports a bad key on an auth-coded GraphQL error", async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      errors: [{ message: "invalid api key", extensions: { code: "unauthenticated" } }],
    })) as typeof fetch;
  const client = new FirefliesClient({ apiKey: "grn_bad", fetchImpl });
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /rejected the API key/);
});

test("verifyAuth succeeds on a clean probe", async () => {
  const fetchImpl = (async () => jsonResponse(transcriptsBody([]))) as typeof fetch;
  const client = new FirefliesClient({ apiKey: "grn_ok", fetchImpl });
  assert.deepEqual(await client.verifyAuth(), { ok: true });
});

test("5xx is retried with an injected sleep, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async () => {
    calls += 1;
    if (calls < 3) return jsonResponse({ error: "boom" }, 503);
    return jsonResponse(transcriptsBody([{ id: "t9" }]));
  }) as typeof fetch;
  const client = new FirefliesClient({
    apiKey: "grn_ok",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const page = await client.listTranscripts({ fromDate: "a", toDate: "b" });
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(page.transcripts[0]?.id, "t9");
});

test("a non-JSON body fails loudly", async () => {
  const fetchImpl = (async () =>
    new Response("<html>gateway</html>", { status: 200 })) as typeof fetch;
  const client = new FirefliesClient({ apiKey: "grn_ok", fetchImpl });
  await assert.rejects(client.listTranscripts({ fromDate: "a", toDate: "b" }), FirefliesApiError);
});

test("a missing data.transcripts array fails loudly", async () => {
  const fetchImpl = (async () => jsonResponse({ data: { transcripts: "nope" } })) as typeof fetch;
  const client = new FirefliesClient({ apiKey: "grn_ok", fetchImpl });
  await assert.rejects(client.listTranscripts({ fromDate: "a", toDate: "b" }), FirefliesApiError);
});

test("rawCount reflects the raw page size even when id-less rows are filtered out", async () => {
  const rows = Array.from({ length: 50 }, (_unused, i) => (i < 3 ? { id: `t${i}` } : { noId: true }));
  const fetchImpl = (async () => jsonResponse(transcriptsBody(rows))) as typeof fetch;
  const client = new FirefliesClient({ apiKey: "grn_ok", fetchImpl });
  const page = await client.listTranscripts({ fromDate: "a", toDate: "b" });
  assert.equal(page.transcripts.length, 3);
  assert.equal(page.rawCount, 50);
  assert.equal(page.hadFullPage, true);
});
