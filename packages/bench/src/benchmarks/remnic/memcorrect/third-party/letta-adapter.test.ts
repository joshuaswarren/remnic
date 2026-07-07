/**
 * Deterministic smoke tests for the Letta MemCorrect adapter (issue #1727).
 * No network — fake fetch drives the full request/response cycle.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { LettaMemCorrectAdapter } from "./letta-adapter.js";
import { MissingCredentialError } from "./shared.js";
import { FakeFetchBuilder } from "./fake-fetch.js";

// ---------------------------------------------------------------------------
// Keyless
// ---------------------------------------------------------------------------

test("letta: keyless adapter throws MissingCredentialError", async () => {
  const adapter = new LettaMemCorrectAdapter({});
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z"),
    MissingCredentialError,
  );
});

test("letta: missing model throws even with key+baseUrl", async () => {
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
  });
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z"),
    (err: unknown) => {
      assert.ok(err instanceof MissingCredentialError);
      assert.match((err as MissingCredentialError).reason, /model/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Full cycle
// ---------------------------------------------------------------------------

test("letta: ingestTurn creates agent then sends message", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", {
      status: 200,
      body: { id: "agent-abc-123", name: "memcorrect-s1" },
    })
    .when("POST", "/messages", {
      status: 200,
      body: { messages: [] },
    })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "letta-key",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "I work at Acme.", "2026-07-07T00:00:00Z");

  ff.assertRequest("POST", "/v1/agents/", (req) => {
    assert.equal(req.headers["Authorization"], "Bearer letta-key");
    assert.equal(req.body.name, "memcorrect-s1");
    assert.equal(req.body.model, "openai/gpt-4o");
    assert.equal(req.body.agent_type, "memgpt_agent");
    assert.ok(req.body.memory_blocks);
    assert.ok(req.body.memory_blocks.length >= 2);
  });
  ff.assertRequest("POST", "/messages", (req) => {
    assert.ok(req.url.includes("agent-abc-123"));
    assert.deepEqual(req.body, {
      messages: [{ role: "user", content: "I work at Acme." }],
    });
  });
});

test("letta: second ingest reuses existing agent (no re-create)", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", { status: 200, body: { id: "agent-1" } })
    .when("POST", "/messages", { status: 200, body: { messages: [] } })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "turn 1", "2026-07-07T00:00:00Z");
  await adapter.ingestTurn("s1", "user", "turn 2", "2026-07-07T00:01:00Z");
  const agentCreations = ff.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/v1/agents/"),
  ).length;
  assert.equal(agentCreations, 1);
  assert.equal(ff.countRequests("POST", "/messages"), 2);
});

test("letta: recall reads memory blocks and skips persona", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", { status: 200, body: { id: "agent-1" } })
    .when("GET", "/core-memory/blocks", {
      status: 200,
      body: [
        { label: "human", value: "Works at Acme Corp.\nLives in Austin.\nLikes hiking." },
        { label: "persona", value: "You are a test agent." },
      ],
    })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  const recalled = await adapter.recall("workplace", "s1");
  assert.deepEqual(recalled, ["Works at Acme Corp.", "Lives in Austin.", "Likes hiking."]);
});

test("letta: recall handles {blocks: [...]} response shape", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", { status: 200, body: { id: "agent-1" } })
    .when("GET", "/core-memory/blocks", {
      status: 200,
      body: {
        blocks: [{ label: "human", text: "Single fact" }],
      },
    })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  const recalled = await adapter.recall("q", "s1");
  assert.deepEqual(recalled, ["Single fact"]);
});

test("letta: recall returns [] on empty blocks", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", { status: 200, body: { id: "agent-1" } })
    .when("GET", "/core-memory/blocks", { status: 200, body: [] })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  const recalled = await adapter.recall("q", "s1");
  assert.deepEqual(recalled, []);
});

test("letta: correct() sends a user message", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", { status: 200, body: { id: "agent-1" } })
    .when("POST", "/messages", { status: 200, body: { messages: [] } })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  await adapter.correct("Correction: now at Globex.", "s1");
  ff.assertRequest("POST", "/messages", (req) => {
    assert.deepEqual(req.body, {
      messages: [{ role: "user", content: "Correction: now at Globex." }],
    });
  });
});

test("letta: reset() deletes known agents", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", { status: 200, body: { id: "agent-1" } })
    .when("POST", "/messages", { status: 200, body: { messages: [] } })
    .when("DELETE", "/v1/agents/", { status: 204 })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z");
  await adapter.reset();
  assert.equal(ff.countRequests("DELETE", "/v1/agents/"), 1);
  // Agent re-created on next ingest.
  await adapter.ingestTurn("s1", "user", "again", "2026-07-07T00:01:00Z");
  const postResetCreations = ff.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/v1/agents/"),
  ).length;
  assert.equal(postResetCreations, 2);
});

test("letta: runMaintenance is a no-op", async () => {
  const ff = new FakeFetchBuilder().build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  await adapter.runMaintenance();
  assert.equal(ff.requests.length, 0);
});

test("letta: agent creation failure surfaces error", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", { status: 400, body: { detail: "bad model" } })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "bad-model",
    fetch: ff.fetch,
  });
  await assert.rejects(
    () => adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z"),
    (err: unknown) => {
      assert.match((err as Error).message, /400/);
      return true;
    },
  );
});
