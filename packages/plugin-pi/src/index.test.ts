import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Kind } from "@sinclair/typebox";

import remnicPiExtension, {
  buildCompactionSummary,
  createRemnicPiExtension,
  observeMessages,
  stripSessionOwnedSchemaFields,
  stripSessionOwnedRuntimeFields,
  toPiToolParametersSchema,
} from "./index.js";
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

test("stripSessionOwnedSchemaFields hides nested session routing fields from Pi tools", () => {
  const schema = stripSessionOwnedSchemaFields({
    type: "object",
    properties: {
      filter: {
        type: "object",
        properties: {
          sessionKey: { type: "string" },
          namespace: { type: "string" },
          cwd: { type: "string" },
          query: { type: "string" },
        },
        required: ["sessionKey", "namespace", "cwd", "query"],
      },
    },
    required: ["filter"],
  });

  assert.deepEqual(schema, {
    type: "object",
    properties: {
      filter: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    required: ["filter"],
  });
});

test("stripSessionOwnedRuntimeFields removes nested session routing values", () => {
  assert.deepEqual(
    stripSessionOwnedRuntimeFields({
      query: "keep",
      cwd: "/attacker",
      filter: {
        sessionKey: "attacker",
        namespace: "attacker",
        keep: true,
        nested: [{ cwd: "/other", value: 1 }],
      },
    }),
    {
      query: "keep",
      filter: {
        keep: true,
        nested: [{ value: 1 }],
      },
    },
  );
});

test("toPiToolParametersSchema wraps stripped MCP schemas as TypeBox schemas", () => {
  const schema = toPiToolParametersSchema({
    type: "object",
    properties: {
      sessionKey: { type: "string" },
      namespace: { type: "string" },
      cwd: { type: "string" },
      query: { type: "string" },
    },
    required: ["sessionKey", "query"],
    additionalProperties: false,
  }) as any;

  assert.equal(schema[Kind], "Unsafe");
  assert.deepEqual(schema.properties, {
    query: { type: "string" },
  });
  assert.deepEqual(schema.required, ["query"]);
  assert.equal(schema.additionalProperties, false);
});

test("module import does not load the default Pi config eagerly", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-import-"));
  const configPath = path.join(root, "remnic.config.json");
  const previousConfig = process.env.REMNIC_PI_CONFIG;
  try {
    fs.writeFileSync(configPath, "{not-json");
    process.env.REMNIC_PI_CONFIG = configPath;

    const moduleUrl = new URL(`./index.ts?bad-config-import=${Date.now()}`, import.meta.url).href;
    const mod = await import(moduleUrl);

    assert.equal(typeof mod.createRemnicPiExtension, "function");
    assert.equal(typeof mod.default, "function");
  } finally {
    if (previousConfig === undefined) {
      delete process.env.REMNIC_PI_CONFIG;
    } else {
      process.env.REMNIC_PI_CONFIG = previousConfig;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default Pi extension creates isolated state for each host invocation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-default-isolation-"));
  const configPath = path.join(root, "remnic.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    authToken: "test-token",
    observeEnabled: false,
    compactionEnabled: false,
    mcpToolsEnabled: false,
    statusEnabled: false,
  }));

  const previousConfig = process.env.REMNIC_PI_CONFIG;
  const originalFetch = globalThis.fetch;
  const recallBodies: unknown[] = [];
  process.env.REMNIC_PI_CONFIG = configPath;
  globalThis.fetch = async (_input, init) => {
    recallBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ context: "remembered context" }), { status: 200 });
  };
  t.after(() => {
    if (previousConfig === undefined) delete process.env.REMNIC_PI_CONFIG;
    else process.env.REMNIC_PI_CONFIG = previousConfig;
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = makePiHarness();
  const second = makePiHarness();
  await remnicPiExtension(first.pi as any);
  await remnicPiExtension(second.pi as any);

  const event = { messages: [{ role: "user", content: "same prompt" }] };
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "shared-session" },
  };

  await first.emit("context", event, ctx);
  await second.emit("context", event, ctx);

  assert.equal(recallBodies.length, 2);
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

  await observeMessages(ctx, client as any, [{ id: "same-1", role: "user", content: "same prompt" }], observedHashes);

  assert.equal(calls, 1);
  assert.equal(observedHashes.size, 0);

  client.observe = async () => {
    calls += 1;
  };

  await observeMessages(ctx, client as any, [{ id: "same-1", role: "user", content: "same prompt" }], observedHashes);
  await observeMessages(ctx, client as any, [{ id: "same-1", role: "user", content: "same prompt" }], observedHashes);

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
    await observeMessages(ctx, client as any, [{ id: `message-${index}`, role: "user", content: `message ${index}` }], observedHashes);
  }

  assert.equal(observedHashes.size, 2000);
});

