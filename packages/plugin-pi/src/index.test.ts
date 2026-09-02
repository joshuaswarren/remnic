import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import remnicPiExtension, {
  buildCompactionSummary,
  createRemnicPiExtension,
  isDaemonUnreachableError,
  matchRemnicMcpToolName,
  observeMessages,
  resetProcessRecallBreakerForTest,
  stripSessionOwnedSchemaFields,
  stripSessionOwnedRuntimeFields,
  toPiToolParametersSchema,
} from "./index.js";
import type { PiApi } from "./index.js";
import type { RemnicPiConfig } from "./config.js";

type TestPiEventHandler = Parameters<PiApi["on"]>[1];
type TestPiCommandHandler = Parameters<PiApi["registerCommand"]>[1]["handler"];

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

test("toPiToolParametersSchema passes stripped MCP schemas through as plain JSON Schema", () => {
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
  });

  assert.deepEqual(schema, {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  });
  assert.equal(Object.getOwnPropertySymbols(schema).length, 0);
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
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(input).includes("/engram/v1/namespace/writable")) {
      return new Response(JSON.stringify({ ok: true, status: "ok", namespace: "default" }), { status: 200 });
    }
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

  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "shared-session" },
  };

  // Each extension independently recalls at first before_agent_start — state maps are
  // isolated so the same session key produces fetch calls on both instances.
  // Zero recall calls at session_start; recall fires on first before_agent_start.
  await first.emit("session_start", {}, ctx);
  await second.emit("session_start", {}, ctx);
  assert.equal(recallBodies.length, 0, "no recall at session_start");

  // Context injection reads from each extension's isolated cachedContext.
  const firstResult = await first.emit("before_agent_start", { prompt: "hi", systemPrompt: "" }, ctx) as { systemPrompt?: string };
  const secondResult = await second.emit("before_agent_start", { prompt: "hi", systemPrompt: "" }, ctx) as { systemPrompt?: string };
  assert.ok(firstResult?.systemPrompt?.includes("remembered context"));
  assert.ok(secondResult?.systemPrompt?.includes("remembered context"));
  // One recall call per extension from the first before_agent_start event.
  assert.equal(recallBodies.length, 2);
});

test("default Pi extension preserves a tripped breaker across reloads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-breaker-reload-"));
  const configPath = path.join(root, "remnic.config.json");
  const reloadConfig = {
    remnicDaemonUrl: "http://127.0.0.1:4319",
    authToken: "test-token",
    observeEnabled: false,
    compactionEnabled: false,
    mcpToolsEnabled: false,
    statusEnabled: true,
    turnRequestTimeoutMs: 2,
    recallTimeoutThreshold: 1,
    recallTimeoutWindow: 1,
  };
  fs.writeFileSync(configPath, JSON.stringify(reloadConfig));

  const previousConfig = process.env.REMNIC_PI_CONFIG;
  const originalFetch = globalThis.fetch;
  process.env.REMNIC_PI_CONFIG = configPath;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(input).includes("/engram/v1/namespace/writable")) {
      return new Response(JSON.stringify({ ok: true, status: "ok", namespace: "default" }), { status: 200 });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  };
  t.after(() => {
    resetProcessRecallBreakerForTest(reloadConfig);
    resetProcessRecallBreakerForTest({ ...reloadConfig, authToken: "other-token" });
    resetProcessRecallBreakerForTest({ ...reloadConfig, recallTimeoutThreshold: 2, recallTimeoutWindow: 2 });
    if (previousConfig === undefined) delete process.env.REMNIC_PI_CONFIG;
    else process.env.REMNIC_PI_CONFIG = previousConfig;
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = makePiHarness();
  const firstStatuses: Array<[string, string]> = [];
  const firstContext = {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: (key: string, value: string) => firstStatuses.push([key, value]), notify: () => {} },
    sessionManager: { getSessionId: () => "breaker-reload-first" },
  };
  await remnicPiExtension(first.pi);
  await first.emit("session_start", {}, firstContext);
  await first.emit("before_agent_start", { prompt: "trip", systemPrompt: "" }, firstContext);

  const second = makePiHarness();
  const secondStatuses: Array<[string, string]> = [];
  const secondContext = {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: (key: string, value: string) => secondStatuses.push([key, value]), notify: () => {} },
    sessionManager: { getSessionId: () => "breaker-reload-second" },
  };
  await remnicPiExtension(second.pi);
  await second.emit("session_start", {}, secondContext);

  assert.deepEqual(secondStatuses.at(-1), ["remnic", "Remnic recall paused (timeouts delayed operations; auto-retry after cooldown)"]);

  fs.writeFileSync(configPath, JSON.stringify({ ...reloadConfig, authToken: "other-token" }));
  const differentCredential = makePiHarness();
  const differentCredentialStatuses: Array<[string, string]> = [];
  await remnicPiExtension(differentCredential.pi);
  await differentCredential.emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: (key: string, value: string) => differentCredentialStatuses.push([key, value]), notify: () => {} },
    sessionManager: { getSessionId: () => "breaker-reload-different-credential" },
  });
  assert.deepEqual(differentCredentialStatuses.at(-1), ["remnic", "Remnic ready"]);

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...reloadConfig, recallTimeoutThreshold: 2, recallTimeoutWindow: 2 }),
  );
  const changedPolicy = makePiHarness();
  const changedPolicyStatuses: Array<[string, string]> = [];
  await remnicPiExtension(changedPolicy.pi);
  await changedPolicy.emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: (key: string, value: string) => changedPolicyStatuses.push([key, value]), notify: () => {} },
    sessionManager: { getSessionId: () => "breaker-reload-policy-change" },
  });
  assert.deepEqual(changedPolicyStatuses.at(-1), ["remnic", "Remnic ready"]);
});

