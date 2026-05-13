import test from "node:test";
import assert from "node:assert/strict";
import { EngramAccessHttpServer } from "../src/access-http.js";
import type { EngramAccessService } from "../src/access-service.js";

function fakeService(capture: { calls: unknown[] }): EngramAccessService {
  return {
    actionConfidence: async (request: unknown) => {
      capture.calls.push(request);
      return {
        schemaVersion: 1,
        decision: "draft",
        confidence: 0.64,
        risk: "medium",
        contextReadiness: "partial",
        attentionPolicy: "interruption_budgeting",
        principle: "A good agent should spend the user's attention carefully.",
        reasons: ["test"],
        blockers: [],
        factors: [],
        retrievedMemoryCount: 0,
        usableMemoryCount: 0,
        staleMemoryCount: 0,
        correctedMemoryCount: 0,
        scopeMismatchCount: 0,
        safeToAct: false,
      };
    },
  } as unknown as EngramAccessService;
}

test("HTTP action-confidence endpoint is authenticated and read-only", async () => {
  const capture = { calls: [] as unknown[] };
  const server = new EngramAccessHttpServer({
    service: fakeService(capture),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 4096,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const noAuth = await fetch(`${base}/remnic/v1/action-confidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confidence: 0.7 }),
    });
    assert.equal(noAuth.status, 401);

    const response = await fetch(`${base}/remnic/v1/action-confidence`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        confidence: 0.7,
        risk: "medium",
        contextReadiness: "partial",
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { decision: string; attentionPolicy: string };
    assert.equal(payload.decision, "draft");
    assert.equal(payload.attentionPolicy, "interruption_budgeting");
    assert.deepEqual(capture.calls, [
      {
        confidence: 0.7,
        risk: "medium",
        contextReadiness: "partial",
      },
    ]);
  } finally {
    await server.stop();
  }
});

test("HTTP action-confidence rejects invalid enum values", async () => {
  const capture = { calls: [] as unknown[] };
  const server = new EngramAccessHttpServer({
    service: fakeService(capture),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 4096,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/action-confidence`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ risk: "maybe" }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json() as { code: string; details: Array<{ field: string }> };
    assert.equal(payload.code, "validation_error");
    assert.equal(payload.details[0]?.field, "risk");
    assert.equal(capture.calls.length, 0);
  } finally {
    await server.stop();
  }
});

test("HTTP action-confidence treats null optional fields as absent", async () => {
  const capture = { calls: [] as unknown[] };
  const server = new EngramAccessHttpServer({
    service: fakeService(capture),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 4096,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/remnic/v1/action-confidence`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        confidence: null,
        risk: null,
        contextReadiness: null,
        currentContextScopes: null,
        userRules: [{ kind: "ask-before", description: null, matched: null }],
        retrievedMemories: [{ confidence: null, safety: null, stale: null }],
      }),
    });
    assert.equal(response.status, 200);
    const call = capture.calls[0] as {
      userRules?: Array<{ kind?: string }>;
      retrievedMemories?: Array<Record<string, unknown>>;
    };
    assert.doesNotMatch(JSON.stringify(call), /null/);
    assert.equal(call.userRules?.[0]?.kind, "ask-before");
    assert.equal(call.retrievedMemories?.[0]?.confidence, undefined);
    assert.equal(call.retrievedMemories?.[0]?.safety, undefined);
    assert.equal(call.retrievedMemories?.[0]?.stale, undefined);
  } finally {
    await server.stop();
  }
});
