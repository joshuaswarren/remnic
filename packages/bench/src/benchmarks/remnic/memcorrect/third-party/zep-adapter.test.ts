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
    .when("POST", "/sessions", { status: 200, body: { id: "x" } })
    .when("POST", "/memory", { status: 200, body: {} })
    .build();
  const adapter = new ZepMemCorrectAdapter({
    apiKey: "zep-key",
    baseUrl: "https://api.getzep.com/api/v2",
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "I prefer dark roast.", "2026-07-07T00:00:00Z");

  // Session creation.
  ff.assertRequest("POST", "/sessions", (req) => {
    assert.equal(req.headers["Authorization"], "Api-Key zep-key");
    assert.deepEqual(req.body, { id: "memcorrect:s1" });
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

test("zep: recall returns context paragraphs + relevant facts", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("GET", "/memory", {
      status: 200,
      body: {
        context: "User prefers dark roast coffee.\n\nWorks at Acme Corp.",
        relevant_facts: [
          { fact: "Lives in Austin", content: "Lives in Austin" },
          { fact: "Old fact", content: "" }, // empty content filtered
        ],
        messages: [],
      },
    })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  const recalled = await adapter.recall("coffee", "s1");
  assert.deepEqual(recalled, [
    "User prefers dark roast coffee.",
    "Works at Acme Corp.",
    "Lives in Austin",
  ]);
});

test("zep: recall returns [] on empty memory", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("GET", "/memory", { status: 200, body: {} })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  const recalled = await adapter.recall("q", "s1");
  assert.deepEqual(recalled, []);
});

test("zep: recall falls back to deprecated facts array", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("GET", "/memory", {
      status: 200,
      body: { facts: ["Fact one", "Fact two"] },
    })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  const recalled = await adapter.recall("q", "s1");
  assert.deepEqual(recalled, ["Fact one", "Fact two"]);
});

test("zep: correct() ingests a user turn", async () => {
  const ff = new FakeFetchBuilder()
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

test("zep: reset() deletes known sessions", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/memory", { status: 200, body: {} })
    .when("DELETE", "/sessions/", { status: 204 })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  await adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z");
  await adapter.ingestTurn("s2", "user", "world", "2026-07-07T00:01:00Z");
  await adapter.reset();
  assert.equal(ff.countRequests("DELETE", "/sessions/"), 2);
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
    .when("POST", "/sessions", { status: 200, body: {} })
    .when("POST", "/memory", { status: 200, body: {} })
    .build();
  const adapter = new ZepMemCorrectAdapter({ apiKey: "k", fetch: ff.fetch });
  await adapter.ingestTurn("s1", "assistant", "Sure thing!", "2026-07-07T00:00:00Z");
  ff.assertRequest("POST", "/memory", (req) => {
    assert.equal(req.body.messages[0].role_type, "assistant");
  });
});