test("MCP tool registration uses the startup timeout instead of the general request timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const registeredTools: Record<string, unknown>[] = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      statusEnabled: false,
      mcpToolsEnabled: true,
      requestTimeoutMs: 60000,
      startupRequestTimeoutMs: 2,
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

  assert.deepEqual(registeredTools, []);
});

test("session_start status probe uses the startup timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const statuses: Array<[string, string]> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: true,
      requestTimeoutMs: 60000,
      startupRequestTimeoutMs: 2,
    },
  });
  await extension(pi as any);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: {
      setStatus: (key: string, value: string) => statuses.push([key, value]),
    },
    sessionManager: { getSessionId: () => "startup-timeout-test", getEntries: () => [] },
  });

  assert.deepEqual(statuses, [["remnic", "Remnic offline"]]);
});

test("session_start renders 'Remnic starting' when health answers 503 not_ready (issue #2215)", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/engram/v1/health")) {
      // The daemon is up but startup search warm-up has not completed — it must
      // render as starting, not offline, because recall still serves (issue #2215).
      return new Response(
        JSON.stringify({ ok: false, ready: false, warmupAttempts: 154, lastError: "StartupSyncPendingError", code: "not_ready" }),
        { status: 503 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const statuses: Array<[string, string]> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: true,
    },
  });
  await extension(pi as any);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: {
      setStatus: (key: string, value: string) => statuses.push([key, value]),
    },
    sessionManager: { getSessionId: () => "starting-status-test", getEntries: () => [] },
  });

  assert.deepEqual(statuses, [["remnic", "Remnic starting"]]);
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

test("before_agent_start refreshes recall context across sessions", async (t) => {
  const originalFetch = globalThis.fetch;
  const recallBodies: Array<{ sessionKey?: string }> = [];
  let recallCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/engram/v1/recall")) {
      recallBodies.push(body as { sessionKey?: string });
      recallCalls += 1;
    }
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

  const session1Ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "session-1" },
  };
  const session2Ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "session-2" },
  };
  const event = { prompt: "same prompt", systemPrompt: "" };

  // Session 1: recall fires on first before_agent_start, not session_start
  await emit("session_start", {}, session1Ctx);
  assert.equal(recallCalls, 0);

  const first = await emit("before_agent_start", event, session1Ctx) as { systemPrompt?: string };
  assert.equal(recallCalls, 1);
  assert.ok(first?.systemPrompt?.includes("remembered context"));

  await emit("session_shutdown", {}, session1Ctx);

  // Session 2: recall fires again on first before_agent_start
  await emit("session_start", {}, session2Ctx);
  assert.equal(recallCalls, 1);

  const second = await emit("before_agent_start", event, session2Ctx) as { systemPrompt?: string };
  assert.equal(recallCalls, 2);
  assert.ok(second?.systemPrompt?.includes("remembered context"));
});

test("before_agent_start injects cached recall across successive turns in the same session", async (t) => {
  const originalFetch = globalThis.fetch;
  let recallCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/recall")) {
      recallCalls += 1;
    }
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
    sessionManager: { getSessionId: () => "repeat-context-test" },
  };
  const event = { prompt: "continue", systemPrompt: "" };

  await emit("session_start", {}, ctx);
  assert.equal(recallCalls, 0);

  const first = await emit("before_agent_start", event, ctx) as { systemPrompt?: string };
  assert.equal(recallCalls, 1, "recall fired on first before_agent_start");
  const second = await emit("before_agent_start", event, ctx) as { systemPrompt?: string };
  const third = await emit("before_agent_start", event, ctx) as { systemPrompt?: string };

  assert.equal(recallCalls, 1, "no additional recall on subsequent before_agent_start events");
  assert.ok(first?.systemPrompt?.includes("remembered context"));
  assert.ok(second?.systemPrompt?.includes("remembered context"));
  assert.ok(third?.systemPrompt?.includes("remembered context"));
});

test("direct legacy config receives recall breaker defaults", () => {
  const { recallTimeoutThreshold: _threshold, recallTimeoutWindow: _window, ...legacyConfig } = baseConfig();

  assert.doesNotThrow(() => createRemnicPiExtension({ config: legacyConfig }));
});
test("empty recall at first before_agent_start does not inject context but a later session with content does", async (t) => {
  const originalFetch = globalThis.fetch;
  let recallCallIndex = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/engram/v1/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/engram/v1/namespace/writable")) {
      return new Response(JSON.stringify({ ok: true, status: "ok", namespace: "default" }), { status: 200 });
    }
    recallCallIndex += 1;
    return new Response(JSON.stringify({ context: recallCallIndex === 1 ? "" : "remembered context" }), { status: 200 });
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

  const session1Ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "empty-recall-session" },
  };
  const session2Ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "content-recall-session" },
  };
  const event = { prompt: "same prompt", systemPrompt: "" };

  // Session 1: recall returns empty → no cached context → before_agent_start returns undefined
  await emit("session_start", {}, session1Ctx);
  assert.equal(await emit("before_agent_start", event, session1Ctx), undefined);
  await emit("session_shutdown", {}, session1Ctx);

  // Session 2: recall returns content → cachedContext populated → before_agent_start injects
  await emit("session_start", {}, session2Ctx);
  const result = await emit("before_agent_start", event, session2Ctx) as { systemPrompt?: string };

  assert.ok(result?.systemPrompt?.includes("remembered context"));
});

test("before_agent_start appends cached context to the system prompt", async (t) => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ context: "remembered context" }), { status: 200 });
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
		},
	});
	await extension(pi as any);

	const ctx = {
		cwd: "/tmp/remnic-pi",
		sessionManager: { getSessionId: () => "append-recall-test" },
	};

	await emit("session_start", {}, ctx);

	const result = await emit("before_agent_start", { prompt: "same prompt", systemPrompt: "base system prompt" }, ctx) as { systemPrompt?: string };

	assert.ok(result?.systemPrompt?.includes("remembered context"));
	assert.ok(result?.systemPrompt?.startsWith("base system prompt"));
});

