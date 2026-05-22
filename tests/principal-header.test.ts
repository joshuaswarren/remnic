import test from "node:test";
import assert from "node:assert/strict";
import { EngramAccessHttpServer } from "../src/access-http.js";
import type { EngramAccessService } from "../src/access-service.js";

/**
 * Creates a fake EngramAccessService that captures the authenticatedPrincipal
 * passed to memoryStore calls, so we can assert which principal was resolved.
 */
function createFakeService(capturedPrincipals: (string | undefined)[]): EngramAccessService {
  return {
    health: async () => ({
      ok: true,
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledgeEnabled: false,
      projectionAvailable: true,
    }),
    recall: async () => ({ query: "", context: "", count: 0, memoryIds: [], results: [], recordedAt: "", traceId: "", plannerMode: "full", fallbackUsed: false, sourcesUsed: [], budgetsApplied: { appliedTopK: 0, recallBudgetChars: 0, maxMemoryTokens: 0 }, latencyMs: 0 }),
    recallExplain: async () => ({ found: false, snapshot: null, intent: null, graph: null }),
    memoryGet: async () => ({ found: false, namespace: "global" }),
    memoryTimeline: async () => ({ found: false, namespace: "global", count: 0, timeline: [] }),
    memoryBrowse: async () => ({ namespace: "global", sort: "updated_desc", total: 0, count: 0, limit: 50, offset: 0, memories: [] }),
    entityList: async () => ({ namespace: "global", total: 0, count: 0, limit: 50, offset: 0, entities: [] }),
    entityGet: async () => ({ found: false, namespace: "global" }),
    reviewQueue: async () => ({ found: false }),
    peekMemoryStoreIdempotency: async () => "miss",
    peekSuggestionSubmitIdempotency: async () => "miss",
    memoryStore: async (request: { authenticatedPrincipal?: string }) => {
      capturedPrincipals.push(request.authenticatedPrincipal);
      return {
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "global",
        dryRun: false,
        accepted: true,
        queued: false,
        status: "stored",
        memoryId: "fact-new",
      };
    },
    suggestionSubmit: async () => ({
      schemaVersion: 1,
      operation: "suggestion_submit",
      namespace: "global",
      dryRun: false,
      accepted: true,
      queued: true,
      status: "queued_for_review",
      memoryId: "fact-review",
    }),
    maintenance: async () => ({ health: { ok: true, memoryDir: "/tmp", namespacesEnabled: true, defaultNamespace: "global", searchBackend: "qmd", qmdEnabled: true, nativeKnowledgeEnabled: false, projectionAvailable: true }, latestGovernanceRun: { found: false } }),
    quality: async () => ({ namespace: "global", totalMemories: 0, statusCounts: {}, categoryCounts: {}, confidenceTierCounts: {}, ageBucketCounts: {}, archivePressure: { pendingReview: 0, quarantined: 0, archived: 0, staleActive: 0, lowConfidenceActive: 0 }, latestGovernanceRun: { found: false } }),
    reviewDisposition: async () => ({ ok: true, namespace: "global", memoryId: "m1", status: "active", previousStatus: "pending_review" }),
  } as unknown as EngramAccessService;
}

const AUTH_TOKEN = "test-token-principal-header";

test("trustPrincipalHeader=false (default): X-Engram-Principal header is ignored, uses constructor principal", async () => {
  const captured: (string | undefined)[] = [];
  const server = new EngramAccessHttpServer({
    service: createFakeService(captured),
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
    principal: "constructor-principal",
    // trustPrincipalHeader not set — defaults to false
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const res = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
        "X-Engram-Principal": "agent-override",
      },
      body: JSON.stringify({ content: "test memory", category: "fact" }),
    });
    assert.equal(res.status, 201);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], "constructor-principal", "should use constructor principal when trustPrincipalHeader is false");
  } finally {
    await server.stop();
  }
});

test("trustPrincipalHeader=false: adapter detection cannot trust X-Engram-Principal", async () => {
  const captured: (string | undefined)[] = [];
  const server = new EngramAccessHttpServer({
    service: createFakeService(captured),
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
    principal: "constructor-principal",
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const res = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
        "X-Engram-Client-Id": "codex",
        "X-Engram-Principal": "agent-override",
      },
      body: JSON.stringify({ content: "test memory", category: "fact" }),
    });
    assert.equal(res.status, 201);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], "constructor-principal");
  } finally {
    await server.stop();
  }
});

test("trustPrincipalHeader=true: X-Engram-Principal header value is used as principal", async () => {
  const captured: (string | undefined)[] = [];
  const server = new EngramAccessHttpServer({
    service: createFakeService(captured),
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
    principal: "constructor-principal",
    trustPrincipalHeader: true,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const res = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
        "X-Engram-Principal": "agent-override",
      },
      body: JSON.stringify({ content: "test memory", category: "fact" }),
    });
    assert.equal(res.status, 201);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], "agent-override", "should use X-Engram-Principal header value when trusted");
  } finally {
    await server.stop();
  }
});

test("trustPrincipalHeader=true but header missing: falls back to constructor principal", async () => {
  const captured: (string | undefined)[] = [];
  const server = new EngramAccessHttpServer({
    service: createFakeService(captured),
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
    principal: "constructor-principal",
    trustPrincipalHeader: true,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const res = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
        // No X-Engram-Principal header
      },
      body: JSON.stringify({ content: "test memory", category: "fact" }),
    });
    assert.equal(res.status, 201);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], "constructor-principal", "should fall back to constructor principal when header is missing");
  } finally {
    await server.stop();
  }
});

test("trustPrincipalHeader=true and header is empty string: falls back to constructor principal", async () => {
  const captured: (string | undefined)[] = [];
  const server = new EngramAccessHttpServer({
    service: createFakeService(captured),
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
    principal: "constructor-principal",
    trustPrincipalHeader: true,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const res = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
        "X-Engram-Principal": "",
      },
      body: JSON.stringify({ content: "test memory", category: "fact" }),
    });
    assert.equal(res.status, 201);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], "constructor-principal", "should fall back to constructor principal when header is empty");
  } finally {
    await server.stop();
  }
});

test("trustPrincipalHeader=true: header value is trimmed", async () => {
  const captured: (string | undefined)[] = [];
  const server = new EngramAccessHttpServer({
    service: createFakeService(captured),
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
    principal: "constructor-principal",
    trustPrincipalHeader: true,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const res = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
        "X-Engram-Principal": "  agent-trimmed  ",
      },
      body: JSON.stringify({ content: "test memory", category: "fact" }),
    });
    assert.equal(res.status, 201);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], "agent-trimmed", "should trim whitespace from header value");
  } finally {
    await server.stop();
  }
});
