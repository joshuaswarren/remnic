import assert from "node:assert/strict";
import { test } from "node:test";

import { GranolaApiError, GranolaClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("constructor throws an actionable error when the API key is missing", () => {
  assert.throws(() => new GranolaClient({ apiKey: "" }), (err: unknown) => {
    assert.ok(err instanceof GranolaApiError);
    assert.match(err.message, /REMNIC_GRANOLA_API_KEY/);
    return true;
  });
});

test("listNotes sends the day window and bearer auth, returns notes + cursor", async () => {
  let captured: { url: string; auth: string | null } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
    return jsonResponse({ notes: [{ id: "not_a", title: "Sync" }], hasMore: true, cursor: "c2" });
  }) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_test", fetchImpl });
  const page = await client.listNotes({
    createdAfter: "2026-03-10T06:00:00.000Z",
    createdBefore: "2026-03-11T05:00:00.000Z",
  });
  assert.equal(page.notes.length, 1);
  assert.equal(page.notes[0]?.id, "not_a");
  assert.equal(page.nextCursor, "c2");
  assert.match(captured?.url ?? "", /created_after=2026-03-10T06%3A00%3A00.000Z/);
  assert.match(captured?.url ?? "", /created_before=2026-03-11T05%3A00%3A00.000Z/);
  assert.equal(captured?.auth, "Bearer grn_test");
});

test("hasMore=false yields a null cursor even if a cursor is present", async () => {
  const fetchImpl = (async () =>
    jsonResponse({ notes: [{ id: "not_a" }], hasMore: false, cursor: "ignored" })) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_test", fetchImpl });
  const page = await client.listNotes({ createdAfter: "a", createdBefore: "b" });
  assert.equal(page.nextCursor, null);
});

test("an empty notes array is a valid empty result, not an error", async () => {
  const fetchImpl = (async () => jsonResponse({ notes: [], hasMore: false, cursor: null })) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_test", fetchImpl });
  const page = await client.listNotes({ createdAfter: "a", createdBefore: "b" });
  assert.deepEqual(page, { notes: [], nextCursor: null });
});

test("getNote fetches a single note with the transcript include", async () => {
  let url = "";
  const fetchImpl = (async (u: string | URL | Request) => {
    url = String(u);
    return jsonResponse({ id: "not_a", title: "Sync", transcript: [] });
  }) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_test", fetchImpl });
  const note = await client.getNote("not_a");
  assert.equal(note.id, "not_a");
  assert.match(url, /\/v1\/notes\/not_a\?include=transcript$/);
});

test("getNote surfaces a 404 as a GranolaApiError with status 404", async () => {
  const fetchImpl = (async () => jsonResponse({ error: "not found" }, 404)) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_test", fetchImpl });
  await assert.rejects(client.getNote("not_gone"), (err: unknown) => {
    assert.ok(err instanceof GranolaApiError);
    assert.equal(err.status, 404);
    return true;
  });
});

test("verifyAuth reports a bad key on 401", async () => {
  const fetchImpl = (async () => jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_bad", fetchImpl });
  const result = await client.verifyAuth();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /rejected the API key/);
});

test("verifyAuth succeeds on a clean probe", async () => {
  const fetchImpl = (async () => jsonResponse({ notes: [], hasMore: false, cursor: null })) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_ok", fetchImpl });
  assert.deepEqual(await client.verifyAuth(), { ok: true });
});

test("5xx is retried with an injected sleep, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async () => {
    calls += 1;
    if (calls < 3) return jsonResponse({ error: "boom" }, 503);
    return jsonResponse({ notes: [{ id: "not_a" }], hasMore: false, cursor: null });
  }) as typeof fetch;
  const client = new GranolaClient({
    apiKey: "grn_ok",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const page = await client.listNotes({ createdAfter: "a", createdBefore: "b" });
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(page.notes[0]?.id, "not_a");
});

test("a non-JSON body fails loudly", async () => {
  const fetchImpl = (async () => new Response("<html/>", { status: 200 })) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_ok", fetchImpl });
  await assert.rejects(client.listNotes({ createdAfter: "a", createdBefore: "b" }), GranolaApiError);
});

test("a missing notes array fails loudly", async () => {
  const fetchImpl = (async () => jsonResponse({ notes: "nope", hasMore: false })) as typeof fetch;
  const client = new GranolaClient({ apiKey: "grn_ok", fetchImpl });
  await assert.rejects(client.listNotes({ createdAfter: "a", createdBefore: "b" }), GranolaApiError);
});