test("before_agent_start does not load full session history", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ context: "remembered context" }), { status: 200 });
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

  const sessionManager = {
    getSessionId: () => "history-free-context",
    getEntries: () => {
      throw new Error("getEntries should not be called");
    },
    getBranch: () => {
      throw new Error("getBranch should not be called");
    },
  };

  const ctx = { cwd: "/tmp/remnic-pi", sessionManager };
  await emit("session_start", {}, ctx);

  const result = await emit("before_agent_start", { prompt: "same prompt", systemPrompt: "" }, ctx) as { systemPrompt?: string };

  assert.ok(result?.systemPrompt?.includes("remembered context"));
});

test("before_agent_start skips stale Pi ctx before snapshot", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ context: "should not be used" }), { status: 200 });
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

  const stale = makeStaleCtx({ sessionId: "stale-before-snapshot" });
  stale.markStale();

  const result = await emit("before_agent_start", { prompt: "same prompt", systemPrompt: "" }, stale.ctx);

  assert.equal(result, undefined);
  assert.equal(calls, 0);
  assert.deepEqual(stale.notifications, []);
});

test("before_agent_start keeps pi:default fallback when session manager is missing", async (t) => {
  const originalFetch = globalThis.fetch;
  const recallBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/recall")) {
      recallBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    }
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

  const noopCtx = { cwd: "/tmp/remnic-pi" };
  await emit("session_start", {}, noopCtx);

  // Recall fires on first before_agent_start, not session_start
  assert.equal(recallBodies.length, 0);

  const result = await emit("before_agent_start", { prompt: "same prompt", systemPrompt: "" }, noopCtx) as { systemPrompt?: string };

  assert.equal(recallBodies.length, 1);
  assert.equal(recallBodies[0]?.sessionKey, "pi:default");
  assert.equal(recallBodies[0]?.cwd, "/tmp/remnic-pi");
  assert.ok(result?.systemPrompt?.includes("remembered context"));
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

  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "recall-budget-test" },
  };
  await emit("session_start", {}, ctx);

  const result = await emit("before_agent_start", { prompt: "same prompt", systemPrompt: "" }, ctx) as { systemPrompt?: string };

  const text = result?.systemPrompt ?? "";
  const startMarker = "\n\n[Remnic context truncated]";
  const truncatedAt = text.indexOf(startMarker);
  assert.notEqual(truncatedAt, -1, "truncation marker present");
  // The cached context meets its budget; the \n\n separator adds 2 chars to systemPrompt.
  assert.ok(text.length <= 42, `system prompt length ${text.length} ≤ 42`);
});

test("before_agent_start fires recall on first event and caches the result", async (t) => {
  const originalFetch = globalThis.fetch;
  let recallCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/engram/v1/recall")) {
      recallCalls += 1;
    }
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
    sessionManager: { getSessionId: () => "first-context-recall" },
  };
  const event = { prompt: "same prompt", systemPrompt: "" };

  // No recall at session_start
  await emit("session_start", {}, ctx);
  assert.equal(recallCalls, 0);

  // First before_agent_start fires recall and caches the result
  const result = await emit("before_agent_start", event, ctx) as { systemPrompt?: string };
  assert.equal(recallCalls, 1, "recall fired on first before_agent_start");
  assert.ok(result?.systemPrompt?.includes("remembered context"), "context was injected");
});

