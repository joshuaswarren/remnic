import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  SUPPORT_PASSPORT_MODEL_ACK_PATH,
  SUPPORT_PASSPORT_MODEL_JOB_PATH,
  SUPPORT_PASSPORT_MODEL_RESULT_PATH,
  SupportPassportModelBridge,
} from "./model-bridge.js";
import { SupportPassportDraftModelInputSchema } from "./model-contracts.js";

function startBridgeServer(bridge: SupportPassportModelBridge) {
  const server = http.createServer((req, res) => {
    void bridge.requestHandler(req, res, {
      authorized: req.headers.authorization === "Bearer owner-token",
      tokenAuthorized:
        req.headers.authorization === "Bearer owner-token" || req.headers.authorization === "Bearer scoped-token",
      ...(req.headers.authorization === "Bearer scoped-token"
        ? { capabilities: { version: 1 as const, ops: ["recall"] } }
        : {}),
    });
  });
  return new Promise<{ origin: string; close(): Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const messages = [
  { role: "system" as const, content: "Return JSON." },
  { role: "user" as const, content: JSON.stringify({ sourceNotes: [{ memoryId: "memory-1" }] }) },
];

async function announceWorker(origin: string): Promise<void> {
  const response = await fetch(`${origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
    method: "POST",
    headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
    body: JSON.stringify({ timeoutMs: 0 }),
  });
  assert.equal(response.status, 204);
}

test("the model bridge moves a provider-neutral job through authenticated memory only", async () => {
  const bridge = new SupportPassportModelBridge();
  const server = await startBridgeServer(bridge);
  const controller = new AbortController();
  try {
    await announceWorker(server.origin);
    const resultPromise = bridge.route.invoke(messages, {
      temperature: 0.2,
      maxTokens: 500,
      timeoutMs: 5_000,
      signal: controller.signal,
      operation: "support-passport-draft",
      jsonSchema: { name: "drafts", schema: { type: "object" } },
    });
    const jobResponse = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 0 }),
    });
    assert.equal(jobResponse.status, 200);
    const job = (await jobResponse.json()) as { id: string; messages: unknown; timeoutMs: number };
    assert.deepEqual(job.messages, messages);
    assert.ok(job.timeoutMs > 0);
    assert.ok(job.timeoutMs <= 5_000);
    assert.equal("deadlineAt" in job, false);

    const completion = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_RESULT_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: job.id,
        result: { content: '{"cards":[]}', modelUsed: "gateway/test" },
      }),
    });
    assert.equal(completion.status, 204);
    assert.deepEqual(await resultPromise, {
      content: '{"cards":[]}',
      modelUsed: "gateway/test",
    });
  } finally {
    controller.abort();
    bridge.close();
    await server.close();
  }
});

test("the model bridge accepts the maximum JSON-escaped valid draft payload", async () => {
  const bridge = new SupportPassportModelBridge();
  const server = await startBridgeServer(bridge);
  const controller = new AbortController();
  try {
    const draft = SupportPassportDraftModelInputSchema.parse({
      consent: true,
      memories: Array.from({ length: 20 }, (_, index) => ({
        memoryId: `${"\0".repeat(510)}${String(index).padStart(2, "0")}`,
        content: "\0".repeat(5_000),
      })),
    });
    const escapedMessages = [
      { role: "system" as const, content: "Return JSON." },
      { role: "user" as const, content: JSON.stringify({ sourceNotes: draft.memories }) },
    ];
    assert.ok(escapedMessages[1].content.length > 600_000);
    await announceWorker(server.origin);

    const resultPromise = bridge.route.invoke(escapedMessages, {
      temperature: 0.2,
      maxTokens: 500,
      timeoutMs: 5_000,
      signal: controller.signal,
      operation: "support-passport-draft",
      jsonSchema: { name: "drafts", schema: { type: "object" } },
    });
    const jobResponse = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 0 }),
    });

    assert.equal(jobResponse.status, 200);
    const job = (await jobResponse.json()) as { messages: unknown };
    assert.deepEqual(job.messages, escapedMessages);
    controller.abort();
    assert.equal(await resultPromise, null);
  } finally {
    controller.abort();
    bridge.close();
    await server.close();
  }
});

test("the model bridge rejects missing and scoped operator credentials", async () => {
  const bridge = new SupportPassportModelBridge();
  const server = await startBridgeServer(bridge);
  try {
    const request = (authorization?: string) =>
      fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
        method: "POST",
        headers: {
          ...(authorization ? { authorization } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ timeoutMs: 0 }),
      });
    assert.equal((await request()).status, 401);
    assert.equal((await request("Bearer scoped-token")).status, 403);
  } finally {
    bridge.close();
    await server.close();
  }
});

test("an aborted model caller removes its queued job", async () => {
  const bridge = new SupportPassportModelBridge();
  const server = await startBridgeServer(bridge);
  const controller = new AbortController();
  try {
    await announceWorker(server.origin);
    const resultPromise = bridge.route.invoke(messages, {
      temperature: 0,
      maxTokens: 500,
      timeoutMs: 5_000,
      signal: controller.signal,
      operation: "support-passport-draft",
      jsonSchema: { name: "drafts", schema: { type: "object" } },
    });
    controller.abort();
    assert.equal(await resultPromise, null);
    const response = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 0 }),
    });
    assert.equal(response.status, 204);
  } finally {
    bridge.close();
    await server.close();
  }
});

test("an unclaimed model job expires without relying on the caller's wrapper", async () => {
  const bridge = new SupportPassportModelBridge();
  const server = await startBridgeServer(bridge);
  const started = Date.now();
  try {
    await announceWorker(server.origin);
    const result = await bridge.route.invoke(messages, {
      temperature: 0,
      maxTokens: 500,
      timeoutMs: 20,
      operation: "support-passport-draft",
      jsonSchema: { name: "drafts", schema: { type: "object" } },
    });
    assert.equal(result, null);
    assert.ok(Date.now() - started < 1_000);
  } finally {
    bridge.close();
    await server.close();
  }
});

test("an unacknowledged leased job becomes available to another worker", async () => {
  const bridge = new SupportPassportModelBridge({ claimAckTimeoutMs: 20 });
  const server = await startBridgeServer(bridge);
  const controller = new AbortController();
  try {
    await announceWorker(server.origin);
    const resultPromise = bridge.route.invoke(messages, {
      temperature: 0,
      maxTokens: 500,
      timeoutMs: 5_000,
      signal: controller.signal,
      operation: "support-passport-draft",
      jsonSchema: { name: "drafts", schema: { type: "object" } },
    });
    const poll = () =>
      fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
        body: JSON.stringify({ timeoutMs: 100, claimLease: true }),
      });
    const firstResponse = await poll();
    assert.equal(firstResponse.status, 200);
    const first = (await firstResponse.json()) as { id: string; claimId: string; claimAckTimeoutMs: number };
    assert.equal(first.claimAckTimeoutMs, 20);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const secondResponse = await poll();
    assert.equal(secondResponse.status, 200);
    const second = (await secondResponse.json()) as { id: string; claimId: string };
    assert.equal(second.id, first.id);
    assert.notEqual(second.claimId, first.claimId);

    const staleAck = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_ACK_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ id: first.id, claimId: first.claimId }),
    });
    assert.equal(staleAck.status, 404);
    const currentAck = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_ACK_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ id: second.id, claimId: second.claimId }),
    });
    assert.equal(currentAck.status, 204);

    const completion = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_RESULT_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: second.id,
        claimId: second.claimId,
        result: { content: "{}", modelUsed: "gateway/local" },
      }),
    });
    assert.equal(completion.status, 204);
    assert.deepEqual(await resultPromise, { content: "{}", modelUsed: "gateway/local" });
  } finally {
    controller.abort();
    bridge.close();
    await server.close();
  }
});

test("an acknowledged leased job is requeued when its worker stops renewing", async () => {
  const bridge = new SupportPassportModelBridge({ claimAckTimeoutMs: 100, executionLeaseTimeoutMs: 30 });
  const server = await startBridgeServer(bridge);
  const controller = new AbortController();
  try {
    await announceWorker(server.origin);
    const resultPromise = bridge.route.invoke(messages, {
      temperature: 0,
      maxTokens: 500,
      timeoutMs: 5_000,
      signal: controller.signal,
      operation: "support-passport-draft",
      jsonSchema: { name: "drafts", schema: { type: "object" } },
    });
    const poll = () =>
      fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
        body: JSON.stringify({ timeoutMs: 100, claimLease: true }),
      });
    const firstResponse = await poll();
    assert.equal(firstResponse.status, 200);
    const first = (await firstResponse.json()) as {
      id: string;
      claimId: string;
      executionLeaseTimeoutMs: number;
    };
    assert.equal(first.executionLeaseTimeoutMs, 30);

    const acknowledgement = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_ACK_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ id: first.id, claimId: first.claimId }),
    });
    assert.equal(acknowledgement.status, 204);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondResponse = await poll();
    assert.equal(secondResponse.status, 200);
    const second = (await secondResponse.json()) as { id: string; claimId: string };
    assert.equal(second.id, first.id);
    assert.notEqual(second.claimId, first.claimId);

    const staleResult = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_RESULT_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: first.id,
        claimId: first.claimId,
        result: { content: "{}", modelUsed: "stale-worker" },
      }),
    });
    assert.equal(staleResult.status, 404);

    const completion = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_RESULT_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: second.id,
        claimId: second.claimId,
        result: { content: "{}", modelUsed: "gateway/local" },
      }),
    });
    assert.equal(completion.status, 204);
    assert.deepEqual(await resultPromise, { content: "{}", modelUsed: "gateway/local" });
  } finally {
    controller.abort();
    bridge.close();
    await server.close();
  }
});

test("an empty long poll keeps the bridge available during worker handoff", async () => {
  const bridge = new SupportPassportModelBridge();
  const server = await startBridgeServer(bridge);
  const controller = new AbortController();
  try {
    const emptyPoll = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 1_100 }),
    });
    assert.equal(emptyPoll.status, 204);

    const resultPromise = bridge.route.invoke(messages, {
      temperature: 0,
      maxTokens: 500,
      timeoutMs: 5_000,
      signal: controller.signal,
      operation: "support-passport-draft",
      jsonSchema: { name: "drafts", schema: { type: "object" } },
    });
    const jobResponse = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 0 }),
    });
    assert.equal(jobResponse.status, 200);
    const job = (await jobResponse.json()) as { id: string };

    const completion = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_RESULT_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: job.id,
        result: { content: "{}", modelUsed: "gateway/local" },
      }),
    });
    assert.equal(completion.status, 204);
    assert.deepEqual(await resultPromise, { content: "{}", modelUsed: "gateway/local" });
  } finally {
    controller.abort();
    bridge.close();
    await server.close();
  }
});

test("a completed job keeps the bridge available until its worker polls again", async () => {
  const bridge = new SupportPassportModelBridge();
  const server = await startBridgeServer(bridge);
  const controller = new AbortController();
  const invoke = () =>
    bridge.route.invoke(messages, {
      temperature: 0,
      maxTokens: 500,
      timeoutMs: 5_000,
      signal: controller.signal,
      operation: "support-passport-draft",
      jsonSchema: { name: "drafts", schema: { type: "object" } },
    });
  const poll = () =>
    fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 0 }),
    });
  const complete = (id: string, content: string) =>
    fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_RESULT_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ id, result: { content, modelUsed: "gateway/local" } }),
    });
  try {
    await announceWorker(server.origin);
    const firstResult = invoke();
    const firstResponse = await poll();
    assert.equal(firstResponse.status, 200);
    const first = (await firstResponse.json()) as { id: string };
    (bridge as unknown as { lastConsumerPollAt: number }).lastConsumerPollAt = 0;
    assert.equal((await complete(first.id, '{"first":true}')).status, 204);
    assert.deepEqual(await firstResult, { content: '{"first":true}', modelUsed: "gateway/local" });

    const secondResult = invoke();
    const secondResponse = await poll();
    assert.equal(secondResponse.status, 200);
    const second = (await secondResponse.json()) as { id: string };
    assert.equal((await complete(second.id, '{"second":true}')).status, 204);
    assert.deepEqual(await secondResult, { content: '{"second":true}', modelUsed: "gateway/local" });
  } finally {
    controller.abort();
    bridge.close();
    await server.close();
  }
});

test("a closed model bridge tells pollers to back off", async () => {
  const bridge = new SupportPassportModelBridge();
  const server = await startBridgeServer(bridge);
  try {
    bridge.close();
    const response = await fetch(`${server.origin}${SUPPORT_PASSPORT_MODEL_JOB_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 20_000, claimLease: true }),
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: "bridge_closed", code: "bridge_closed" });
  } finally {
    bridge.close();
    await server.close();
  }
});