test("observeMessages preserves repeated turns without stable Pi identity", async () => {
  const observedHashes = new Set<string>();
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "repeat-test" },
  };
  const batches: unknown[][] = [];
  const client: { observe: (_sessionKey: string, _cwd: string, messages: unknown[]) => Promise<void> } = {
    observe: async (_sessionKey, _cwd, messages) => {
      batches.push(messages);
    },
  };

  await observeMessages(ctx, client as any, [{ role: "user", content: "yes" }], observedHashes);
  await observeMessages(ctx, client as any, [{ role: "user", content: "yes" }], observedHashes);

  assert.equal(batches.length, 2);
  assert.equal(observedHashes.size, 0);
});

test("observeMessages preserves repeated multi-message turns without stable Pi identity", async () => {
  const observedHashes = new Set<string>();
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "repeat-multi-message-test" },
  };
  const batches: unknown[][] = [];
  const client: { observe: (_sessionKey: string, _cwd: string, messages: unknown[]) => Promise<void> } = {
    observe: async (_sessionKey, _cwd, messages) => {
      batches.push(messages);
    },
  };
  const turn = [
    { role: "assistant", content: "done" },
    { role: "bashExecution", command: "npm test", output: "passed" },
  ];

  await observeMessages(ctx, client as any, turn, observedHashes);
  await observeMessages(ctx, client as any, turn, observedHashes);

  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2]);
  assert.equal(observedHashes.size, 0);
});

test("observeMessages dedupes replayed Pi entries with stable identity", async () => {
  const observedHashes = new Set<string>();
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "entry-test" },
  };
  let calls = 0;
  const client: { observe: () => Promise<void> } = {
    observe: async () => {
      calls += 1;
    },
  };
  const raw = [{ id: "entry-1", role: "user", content: "yes" }];

  await observeMessages(ctx, client as any, raw, observedHashes);
  await observeMessages(ctx, client as any, raw, observedHashes);

  assert.equal(calls, 1);
  assert.equal(observedHashes.size, 1);
});

test("session_shutdown preserves Pi branch entry identity before observing", async (t) => {
  const originalFetch = globalThis.fetch;
  const observeBodies: Array<Record<string, any>> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/observe")) {
      observeBodies.push(JSON.parse(String(init?.body ?? "{}")));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as any);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: {
      getSessionId: () => "branch-entry-test",
      getEntries: () => [],
      getBranch: () => [
        {
          id: "entry-1",
          timestamp: 1710000000000,
          message: { role: "user", content: "remember this" },
        },
      ],
    },
  };

  await emit("session_shutdown", {}, ctx);

  assert.equal(observeBodies.length, 1);
  const rawContent = observeBodies[0].messages?.[0]?.rawContent as Record<string, unknown>;
  assert.equal(rawContent.entryId, "entry-1");
  assert.equal(rawContent.timestamp, 1710000000000);
});

test("session_shutdown skips branch messages already observed at turn_end", async (t) => {
  const originalFetch = globalThis.fetch;
  const observeBodies: Array<Record<string, any>> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/observe")) {
      observeBodies.push(JSON.parse(String(init?.body ?? "{}")));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as any);

  const message = { role: "assistant", content: "done" };
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: {
      getSessionId: () => "shutdown-live-observed-test",
      getEntries: () => [],
      getBranch: () => [{ id: "entry-1", message }],
    },
  };

  await emit("turn_end", { message }, ctx);
  await emit("session_shutdown", {}, ctx);

  assert.equal(observeBodies.length, 1);
  assert.equal(observeBodies[0].messages?.[0]?.rawContent?.entryId, undefined);
});

test("message_end observes user prompts before shutdown replay", async (t) => {
  const originalFetch = globalThis.fetch;
  const observeBodies: Array<Record<string, any>> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/observe")) {
      observeBodies.push(JSON.parse(String(init?.body ?? "{}")));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as any);

  const message = { role: "user", content: "remember my preference" };
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: {
      getSessionId: () => "message-end-live-observed-test",
      getEntries: () => [],
      getBranch: () => [{ id: "entry-1", message }],
    },
  };

  await emit("message_end", { message }, ctx);
  await emit("session_shutdown", {}, ctx);

  assert.equal(observeBodies.length, 1);
  assert.equal(observeBodies[0].messages?.[0]?.content, "remember my preference");
});

test("agent_end does not duplicate turn_end observation", async (t) => {
  const originalFetch = globalThis.fetch;
  const observeBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/observe")) {
      observeBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as any);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "agent-end-duplicate-test" },
  };
  const message = { role: "assistant", content: "done" };

  await emit("turn_end", { message }, ctx);
  await emit("agent_end", { messages: [message] }, ctx);

  assert.equal(observeBodies.length, 1);
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

test("session_before_compact records token counts only when Pi supplies both counts", async (t) => {
  const originalFetch = globalThis.fetch;
  const compactionRecords: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/engram/v1/lcm/compaction/record")) {
      compactionRecords.push(body);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      observeEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as any);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "compact-token-count-test" },
  };
  const messagesToSummarize = [{ role: "user", content: "compact this" }];

  await emit("session_before_compact", { preparation: { tokensBefore: 100, messagesToSummarize } }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(compactionRecords.length, 0);

  await emit("session_before_compact", { preparation: { tokensBefore: 100, tokensAfter: 42 } }, ctx);
  assert.equal(compactionRecords.length, 1);
  assert.equal(compactionRecords[0].tokensBefore, 100);
  assert.equal(compactionRecords[0].tokensAfter, 42);
});