test("before_agent_start recall failure notification survives stale Pi ctx after await", async (t) => {
  const originalFetch = globalThis.fetch;
  const stale = makeStaleCtx({ sessionId: "stale-context-recall" });
  globalThis.fetch = async (input) => {
    const url = String(input);
    // Let health and namespace probes succeed so snapshotPiContext works
    // during the before_agent_start handler.  Only the recall call marks the ctx stale.
    if (url.endsWith("/engram/v1/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/engram/v1/namespace/writable")) {
      return new Response(JSON.stringify({ ok: true, status: "ok", namespace: "default" }), { status: 200 });
    }
    stale.markStale();
    throw new Error("offline");
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

  // session_start does not fire recall
  await assert.doesNotReject(() =>
    emit("session_start", {}, stale.ctx)
  );

  // before_agent_start recall fires and fails; notification survives stale ctx.
  await assert.doesNotReject(() =>
    emit("before_agent_start", { prompt: "hi", systemPrompt: "" }, stale.ctx)
  );
  assert.deepEqual(stale.notifications, [
    { message: "Remnic recall unavailable: offline", level: "warning" },
  ]);
});

test("observe failure notification survives stale Pi ctx after await", async (t) => {
  const originalFetch = globalThis.fetch;
  const stale = makeStaleCtx({ sessionId: "stale-observe" });
  globalThis.fetch = async () => {
    stale.markStale();
    throw new Error("observe offline");
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

  await assert.doesNotReject(() =>
    emit("message_end", { message: { id: "m1", role: "user", content: "remember this" } }, stale.ctx)
  );
  assert.deepEqual(stale.notifications, [
    { message: "Remnic observe failed: observe offline", level: "warning" },
  ]);
});

test("compaction failure notification survives stale Pi ctx after await", async (t) => {
  const originalFetch = globalThis.fetch;
  const stale = makeStaleCtx({ sessionId: "stale-compaction" });
  globalThis.fetch = async () => {
    stale.markStale();
    throw new Error("flush offline");
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

  await assert.doesNotReject(() => emit("session_before_compact", { preparation: {} }, stale.ctx));
  assert.deepEqual(stale.notifications, [
    { message: "Remnic LCM flush failed: flush offline", level: "warning" },
  ]);
});

test("command handlers notify with captured context after stale Pi ctx", async (t) => {
  const originalFetch = globalThis.fetch;
  const stale = makeStaleCtx({ sessionId: "stale-command" });
  const recallBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    recallBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    stale.markStale();
    return new Response(JSON.stringify({ context: "remembered command context" }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, runCommand } = makePiHarness();
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

  await assert.doesNotReject(() => runCommand("remnic-recall", "same prompt", stale.ctx));
  assert.equal(recallBodies[0].sessionKey, "pi:stale-command");
  assert.equal(recallBodies[0].cwd, "/tmp/remnic-pi");
  assert.deepEqual(stale.notifications, [
    { message: "remembered command context", level: "info" },
  ]);
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

test("MCP recall diagnostics remain available after the recall timeout breaker trips", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.method === "tools/list") {
      return new Response(JSON.stringify({
        result: {
          tools: [
            { name: "remnic.recall", inputSchema: { type: "object" } },
            { name: "remnic.recall_explain", inputSchema: { type: "object" } },
          ],
        },
      }), { status: 200 });
    }
    if (body.params?.name === "remnic.recall") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      });
    }
    return new Response(JSON.stringify({ result: { summary: "last recall" } }), { status: 200 });
  };
  t.after(() => {
    resetProcessRecallBreakerForTest({
      ...baseConfig(),
      authToken: "test-token",
      recallTimeoutThreshold: 1,
      recallTimeoutWindow: 1,
    });
    globalThis.fetch = originalFetch;
  });

  const registeredTools: Record<string, unknown>[] = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      statusEnabled: false,
      mcpToolsEnabled: true,
      requestTimeoutMs: 2,
      recallTimeoutThreshold: 1,
      recallTimeoutWindow: 1,
    },
  });
  const pi: PiApi = {
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (tool) => registeredTools.push(tool),
    appendEntry: () => undefined,
  };
  await extension(pi);

  const recallTool = registeredTools.find((tool) => tool.name === "remnic_recall");
  const explainTool = registeredTools.find((tool) => tool.name === "remnic_recall_explain");
  assert.ok(recallTool);
  assert.ok(explainTool);
  const recallExecute = recallTool.execute;
  const explainExecute = explainTool.execute;
  if (typeof recallExecute !== "function" || typeof explainExecute !== "function") {
    throw new Error("expected registered MCP tools to provide execute handlers");
  }

  const context = { cwd: "/tmp/remnic-pi", sessionManager: { getSessionId: () => "mcp-diagnostics" } };
  await assert.rejects(
    () => recallExecute("call-1", { query: "trip" }, undefined, undefined, context),
    /timed out/,
  );
  const diagnosticResult = await explainExecute("call-2", {}, undefined, undefined, context);
  assert.match(JSON.stringify(diagnosticResult), /last recall/);
});

test("remnic-why remains available after the recall timeout breaker trips", async (t) => {
  const config = {
    ...baseConfig(),
    authToken: "why-test-token",
    recallEnabled: false,
    observeEnabled: false,
    compactionEnabled: false,
    mcpToolsEnabled: false,
    statusEnabled: false,
    requestTimeoutMs: 2,
    recallTimeoutThreshold: 1,
    recallTimeoutWindow: 1,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/recall")) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      });
    }
    return new Response(JSON.stringify({ summary: "last recall" }), { status: 200 });
  };
  t.after(() => {
    resetProcessRecallBreakerForTest(config);
    globalThis.fetch = originalFetch;
  });

  const { pi, runCommand } = makePiHarness();
  await createRemnicPiExtension({ config })(pi);
  const notifications: Array<{ message: string; level: string }> = [];
  const context = {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => "why-diagnostic" },
  };

  await runCommand("remnic-recall", "trip", context);
  await runCommand("remnic-why", "", context);

  assert.deepEqual(notifications.at(-1), { message: JSON.stringify({ summary: "last recall" }, null, 2), level: "info" });
});

test("matchRemnicMcpToolName normalizes only the recognized Remnic namespace", () => {
  assert.deepEqual(matchRemnicMcpToolName("remnic_recall"), {
    serverToolName: "remnic_recall",
    piToolName: "remnic_recall",
  });
  assert.deepEqual(matchRemnicMcpToolName("remnic_set_coding_context"), {
    serverToolName: "remnic_set_coding_context",
    piToolName: "remnic_set_coding_context",
  });
  assert.deepEqual(matchRemnicMcpToolName("remnic.recall"), {
    serverToolName: "remnic.recall",
    piToolName: "remnic_recall",
  });
  assert.deepEqual(matchRemnicMcpToolName("remnic.recall_explain"), {
    serverToolName: "remnic.recall_explain",
    piToolName: "remnic_recall_explain",
  });

  assert.equal(matchRemnicMcpToolName("myremnic_recall"), null);
  assert.equal(matchRemnicMcpToolName("prefix_remnic_recall"), null);
  assert.equal(matchRemnicMcpToolName("remnic"), null);
  assert.equal(matchRemnicMcpToolName("remnic."), null);
  assert.equal(matchRemnicMcpToolName("remnic_"), null);
  assert.equal(matchRemnicMcpToolName(""), null);
  assert.equal(matchRemnicMcpToolName(undefined), null);
  assert.equal(matchRemnicMcpToolName(42), null);
  assert.equal(matchRemnicMcpToolName("remnic_!"), null);
  assert.equal(matchRemnicMcpToolName("remnic.recall!"), null);
});

type RegisteredTool = Record<string, unknown> & {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
};

