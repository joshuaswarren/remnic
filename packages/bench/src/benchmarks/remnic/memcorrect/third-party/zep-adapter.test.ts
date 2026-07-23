/**
 * Deterministic smoke tests for the Zep MemCorrect adapter (issue #1727).
 * No network — fake fetch drives the full request/response cycle.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ZepMemCorrectAdapter } from "./zep-adapter.js";
import { MissingCredentialError } from "./shared.js";
import { FakeFetchBuilder } from "./fake-fetch.js";

// ---------------------------------------------------------------------------
// Keyless
// ---------------------------------------------------------------------------

test("zep: keyless adapter throws MissingCredentialError", async () => {
  const adapter = new ZepMemCorrectAdapter({});
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z"),
    MissingCredentialError,
  );
  await assert.rejects(() => adapter.recall("q", "s1"), MissingCredentialError);
  await assert.rejects(() => adapter.reset(), MissingCredentialError);
  await adapter.runMaintenance(); // no-op, no creds needed
});

// ---------------------------------------------------------------------------
// Full cycle
// ---------------------------------------------------------------------------

test("zep: ingestTurn creates session then adds memory", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: { id: "x" } })
    .when("POST", "/memory", { status: 200, body: {} })
    .build();
  const adapter = new ZepMemCorrectAdapter({
    apiKey: "zep-key",
    baseUrl: "https://api.getzep.com/api/v2",
    sessionPrefix: "memcorrect",
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "I prefer dark roast.", "2026-07-07T00:00:00Z");

  // User creation (one user per session for namespace isolation).
  ff.assertRequest("POST", "/users", (req) => {
    assert.deepEqual(req.body, { user_id: "memcorrect:s1" });
  });
  // Session creation — Zep v2 requires session_id + user_id.
  ff.assertRequest("POST", "/sessions", (req) => {
    assert.equal(req.headers["Authorization"], "Api-Key zep-key");
    assert.deepEqual(req.body, {
      session_id: "memcorrect:s1",
      user_id: "memcorrect:s1",
    });
  });
  // Memory add.
  ff.assertRequest("POST", "/memory", (req) => {
    assert.deepEqual(req.body, {
      messages: [{ role: "user", role_type: "user", content: "I prefer dark roast." }],
    });
  });
});

test("zep: second ingestTurn does not re-create session", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: { id: "x" } })
    .when("POST", "/memory", { status: 200, body: {} })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  await adapter.ingestTurn("s1", "user", "turn 1", "2026-07-07T00:00:00Z");
  await adapter.ingestTurn("s1", "assistant", "turn 2", "2026-07-07T00:01:00Z");
  const sessionCreations = ff.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/sessions"),
  ).length;
  assert.equal(sessionCreations, 1, "session created once");
  assert.equal(ff.countRequests("POST", "/memory"), 2);
});

test("zep: recall POSTs graph search with the probe query", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/graph/search", {
      status: 200,
      body: {
        edges: [
          { fact: "User prefers dark roast coffee." },
          { fact: "Works at Acme Corp." },
          { fact: "Lives in Austin" },
          { fact: "  " }, // whitespace-only fact filtered out
        ],
      },
    })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", sessionPrefix: "memcorrect", fetch: ff.fetch });
  const recalled = await adapter.recall("coffee", "s1");
  assert.deepEqual(recalled, [
    "User prefers dark roast coffee.",
    "Works at Acme Corp.",
    "Lives in Austin",
  ]);

  // The probe query must drive retrieval — not be discarded.
  ff.assertRequest("POST", "/graph/search", (req) => {
    assert.deepEqual(req.body, {
      user_id: "memcorrect:s1",
      query: "coffee",
      scope: "edges",
      limit: 10,
    });
  });
});

test("zep: recall returns [] on empty graph search", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/graph/search", { status: 200, body: { edges: [] } })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  const recalled = await adapter.recall("q", "s1");
  assert.deepEqual(recalled, []);
});

test("zep: recall returns [] on null graph search response", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/graph/search", { status: 200, body: null })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  const recalled = await adapter.recall("q", "s1");
  assert.deepEqual(recalled, []);
});

test("zep: correct() ingests a user turn", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/memory", { status: 200, body: {} })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  await adapter.correct("Correction: switched to tea.", "s1");
  ff.assertRequest("POST", "/memory", (req) => {
    assert.deepEqual(req.body, {
      messages: [{ role: "user", role_type: "user", content: "Correction: switched to tea." }],
    });
  });
});

test("zep: reset() deletes known sessions and users", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/memory", { status: 200, body: {} })
    .when("DELETE", "/sessions/", { status: 204 })
    .when("DELETE", "/users/", { status: 204 })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  await adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z");
  await adapter.ingestTurn("s2", "user", "world", "2026-07-07T00:01:00Z");
  await adapter.reset();
  assert.equal(ff.countRequests("DELETE", "/sessions/"), 2);
  // Users must be deleted too — the knowledge graph survives session delete.
  assert.equal(ff.countRequests("DELETE", "/users/"), 2);
  // After reset, session is re-created on next ingest.
  await adapter.ingestTurn("s1", "user", "again", "2026-07-07T00:02:00Z");
  const postResetCreations = ff.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/sessions"),
  ).length;
  assert.equal(postResetCreations, 3);
});

test("zep: runMaintenance is a no-op with settleMs=0", async () => {
  const ff = new FakeFetchBuilder().build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  await adapter.runMaintenance();
  assert.equal(ff.requests.length, 0);
});

test("zep: assistant role maps to assistant role_type", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/memory", { status: 200, body: {} })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  await adapter.ingestTurn("s1", "assistant", "Sure thing!", "2026-07-07T00:00:00Z");
  ff.assertRequest("POST", "/memory", (req) => {
    const body = req.body as { messages: Array<{ role_type: string }> };
    assert.equal(body.messages[0]?.role_type, "assistant");
  });
});

// ---------------------------------------------------------------------------
// #1747 review-round-2 hardening: settle-before-recall, reset failure, ns isolation
// ---------------------------------------------------------------------------

test("zep: recall settles after ingest when settleMs > 0", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/memory", { status: 200, body: {} })
    .when("POST", "/graph/search", { status: 200, body: { edges: [] } })
    .build();
  const adapter = new ZepMemCorrectAdapter({
    apiKey: "k",
    sessionPrefix: "memcorrect",
    settleMs: 30,
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "fact", "2026-07-07T00:00:00Z");
  const t0 = Date.now();
  await adapter.recall("q", "s1"); // must settle ~30ms after the ingest
  assert.ok(Date.now() - t0 >= 25, `recall waited for settle (elapsed=${Date.now() - t0}ms)`);
  // A second recall with no intervening ingest must NOT settle again.
  const t1 = Date.now();
  await adapter.recall("q2", "s1");
  assert.ok(Date.now() - t1 < 20, `second recall did not re-settle (elapsed=${Date.now() - t1}ms)`);
});

test("zep: reset() rethrows when user delete fails (graph data may remain)", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/memory", { status: 200, body: {} })
    .when("DELETE", "/sessions/", { status: 204 })
    .when("DELETE", "/users/", { status: 500, body: { detail: "server error" } })
    .build();
  const adapter = new ZepMemCorrectAdapter({
    apiKey: "k",
    sessionPrefix: "memcorrect",
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "fact", "2026-07-07T00:00:00Z");
  // Session delete succeeds (204) but the user graph delete fails (500); the
  // knowledge graph may remain, so reset must surface this rather than pretend.
  await assert.rejects(() => adapter.reset(), /Zep reset could not clean/);
  assert.equal(ff.countRequests("DELETE", "/users/"), 1);
  // The session is retained for retry.
  await assert.rejects(() => adapter.reset(), /Zep reset could not clean/);
  assert.equal(ff.countRequests("DELETE", "/users/"), 2, "failed id retried");
});

test("zep: default sessionPrefix is unique per instance (cross-process isolation)", async () => {
  const captureSessionId = async (): Promise<string> => {
    const ff = new FakeFetchBuilder()
      .when("POST", "/users", { status: 201, body: {} })
      .when("POST", "/sessions", { status: 200, body: {} })
      .when("POST", "/memory", { status: 200, body: {} })
      .build();
    const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
    await adapter.ingestTurn("s1", "user", "hi", "2026-07-07T00:00:00Z");
    return (ff.requests.find((r) => r.method === "POST" && r.url.includes("/sessions"))!
      .body as { session_id: string }).session_id;
  };
  const idA = await captureSessionId();
  const idB = await captureSessionId();
  assert.ok(idA.startsWith("memcorrect-"), `namespaced prefix: ${idA}`);
  assert.ok(idB.startsWith("memcorrect-"), `namespaced prefix: ${idB}`);
  assert.notEqual(idA, idB, "two instances get distinct remote namespaces");
});

// ---------------------------------------------------------------------------
// #1747 review-round-4: ensureSession must not swallow real create failures
// ---------------------------------------------------------------------------

test("zep: ensureSession swallows 409 (already exists) for user and session creates", async () => {
  // /memory is registered before /sessions because the memory-add URL
  // (.../sessions/<id>/memory) contains both substrings; without this order
  // the session matcher would shadow the memory matcher.
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 409, body: { detail: "already exists" } })
    .when("POST", "/memory", { status: 200, body: {} })
    .when("POST", "/sessions", { status: 409, body: { detail: "already exists" } })
    .build();
  const adapter = new ZepMemCorrectAdapter({
    apiKey: "k",
    sessionPrefix: "memcorrect",
    fetch: ff.fetch,
  });
  // 409 on both creates is a harmless "already exists" — ingest proceeds.
  await adapter.ingestTurn("s1", "user", "hi", "2026-07-07T00:00:00Z");
  assert.equal(ff.countRequests("POST", "/memory"), 1);
});

test("zep: ensureSession surfaces a real session-create failure (500)", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 201, body: {} })
    .when("POST", "/sessions", { status: 500, body: { detail: "server error" } })
    .build();
  const adapter = new ZepMemCorrectAdapter({
    apiKey: "k",
    sessionPrefix: "memcorrect",
    fetch: ff.fetch,
  });
  // A 500 on session create must NOT be swallowed as "already exists" — the
  // session is missing and every later call would fail confusingly.
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hi", "2026-07-07T00:00:00Z"),
    (err: unknown) => {
      assert.match((err as Error).message, /500/);
      return true;
    },
  );
});

test("zep: ensureSession surfaces a real user-create failure (401)", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/users", { status: 401, body: { detail: "unauthorized" } })
    .build();
  const adapter = new ZepMemCorrectAdapter({
    apiKey: "bad-key",
    sessionPrefix: "memcorrect",
    fetch: ff.fetch,
  });
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hi", "2026-07-07T00:00:00Z"),
    (err: unknown) => {
      assert.match((err as Error).message, /401/);
      return true;
    },
  );
});
