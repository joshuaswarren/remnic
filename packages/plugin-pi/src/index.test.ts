import assert from "node:assert/strict";
import test from "node:test";

import { buildCompactionSummary, createRemnicPiExtension, observeMessages, stripSessionOwnedSchemaFields } from "./index.js";
import type { RemnicPiConfig } from "./config.js";

test("stripSessionOwnedSchemaFields hides session routing fields from Pi tools", () => {
  const schema = stripSessionOwnedSchemaFields({
    type: "object",
    properties: {
      sessionKey: { type: "string" },
      namespace: { type: "string" },
      cwd: { type: "string" },
      query: { type: "string" },
    },
    required: ["sessionKey", "query"],
    additionalProperties: false,
  });

  assert.deepEqual(schema.properties, {
    query: { type: "string" },
  });
  assert.deepEqual(schema.required, ["query"]);
  assert.equal(schema.additionalProperties, false);
});

test("observeMessages only records dedupe hashes after a successful observe", async () => {
  const observedHashes = new Set<string>();
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "retry-test" },
  };
  let calls = 0;
  const client: { observe: () => Promise<void> } = {
    observe: async () => {
      calls += 1;
      throw new Error("offline");
    },
  };

  await observeMessages(ctx, client as any, [{ role: "user", content: "same prompt" }], observedHashes);

  assert.equal(calls, 1);
  assert.equal(observedHashes.size, 0);

  client.observe = async () => {
    calls += 1;
  };

  await observeMessages(ctx, client as any, [{ role: "user", content: "same prompt" }], observedHashes);
  await observeMessages(ctx, client as any, [{ role: "user", content: "same prompt" }], observedHashes);

  assert.equal(calls, 2);
  assert.equal(observedHashes.size, 1);
});

test("observeMessages caps persisted dedupe hashes during long sessions", async () => {
  const observedHashes = new Set<string>();
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "cap-test" },
  };
  const client: { observe: () => Promise<void> } = {
    observe: async () => undefined,
  };

  for (let index = 0; index < 2005; index++) {
    await observeMessages(ctx, client as any, [{ role: "user", content: `message ${index}` }], observedHashes);
  }

  assert.equal(observedHashes.size, 2000);
});

test("buildCompactionSummary returns empty content for empty compaction preparations", () => {
  assert.equal(buildCompactionSummary({}), "");
});

test("buildCompactionSummary includes only meaningful compaction content", () => {
  const summary = buildCompactionSummary({
    messagesToSummarize: [
      { role: "user", content: "keep this" },
      { role: "bashExecution", command: "private", output: "secret", excludeFromContext: true },
    ],
  });

  assert.ok(summary.includes("## Remnic Pi Context Checkpoint"));
  assert.ok(summary.includes("[user] keep this"));
  assert.equal(summary.includes("private"), false);
  assert.equal(summary.includes("secret"), false);
});

test("singleton extension clears per-session recall suppression on shutdown", async (t) => {
  const originalFetch = globalThis.fetch;
  const recallBodies: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    recallBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ context: "remembered context" }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as any);

  const firstCtx = { cwd: "/tmp/remnic-pi" };
  const secondCtx = { cwd: "/tmp/remnic-pi" };
  const event = { messages: [{ role: "user", content: "same prompt" }] };

  await emit("context", event, firstCtx);
  await emit("context", event, firstCtx);
  await emit("session_shutdown", {}, firstCtx);
  await emit("context", event, secondCtx);

  assert.equal(recallBodies.length, 2);
});

test("failed recall does not suppress retry for same query", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return new Response(JSON.stringify({ context: "remembered context" }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as any);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "retry-recall" },
  };
  const event = { messages: [{ role: "user", content: "same prompt" }] };

  await emit("context", event, ctx);
  await emit("context", event, ctx);
  await emit("context", event, ctx);

  assert.equal(calls, 2);
});

function baseConfig(): RemnicPiConfig {
  return {
    remnicDaemonUrl: "http://127.0.0.1:4318",
    recallMode: "auto",
    recallTopK: 8,
    recallBudgetChars: 12000,
    recallEnabled: true,
    observeEnabled: true,
    observeSkipExtraction: false,
    compactionEnabled: true,
    mcpToolsEnabled: true,
    statusEnabled: true,
    requestTimeoutMs: 5000,
  };
}

function makePiHarness(): {
  pi: Record<string, unknown>;
  emit: (event: string, payload: unknown, ctx: unknown) => Promise<unknown>;
} {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    appendEntry: () => undefined,
  };
  return {
    pi,
    emit: async (event, payload, ctx) => {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(payload, ctx);
      }
      return result;
    },
  };
}