async function registerToolsFromCatalog(catalogToolNames: string[]): Promise<{
  registeredTools: RegisteredTool[];
  calledToolNames: string[];
  appendedEntries: Array<{ customType: string; data: unknown }>;
}> {
  const originalFetch = globalThis.fetch;
  const registeredTools: RegisteredTool[] = [];
  const calledToolNames: string[] = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: { name?: string };
      };
      if (body.method === "tools/list") {
        return new Response(JSON.stringify({
          result: {
            tools: catalogToolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
          },
        }), { status: 200 });
      }
      if (body.method === "tools/call") {
        calledToolNames.push(body.params?.name ?? "");
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    };

    const extension = createRemnicPiExtension({
      config: {
        ...baseConfig(),
        authToken: "catalog-test-token",
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
      registerTool: (tool: Record<string, unknown>) => registeredTools.push(tool as RegisteredTool),
      appendEntry: (customType: string, data?: unknown) => appendedEntries.push({ customType, data }),
    });

    const firstTool = registeredTools[0];
    if (firstTool) {
      await firstTool.execute("call-1", { query: "q" }, undefined, undefined, {
        cwd: "/tmp/remnic-pi",
        sessionManager: { getSessionId: () => "catalog-tool" },
      });
    }

    return { registeredTools, calledToolNames, appendedEntries };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("underscore-form MCP catalogs register Pi-safe tools that call the catalog tool name", async () => {
  const { registeredTools, calledToolNames } = await registerToolsFromCatalog([
    "remnic_recall",
    "remnic_recall_explain",
    "remnic_set_coding_context",
  ]);

  assert.deepEqual(
    registeredTools.map((tool) => tool.name),
    ["remnic_recall", "remnic_recall_explain", "remnic_set_coding_context"],
  );
  assert.equal(registeredTools[0].label, "remnic_recall");

  assert.deepEqual(calledToolNames, ["remnic_recall"]);
});

test("legacy dotted MCP catalogs keep working and call the dotted server-side name", async () => {
  const { registeredTools, calledToolNames } = await registerToolsFromCatalog([
    "remnic.recall",
    "remnic.recall_explain",
    "remnic.set_coding_context",
  ]);

  assert.deepEqual(
    registeredTools.map((tool) => tool.name),
    ["remnic_recall", "remnic_recall_explain", "remnic_set_coding_context"],
  );
  assert.equal(registeredTools[0].label, "remnic.recall");

  assert.deepEqual(calledToolNames, ["remnic.recall"]);
});

test("non-Remnic and malformed catalog names are excluded without accidental normalization", async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const { registeredTools, appendedEntries } = await registerToolsFromCatalog([
      "other_server_tool",
      "myremnic_recall",
      "prefix_remnic_recall",
      "remnic",
      "remnic.",
      "remnic_",
      "remnic_!",
      "remnic.recall!",
    ]);
    assert.equal(registeredTools.length, 0);

    const diagnostic = appendedEntries.find((entry) =>
      typeof entry.data === "object" && entry.data !== null && "code" in entry.data &&
      (entry.data as { code: unknown }).code === "MCP_TOOLS_FILTERED"
    );
    assert.ok(diagnostic, "expected an MCP_TOOLS_FILTERED diagnostic entry");
    assert.ok(warnings.some((line) => line.includes("none matched the Remnic namespace")));
  } finally {
    console.warn = originalWarn;
  }
});

test("mixed-shape catalogs dedupe onto one Pi-safe registration per tool", async () => {
  const { registeredTools } = await registerToolsFromCatalog(["remnic.recall", "remnic_recall"]);
  assert.deepEqual(
    registeredTools.map((tool) => tool.name),
    ["remnic_recall"],
  );
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
    startupRequestTimeoutMs: 1000,
    turnRequestTimeoutMs: 20000,
    observeMaxBytes: 102400,
    observeMaxRetries: 2,
    daemonCooldownMs: 5000,
    recallTimeoutThreshold: 7,
    recallTimeoutWindow: 10,
  };
}

function makePiHarness(): {
  pi: PiApi;
  emit: (event: string, payload: unknown, ctx: unknown) => Promise<unknown>;
  runCommand: (name: string, args: string, ctx: unknown) => Promise<void>;
} {
  const handlers = new Map<string, TestPiEventHandler[]>();
  const commands = new Map<string, TestPiCommandHandler>();
  const pi: PiApi = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name, options) => {
      commands.set(name, options.handler);
    },
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
    runCommand: async (name, args, ctx) => {
      const handler = commands.get(name);
      assert.ok(handler, `missing command ${name}`);
      await handler(args, ctx);
    },
  };
}

function makeStaleCtx(options: {
  sessionId: string;
  cwd?: string;
  entries?: unknown[];
  branch?: unknown[];
}): {
  ctx: unknown;
  markStale: () => void;
  notifications: Array<{ message: string; level: string }>;
  statuses: Array<{ key: string; value: string }>;
} {
  let stale = false;
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: string }> = [];
  const assertActive = () => {
    if (stale) {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    }
  };
  const sessionManager = {
    getSessionId: () => options.sessionId,
    getEntries: () => options.entries ?? [],
    getBranch: () => options.branch ?? [],
  };
  const ui = {
    notify(message: string, level: string) {
      notifications.push({ message, level });
    },
    setStatus(key: string, value: string) {
      statuses.push({ key, value });
    },
  };

  return {
    ctx: {
      get cwd() {
        assertActive();
        return options.cwd ?? "/tmp/remnic-pi";
      },
      get hasUI() {
        assertActive();
        return true;
      },
      get ui() {
        assertActive();
        return ui;
      },
      get sessionManager() {
        assertActive();
        return sessionManager;
      },
      compact() {
        assertActive();
      },
    },
    markStale: () => {
      stale = true;
    },
    notifications,
    statuses,
  };
}