test("session_before_compact surfaces checkpoint write failures without dropping compaction result", async (t) => {
  const originalFetch = globalThis.fetch;
  const notifications: Array<{ message: string; level: string }> = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/mcp")) {
      return new Response(JSON.stringify({ error: { message: "checkpoint unavailable" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      observeEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as any);

  const result = await emit(
    "session_before_compact",
    {
      preparation: {
        tokensBefore: 100,
        tokensAfter: 42,
        messagesToSummarize: [{ role: "user", content: "compact this" }],
      },
    },
    {
      cwd: "/tmp/remnic-pi",
      sessionManager: { getSessionId: () => "compact-checkpoint-failure-test" },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  );

  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.ok(
    notifications.some(
      (notification) =>
        notification.level === "warning" &&
        notification.message.includes("Remnic context checkpoint failed"),
    ),
  );
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

test("recall suppression distinguishes repeated user text with different message ids", async (t) => {
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

  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "repeat-user-text-recall" },
  };

  await emit("context", { messages: [{ id: "m1", role: "user", content: "continue" }] }, ctx);
  await emit("context", { messages: [{ id: "m2", role: "user", content: "continue" }] }, ctx);
  await emit("context", { messages: [{ id: "m2", role: "user", content: "continue" }] }, ctx);

  assert.equal(recallBodies.length, 2);
});

test("empty recall responses do not suppress retry for same query", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ context: calls === 1 ? "" : "remembered context" }), { status: 200 });
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
    sessionManager: { getSessionId: () => "empty-recall-retry" },
  };
  const event = { messages: [{ role: "user", content: "same prompt" }] };

  assert.equal(await emit("context", event, ctx), undefined);
  const result = await emit("context", event, ctx) as { messages?: Array<{ content?: Array<{ text?: string }> }> };

  assert.equal(calls, 2);
  assert.ok(result.messages?.[0]?.content?.[0]?.text?.includes("remembered context"));
  assert.equal(
    (result.messages?.[0] as { excludeFromContext?: unknown } | undefined)?.excludeFromContext,
    undefined,
  );
  assert.equal(
    (result.messages?.[0] as { remnicInjected?: unknown } | undefined)?.remnicInjected,
    true,
  );
});

test("recall context truncation stays within the configured budget", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ context: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" }), { status: 200 });
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
      recallBudgetChars: 40,
    },
  });
  await extension(pi as any);

  const result = await emit("context", { messages: [{ role: "user", content: "same prompt" }] }, {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "recall-budget-test" },
  }) as { messages?: Array<{ content?: Array<{ text?: string }> }> };

  const text = result.messages?.[0]?.content?.[0]?.text ?? "";
  const context = text.split("Remnic recalled context for this turn:\n\n")[1] ?? "";
  assert.equal(context.length, 40);
  assert.ok(context.endsWith("[Remnic context truncated]"));
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

test("registered MCP tools strip nested session-owned params before forwarding", async (t) => {
  const originalFetch = globalThis.fetch;
  const registeredTools: any[] = [];
  const forwardedArguments: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.method === "tools/list") {
      return new Response(JSON.stringify({
        result: {
          tools: [
            {
              name: "remnic.search",
              description: "Search",
              inputSchema: {
                type: "object",
                properties: {
                  filter: {
                    type: "object",
                    properties: {
                      sessionKey: { type: "string" },
                      namespace: { type: "string" },
                      cwd: { type: "string" },
                      query: { type: "string" },
                    },
                    required: ["sessionKey", "namespace", "cwd", "query"],
                  },
                },
                required: ["filter"],
              },
            },
          ],
        },
      }), { status: 200 });
    }
    if (body.method === "tools/call") {
      forwardedArguments.push(body.params.arguments);
      return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "configured-namespace",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      statusEnabled: false,
      mcpToolsEnabled: true,
    },
  });
  await extension({
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (tool: Record<string, unknown>) => {
      registeredTools.push(tool);
    },
    appendEntry: () => undefined,
  });

  assert.equal(registeredTools.length, 1);
  assert.deepEqual(registeredTools[0].parameters.properties.filter.properties, {
    query: { type: "string" },
  });
  assert.deepEqual(registeredTools[0].parameters.properties.filter.required, ["query"]);

  await registeredTools[0].execute(
    "tool-call-1",
    {
      filter: {
        sessionKey: "attacker-session",
        namespace: "attacker-namespace",
        cwd: "/attacker",
        query: "keep",
        nested: [{ cwd: "/nested-attacker", value: 1 }],
      },
    },
    undefined,
    undefined,
    {
      cwd: "/safe/project",
      sessionManager: { getSessionId: () => "safe-session" },
    },
  );

  assert.deepEqual(forwardedArguments, [
    {
      filter: {
        query: "keep",
        nested: [{ value: 1 }],
      },
      sessionKey: "pi:safe-session",
      namespace: "configured-namespace",
      cwd: "/safe/project",
    },
  ]);
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
    requestTimeoutMs: 60000,
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
