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
    const body = req.body as {
      name: string;
      model: string;
      agent_type: string;
      memory_blocks: unknown[];
    };
    assert.equal(body.name, "memcorrect-s1");
    assert.equal(body.model, "openai/gpt-4o");
    assert.equal(body.agent_type, "memgpt_agent");
    assert.ok(body.memory_blocks);
    assert.ok(body.memory_blocks.length >= 2);
  });
  ff.assertRequest("POST", "/messages", (req) => {
    assert.ok(req.url.includes("agent-abc-123"));
    assert.deepEqual(req.body, {
      messages: [{ role: "user", content: "I work at Acme." }],
      stream: false,
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
      stream: false,
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

// ---------------------------------------------------------------------------
// #1747 review-round-3: Letta partial-failure reset must not keep dead agents
// ---------------------------------------------------------------------------

test("letta: reset() drops successfully-deleted agents even when a later delete fails", async () => {
  // Agent-1 (s1) deletes cleanly (204); agent-2 (s2) fails (500). Without the
  // per-entry fix, s1's mapping to the now-dead agent-1 would linger and the
  // next ensureAgent for s1 would reuse the dead id instead of creating a new
  // agent.
  const ff = new FakeFetchBuilder()
    .when(
      "POST",
      "/v1/agents/",
      { status: 200, body: { id: "agent-1" } },
      { status: 200, body: { id: "agent-2" } },
      { status: 200, body: { id: "agent-3" } },
    )
    .when("POST", "/messages", { status: 200, body: { messages: [] } })
    .when(
      "DELETE",
      "/v1/agents/",
      { status: 204 },
      { status: 500, body: { detail: "server error" } },
    )
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "hello", "2026-07-07T00:00:00Z");
  await adapter.ingestTurn("s2", "user", "world", "2026-07-07T00:01:00Z");
  // reset deletes agent-1 (204 → mapping dropped), then agent-2 (500 → throws).
  await assert.rejects(() => adapter.reset(), /Letta reset could not clean/);
  // s1's mapping was removed by the successful delete, so re-ingesting s1 MUST
  // create a fresh agent rather than reuse the dead agent-1 id.
  await adapter.ingestTurn("s1", "user", "again", "2026-07-07T00:02:00Z");
  const creations = ff.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/v1/agents/"),
  ).length;
  assert.equal(creations, 3, "s1 re-created a new agent after partial reset");
  // The LAST message (the re-ingested turn) targeted agent-3, not the dead
  // agent-1 — assertRequest finds the first match, so filter to the last.
  const msgReqs = ff.requests.filter(
    (r) => r.method === "POST" && r.url.includes("/messages"),
  );
  const lastMsg = msgReqs[msgReqs.length - 1];
  assert.ok(lastMsg && lastMsg.url.includes("agent-3"), `messaged new agent, got ${lastMsg?.url}`);
});

test("letta: reset() swallows not-found (404) agent deletes without throwing", async () => {
  const ff = new FakeFetchBuilder()
    .when("POST", "/v1/agents/", { status: 200, body: { id: "agent-x" } })
    .when("POST", "/messages", { status: 200, body: { messages: [] } })
    .when("DELETE", "/v1/agents/", { status: 404, body: { detail: "not found" } })
    .build();
  const adapter = new LettaMemCorrectAdapter({
    apiKey: "k",
    baseUrl: "http://localhost:8283",
    model: "openai/gpt-4o",
    fetch: ff.fetch,
  });
  await adapter.ingestTurn("s1", "user", "hi", "2026-07-07T00:00:00Z");
  await adapter.reset(); // does not throw — agent already absent is harmless
  assert.equal(ff.countRequests("DELETE", "/v1/agents/"), 1);
});