test("circuit breaker prevents context recall after a startup health probe timeout (#1626)", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  // fetch hangs until the AbortController fires, simulating an unreachable host.
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
      startupRequestTimeoutMs: 30,
      daemonCooldownMs: 60000,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "cb-session" },
  };
  const event = { prompt: "any prompt", systemPrompt: "" };

  // First session_start: health probe times out → daemon enters cooldown.
  await emit("session_start", {}, ctx);
  const healthProbeCalls = fetchCalls;
  assert.ok(healthProbeCalls >= 1, "health probe timed out");

  // before_agent_start sees no cached recall (daemon was unreachable at startup).
  assert.equal(await emit("before_agent_start", event, ctx), undefined);

  // Second session_start while breaker is still in cooldown: health probe runs
  // but recall is skipped because isReachable() is false.
  await emit("session_start", {}, ctx);
  const totalCalls = fetchCalls;
  assert.ok(totalCalls > healthProbeCalls, "health probe ran again");

  // before_agent_start still sees no cached recall (breaker prevented the one-shot).
  assert.equal(await emit("before_agent_start", event, ctx), undefined);
});

test("session_shutdown replays the branch even when the daemon breaker is tripped (#1626, review codex)", async (t) => {
  const originalFetch = globalThis.fetch;
  const observeBodies: Array<Record<string, any>> = [];
  let call = 0;
  globalThis.fetch = async (input, init) => {
    call += 1;
    if (String(input).endsWith("/engram/v1/observe")) {
      // Fail the ENTIRE turn_end retry chain (1 initial + observeMaxRetries=2
      // retries = 3 calls) so the breaker actually trips; the next observe
      // (shutdown) then succeeds, proving shutdown bypasses the breaker.
      if (call <= 3) {
        throw new Error("The socket connection was closed unexpectedly.");
      }
      observeBodies.push(JSON.parse(String(init?.body ?? "{}")));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

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
      getSessionId: () => "shutdown-breaker-test",
      getEntries: () => [],
      getBranch: () => [{ id: "entry-1", message }],
    },
  };

  // turn_end observe fails transiently -> breaker tripped, nothing recorded.
  await emit("turn_end", { message }, ctx);
  assert.equal(observeBodies.length, 0, "turn_end observe failed and recorded nothing");

  // shutdown runs while the breaker is in cooldown; forceAttempt must still
  // replay the branch (the last chance to observe before teardown).
  await emit("session_shutdown", {}, ctx);
  assert.equal(observeBodies.length, 1, "shutdown bypassed the breaker and observed the branch");
});

test("session_shutdown observe uses the general request budget, not the per-turn budget (review cursor)", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  t.after(() => { globalThis.fetch = originalFetch; });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
      turnRequestTimeoutMs: 30,
      requestTimeoutMs: 150,
    },
  });
  await extension(pi as any);

  const stale = makeStaleCtx({
    sessionId: "shutdown-budget-test",
    branch: [{ id: "entry-1", message: { role: "user", content: "x".repeat(50) } }],
  });

  await emit("session_shutdown", {}, stale.ctx);

  // Shutdown replay is teardown (no host handler window), so it must use the
  // general request budget (150ms), NOT the per-turn budget (30ms). The timeout
  // error embeds the budget actually used, so this deterministically proves
  // which budget governed the forced replay.
  const observeFail = stale.notifications.find((n) => /Remnic observe failed/.test(n.message));
  assert.ok(observeFail, "shutdown observe ran and timed out");
  assert.match(observeFail!.message, /timed out after 150ms/);
});

test("retry-budget exhaustion trips the circuit breaker so the next turn cools down (review codex)", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("The socket connection was closed unexpectedly.");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
      // Per-turn budget below the first 200ms backoff, so a transient failure
      // exhausts the retry budget and throws the budget-exceeded error.
      turnRequestTimeoutMs: 30,
      observeMaxRetries: 2,
      daemonCooldownMs: 60000,
    },
  });
  await extension(pi as any);

  const message = { role: "assistant", content: "done" };
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "budget-breaker-test", getEntries: () => [], getBranch: () => [] },
  };

  // First turn: transient socket close exhausts the retry budget. The
  // budget-exceeded error must trip the breaker (not fall through silently).
  await emit("turn_end", { message }, ctx);
  const callsAfterFirst = calls;
  assert.ok(callsAfterFirst >= 1, "first turn attempted an observe");

  // Second turn: breaker is in cooldown -> observe is skipped, no new fetch.
  await emit("turn_end", { message }, ctx);
  assert.equal(calls, callsAfterFirst, "breaker skipped the second turn after budget exhaustion");
});

test("isDaemonUnreachableError recognizes both budget-exceeded wordings so the breaker trips (review cursor)", () => {
  // requestWithRetry retry-budget exhaustion:
  assert.ok(
    isDaemonUnreachableError(new Error("Remnic request exceeded the 50ms budget before retry 1 (POST /engram/v1/observe)")),
    "retry-budget exhaustion is unreachable",
  );
  // Multi-chunk observe per-turn budget exhaustion:
  assert.ok(
    isDaemonUnreachableError(new Error("Remnic observe exceeded the per-turn budget of 20ms across 3 chunks (completed 1)")),
    "multi-chunk observe budget exhaustion is unreachable",
  );
  // A semantic HTTP-style error is NOT classified as unreachable:
  assert.ok(!isDaemonUnreachableError(new Error("Internal Server Error")), "HTTP errors stay reachable");
});

