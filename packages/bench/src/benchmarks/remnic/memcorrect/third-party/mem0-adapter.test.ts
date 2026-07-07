/**
 * Deterministic smoke tests for the Mem0 MemCorrect adapter (issue #1727).
 *
 * No network. A fake fetch captures every request and returns canned responses
 * so the full request/response cycle (URL, headers, body, response parsing)
 * is exercised hermetically. This is the "keyless smoke" acceptance gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Mem0MemCorrectAdapter } from "./mem0-adapter.js";
import { MissingCredentialError } from "./shared.js";
import { FakeFetchBuilder } from "./fake-fetch.js";

// ---------------------------------------------------------------------------
// Keyless — every method throws MissingCredentialError (skip-with-reason)
// ---------------------------------------------------------------------------

test("mem0: keyless adapter throws MissingCredentialError on ingest", async () => {
  const adapter = new Mem0MemCorrectAdapter({});
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z"),
    (err: unknown) => {
      assert.ok(err instanceof MissingCredentialError);
      assert.match((err as MissingCredentialError).reason, /Mem0/);
      assert.match((err as MissingCredentialError).reason, /apiKey/);
      return true;
    },
  );
});

test("mem0: keyless adapter throws on recall, correct, reset, runMaintenance", async () => {
  const adapter = new Mem0MemCorrectAdapter({});
  await assert.rejects(() => adapter.recall("q", "s1"), MissingCredentialError);
  await assert.rejects(() => adapter.correct("c", "s1"), MissingCredentialError);
  await assert.rejects(() => adapter.reset(), MissingCredentialError);
  // runMaintenance is a no-op and does not require credentials.
  await adapter.runMaintenance();
});

// ---------------------------------------------------------------------------
// OSS mode — full request/response cycle against fake fetch
// ---------------------------------------------------------------------------

test("mem0 oss: ingestTurn POSTs to /memories with user_id and auth", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/memories", { status: 200, body: [] })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  assert.equal(adapter.isConfigured(), true);
  await adapter.ingestTurn("session-1", "user", "I love oat-milk lattes.", "2026-07-07T00:00:00Z");

  ff.assertRequest("POST", "/memories", (req) => {
    assert.equal(req.headers["Authorization"], "Bearer test-key");
    assert.deepEqual(req.body, {
      messages: [{ role: "user", content: "I love oat-milk lattes." }],
      user_id: "memcorrect:session-1",
    });
  });
});

test("mem0 oss: recall POSTs to /search and returns memory strings", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/search", {
      status: 200,
      body: [
        { memory: "User loves oat-milk lattes.", id: "m1" },
        { memory: "User works at Acme Corp.", id: "m2" },
      ],
    })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  const recalled = await adapter.recall("coffee preference", "s1");
  assert.deepEqual(recalled, ["User loves oat-milk lattes.", "User works at Acme Corp."]);

  ff.assertRequest("POST", "/search", (req) => {
    assert.equal(req.headers["Authorization"], "Bearer test-key");
    assert.deepEqual(req.body, {
      query: "coffee preference",
      user_id: "memcorrect:s1",
      limit: 10,
    });
  });
});

test("mem0 oss: recall handles {results: [...]} wrapper", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/search", {
      status: 200,
      body: { results: [{ memory: "Fact A" }] },
    })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  const recalled = await adapter.recall("q", "s1");
  assert.deepEqual(recalled, ["Fact A"]);
});

test("mem0 oss: recall returns [] on empty results", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/search", { status: 200, body: [] })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  const recalled = await adapter.recall("q", "s1");
  assert.deepEqual(recalled, []);
});

test("mem0 oss: correct() ingests a user turn", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/memories", { status: 200, body: [] })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  await adapter.correct("Correction: coffee is now black coffee.", "s1");
  assert.equal(ff.countRequests("POST", "/memories"), 1);
  ff.assertRequest("POST", "/memories", (req) => {
    assert.deepEqual(req.body, {
      messages: [{ role: "user", content: "Correction: coffee is now black coffee." }],
      user_id: "memcorrect:s1",
    });
  });
});

test("mem0 oss: reset() DELETEs each ingested session's user_id", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/memories", { status: 200, body: [] })
    .when("DELETE", "/memories", { status: 200, body: {} })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  // Ingest under two sessions so reset has something to clean.
  await adapter.ingestTurn("s1", "user", "fact one", "2026-07-07T00:00:00Z");
  await adapter.ingestTurn("s2", "user", "fact two", "2026-07-07T00:01:00Z");
  await adapter.reset();
  // Each session's exact user_id is deleted — NOT the bare prefix.
  assert.equal(ff.countRequests("DELETE", "/memories"), 2);
  const deletedIds = ff.requests
    .filter((r) => r.method === "DELETE")
    .map((r) => r.body.user_id);
  assert.ok(deletedIds.includes("memcorrect:s1"));
  assert.ok(deletedIds.includes("memcorrect:s2"));
  assert.ok(!deletedIds.includes("memcorrect"), "must not delete bare prefix");
  // After reset, known sessions are cleared.
  assert.equal(ff.requests.filter((r) => r.method === "DELETE").length, 2);
});

test("mem0 oss: reset() with no prior ingest is a no-op", async () => {
  const ff = new FakeFetchBuilder()
    .when("DELETE", "/memories", { status: 200, body: {} })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  await adapter.reset();
  assert.equal(ff.requests.length, 0, "no sessions to delete");
});

test("mem0 oss: runMaintenance is a no-op (no requests)", async () => {
  const ff = new FakeFetchBuilder().build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  await adapter.runMaintenance();
  assert.equal(ff.requests.length, 0);
});

test("mem0 oss: non-2xx throws HttpError with body excerpt", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/memories", { status: 500, body: { detail: "server error" } })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "oss",
    baseUrl: "http://localhost:8888",
    apiKey: "test-key",
    fetch: ff.fetch,
  });
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z"),
    (err: unknown) => {
      assert.match((err as Error).message, /500/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Hosted mode — Token auth + V3 paths + async event polling
// ---------------------------------------------------------------------------

test("mem0 hosted: uses Token auth and V3 paths", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v3/memories/add/", {
      status: 200,
      body: { event_id: "evt-1", status: "PENDING" },
    })
    .when("GET", "/v1/event/evt-1", {
      status: 200,
      body: { status: "SUCCEEDED" },
    })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "hosted",
    apiKey: "hosted-key",
    fetch: ff.fetch,
    pollIntervalMs: 1, // fast poll for test
  });
  assert.equal(adapter.label, "mem0-hosted");
  await adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z");

  ff.assertRequest("POST", "/v3/memories/add/", (req) => {
    assert.equal(req.headers["Authorization"], "Token hosted-key");
    assert.deepEqual(req.body, {
      messages: [{ role: "user", content: "hello" }],
      user_id: "memcorrect:s1",
    });
  });
  // Event was polled.
  assert.ok(ff.countRequests("GET", "/v1/event/evt-1") >= 1);
});

test("mem0 hosted: search uses V3 endpoint with filters", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v3/memories/search/", {
      status: 200,
      body: [{ memory: "Fact X" }],
    })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "hosted",
    apiKey: "hosted-key",
    fetch: ff.fetch,
  });
  const recalled = await adapter.recall("query", "s1");
  assert.deepEqual(recalled, ["Fact X"]);
  ff.assertRequest("POST", "/v3/memories/search/", (req) => {
    assert.deepEqual(req.body, {
      query: "query",
      filters: { user_id: "memcorrect:s1" },
      top_k: 10,
    });
  });
});

test("mem0 hosted: async add polls until SUCCEEDED", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v3/memories/add/", {
      status: 200,
      body: { event_id: "evt-2", status: "PENDING" },
    })
    .when(
      "GET",
      "/v1/event/evt-2",
      { status: 200, body: { status: "PENDING" } },
      { status: 200, body: { status: "SUCCEEDED" } },
    )
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "hosted",
    apiKey: "hosted-key",
    fetch: ff.fetch,
    pollIntervalMs: 1,
  });
  await adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z");
  // First poll returns PENDING, second returns SUCCEEDED → 2 GETs.
  assert.equal(ff.countRequests("GET", "/v1/event/evt-2"), 2);
});

test("mem0 hosted: FAILED event throws", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v3/memories/add/", {
      status: 200,
      body: { event_id: "evt-3", status: "PENDING" },
    })
    .when("GET", "/v1/event/evt-3", {
      status: 200,
      body: { status: "FAILED", error: "LLM timeout" },
    })
    .build();
  const adapter = new Mem0MemCorrectAdapter({
    mode: "hosted",
    apiKey: "hosted-key",
    fetch: ff.fetch,
    pollIntervalMs: 1,
  });
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z"),
    (err: unknown) => {
      assert.match((err as Error).message, /evt-3.*failed|LLM timeout/);
      return true;
    },
  );
});

test("mem0: mode defaults to hosted without baseUrl, oss with custom baseUrl", () => {
  const a = new Mem0MemCorrectAdapter({ apiKey: "k" });
  assert.equal(a.label, "mem0-hosted");
  const b = new Mem0MemCorrectAdapter({ apiKey: "k", baseUrl: "http://my-host:8888" });
  assert.equal(b.label, "mem0-oss");
  const c = new Mem0MemCorrectAdapter({ apiKey: "k", mode: "hosted", baseUrl: "http://x" });
  assert.equal(c.label, "mem0-hosted");
});