test("an offline startup health probe trips the circuit breaker so the first turn fast-skips (review codex)", async (t) => {
  const originalFetch = globalThis.fetch;
  let recallCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/engram/v1/health")) {
      // Daemon is offline: a connection-level failure fails fast (health() does not retry).
      throw new Error("The socket connection was closed unexpectedly.");
    }
    // If the breaker let recall through, this would hang until the AbortController fires.
    recallCalls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: true,
      turnRequestTimeoutMs: 30,
      daemonCooldownMs: 60000,
    },
  });
  await extension(pi as any);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: { getSessionId: () => "status-trip-breaker" },
  };
  const event = { prompt: "hi", systemPrompt: "" };

  // 1) session_start health fails because the daemon is offline -> trips the breaker.
  await emit("session_start", {}, ctx);
  // 2) before_agent_start (recall) fast-skips because the breaker is tripped, so the doomed
  //    recall never costs the full turn budget.
  await emit("before_agent_start", event, ctx);
  assert.equal(recallCalls, 0, "recall fast-skipped after the offline startup probe tripped the breaker");
});
test("session_start preserves the recall-disabled status after a successful health probe", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/engram/v1/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  };
  t.after(() => {
    resetProcessRecallBreakerForTest({
      ...baseConfig(),
      authToken: "test-token",
      recallTimeoutThreshold: 1,
      recallTimeoutWindow: 1,
    });
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const statuses: Array<[string, string]> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: true,
      turnRequestTimeoutMs: 2,
      recallTimeoutThreshold: 1,
      recallTimeoutWindow: 1,
    },
  });
  await extension(pi);

  const context = (sessionKey: string) => ({
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: (key: string, value: string) => statuses.push([key, value]), notify: () => {} },
    sessionManager: { getSessionId: () => sessionKey },
  });

  await emit("session_start", {}, context("breaker-first"));
  await emit("before_agent_start", { prompt: "hi", systemPrompt: "" }, context("breaker-first"));
  await emit("session_start", {}, context("breaker-second"));

  assert.deepEqual(statuses.at(-1), ["remnic", "Remnic recall paused (timeouts delayed operations; auto-retry after cooldown)"]);
});

test("/remnic-recall bounds retry to the general request budget instead of unbounded retries (review cursor)", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("The socket connection was closed unexpectedly.");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { pi, runCommand } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
      requestTimeoutMs: 40,
      observeMaxRetries: 2,
    },
  });
  await extension(pi as any);

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd: "/tmp/remnic-pi",
    ui: { notify: (m: string, l: string) => notifications.push({ message: m, level: l }) },
    sessionManager: { getSessionId: () => "recall-command-budget" },
  };

  await runCommand("remnic-recall", "any query", ctx);
  // The command passes the general request budget as a shared deadline, so the
  // 40ms budget (below the first 200ms backoff) stops retries after one call
  // instead of looping through the full retry chain unbounded.
  assert.equal(calls, 1, "manual recall did not loop through unbounded retries");
  assert.ok(
    notifications.some((n) => /Remnic command failed/.test(n.message)),
    "command reported the bounded failure",
  );
});

test("a successful /remnic-recall clears a stale circuit breaker (review cursor)", async (t) => {
  const originalFetch = globalThis.fetch;
  let recallCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/engram/v1/recall")) {
      recallCalls += 1;
    }
    // Manual recall responds OK; automatic context recall hangs until abort.
    if (url.endsWith("/engram/v1/recall") && init?.body && JSON.parse(String(init.body)).query === "manual") {
      return new Response(JSON.stringify({ context: "manual context" }), { status: 200 });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { pi, emit, runCommand } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
      startupRequestTimeoutMs: 30,
      turnRequestTimeoutMs: 30,
      daemonCooldownMs: 60000,
    },
  });
  await extension(pi as any);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: { getSessionId: () => "manual-recall-clears-breaker" },
  };

  // 1) session_start: health probe + namespace preflight time out (30ms each).
  //    `request()` transforms AbortError to `Remnic request timed out after Nms`,
  //    which IS daemon-unreachable (index.ts:828), so the breaker IS tripped.
  await emit("session_start", {}, ctx);
  assert.equal(recallCalls, 0, "no recall at session_start");

  // 2) Manual recall succeeds → markReachable() on the shared client.
  await runCommand("remnic-recall", "manual", ctx);

  // 3) before_agent_start event: automatic recall fires now that the daemon is reachable.
  //    Count only recall requests so health/preflight noise is excluded.
  const recallCallsBeforeAuto = recallCalls;
  await emit("before_agent_start", { prompt: "auto", systemPrompt: "" }, ctx);
  assert.ok(recallCalls > recallCallsBeforeAuto, "automatic recall ran after manual recall cleared the breaker");
});

test("session_start preflight surfaces a loud persistent remnic_state error when the namespace is not writable", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/engram/v1/namespace/writable")) {
      return new Response(JSON.stringify({ ok: false, reason: "not_writable", namespace: "default" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  pi.appendEntry = (type: string, data: unknown) => entries.push({ type, data: (data ?? {}) as Record<string, unknown> });
  const notifications: Array<{ message: string; level: string }> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "default",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => "preflight-bad", getEntries: () => [] },
  });

  const errorEntry = entries.find((e) => e.type === "remnic_state" && e.data.level === "error");
  assert.ok(errorEntry, "expected a persistent remnic_state error entry");
  assert.equal(errorEntry?.data.code, "NAMESPACE_NOT_WRITABLE");
  assert.equal(errorEntry?.data.persistent, true);
  assert.equal(errorEntry?.data.namespace, "default");
  assert.ok(notifications.some((n) => n.level === "error"), "expected a loud error notification");
});

test("session_start preflight stays silent when the namespace is writable", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/engram/v1/namespace/writable")) {
      return new Response(JSON.stringify({ ok: true, namespace: "team-x" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  pi.appendEntry = (type: string, data: unknown) => entries.push({ type, data: (data ?? {}) as Record<string, unknown> });
  const notifications: Array<{ message: string; level: string }> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "team-x",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => "preflight-ok", getEntries: () => [] },
  });

  assert.equal(entries.some((e) => e.type === "remnic_state" && e.data.level === "error"), false);
  assert.equal(notifications.some((n) => n.level === "error"), false);
});

test("session_start preflight does not cry wolf when the daemon is unreachable", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/engram/v1/namespace/writable")) {
      throw new Error("ECONNREFUSED");
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  pi.appendEntry = (type: string, data: unknown) => entries.push({ type, data: (data ?? {}) as Record<string, unknown> });
  const notifications: Array<{ message: string; level: string }> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "default",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => "preflight-down", getEntries: () => [] },
  });

  assert.equal(entries.some((e) => e.type === "remnic_state" && e.data.level === "error"), false);
  assert.equal(notifications.some((n) => n.level === "error"), false);
});

test("session_start preflight is skipped without an auth token", async (t) => {
  const originalFetch = globalThis.fetch;
  let hitWritable = false;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/engram/v1/namespace/writable")) hitWritable = true;
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  pi.appendEntry = (type: string, data: unknown) => entries.push({ type, data: (data ?? {}) as Record<string, unknown> });
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      namespace: "default",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: { getSessionId: () => "preflight-noauth", getEntries: () => [] },
  });

  assert.equal(hitWritable, false);
  assert.equal(entries.some((e) => e.type === "remnic_state" && e.data.level === "error"), false);
});

test("session_start preflight self-heals: emits a resolved signal once the namespace becomes writable", async (t) => {
  const originalFetch = globalThis.fetch;
  let writable = false;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/engram/v1/namespace/writable")) {
      return writable
        ? new Response(JSON.stringify({ ok: true, namespace: "default" }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, reason: "not_writable", namespace: "default" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  pi.appendEntry = (type: string, data: unknown) => entries.push({ type, data: (data ?? {}) as Record<string, unknown> });
  const notifications: Array<{ message: string; level: string }> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "default",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => "preflight-heal", getEntries: () => [] },
  };

  // First session: namespace not writable → loud error entry + notification.
  await emit("session_start", {}, ctx);
  assert.ok(entries.some((e) => e.data.code === "NAMESPACE_NOT_WRITABLE"), "expected an initial error entry");
  assert.ok(notifications.some((n) => n.level === "error"), "expected an initial error notification");
  const errorNotifsAfterFail = notifications.filter((n) => n.level === "error").length;

  // Config fixed; next session: writable → an authoritative NAMESPACE_OK entry
  // is recorded (so the latest state survives a restart), the loud error stops,
  // and there is no success-notify spam.
  writable = true;
  await emit("session_start", {}, ctx);
  assert.ok(entries.some((e) => e.data.code === "NAMESPACE_OK"), "expected an authoritative resolved entry once writable");
  assert.equal(
    notifications.filter((n) => n.level === "error").length,
    errorNotifsAfterFail,
    "the loud error notification must stop once the namespace is writable",
  );
  assert.equal(notifications.some((n) => n.level === "success"), false, "healthy sessions must not emit success-notify spam");
});

test("session_start preflight treats a malformed denial as indeterminate (no false alarm)", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/engram/v1/namespace/writable")) {
      // ok:false but missing the reason/namespace contract → must NOT alarm.
      return new Response(JSON.stringify({ ok: false }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  pi.appendEntry = (type: string, data: unknown) => entries.push({ type, data: (data ?? {}) as Record<string, unknown> });
  const notifications: Array<{ message: string; level: string }> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "default",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => "preflight-malformed", getEntries: () => [] },
  });

  assert.equal(entries.some((e) => e.data.code === "NAMESPACE_NOT_WRITABLE"), false);
  assert.equal(notifications.some((n) => n.level === "error"), false);
});

test("session_start trips the circuit breaker on an offline daemon even when statusEnabled is false", async (t) => {
  const originalFetch = globalThis.fetch;
  let nonHealthCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/engram/v1/health")) {
      throw new Error("The socket connection was closed unexpectedly.");
    }
    // Preflight or recall would land here; if the breaker let either through it
    // would hang until its AbortController fires.
    nonHealthCalls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "default",
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
      turnRequestTimeoutMs: 30,
      daemonCooldownMs: 60000,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  const ctx = {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: { getSessionId: () => "status-off-breaker" },
  };
  // Health fails at session_start → breaker trips despite statusEnabled=false;
  // the preflight then fast-skips (indeterminate) instead of fetching.
  await emit("session_start", {}, ctx);
  // The live recall hook fast-skips because the breaker is tripped.
  await emit("before_agent_start", { prompt: "hi", systemPrompt: "" }, ctx);
  assert.equal(nonHealthCalls, 0, "an offline probe must trip the breaker even with the status UI disabled");
});

test("session_start preflight treats a malformed writable answer as indeterminate", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/engram/v1/namespace/writable")) {
      // ok:true but missing the namespace → malformed, must not be trusted.
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  pi.appendEntry = (type: string, data: unknown) => entries.push({ type, data: (data ?? {}) as Record<string, unknown> });
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "default",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: { getSessionId: () => "preflight-malformed-ok", getEntries: () => [] },
  });

  // Indeterminate → no state entry recorded at all (neither OK nor error).
  assert.equal(entries.some((e) => e.type === "remnic_state" && (e.data.code === "NAMESPACE_OK" || e.data.code === "NAMESPACE_NOT_WRITABLE")), false);
});

test("session_start preflight tailors the remediation text for an unsupported (namespaces-disabled) reason", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/engram/v1/namespace/writable")) {
      return new Response(JSON.stringify({ ok: false, reason: "unsupported", namespace: "team-x" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { pi, emit } = makePiHarness();
  const notifications: Array<{ message: string; level: string }> = [];
  const extension = createRemnicPiExtension({
    config: {
      ...baseConfig(),
      authToken: "test-token",
      namespace: "team-x",
      recallEnabled: false,
      observeEnabled: false,
      compactionEnabled: false,
      mcpToolsEnabled: false,
      statusEnabled: false,
    },
  });
  await extension(pi as unknown as Parameters<typeof extension>[0]);

  await emit("session_start", {}, {
    cwd: "/tmp/remnic-pi",
    ui: { setStatus: () => {}, notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => "preflight-unsupported", getEntries: () => [] },
  });

  const err = notifications.find((n) => n.level === "error");
  assert.ok(err, "expected an error notification");
  assert.match(err?.message ?? "", /namespaces disabled/);
  assert.doesNotMatch(err?.message ?? "", /namespacePolicies entry/);
});
