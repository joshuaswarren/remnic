import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import {
  maybeRegisterDelegateRuntime,
  registerDelegateRuntime,
  type DelegateRuntimeOptions,
} from "./delegate-runtime.js";
import { resolveBridgeMode } from "./bridge.js";

type HookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => unknown;

interface RecordedCall {
  pathname: string;
  body: Record<string, unknown>;
}

interface DaemonStub {
  port: number;
  calls: RecordedCall[];
  close: () => Promise<void>;
}

interface RecordingApi {
  handlers: Map<string, HookHandler[]>;
  hookOpts: Map<string, unknown>;
  on: (hook: string, handler: HookHandler, opts?: { timeoutMs?: number }) => void;
}

function recordingApi(): RecordingApi {
  const handlers = new Map<string, HookHandler[]>();
  const hookOpts = new Map<string, unknown>();
  return {
    handlers,
    hookOpts,
    on(hook: string, handler: HookHandler, opts?: { timeoutMs?: number }): void {
      const list = handlers.get(hook) ?? [];
      list.push(handler);
      handlers.set(hook, list);
      if (opts !== undefined) hookOpts.set(hook, opts);
    },
  };
}

async function startDaemonStub(
  respond: (pathname: string) => Record<string, unknown>,
): Promise<DaemonStub> {
  const calls: RecordedCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const pathname = req.url ?? "";
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // empty/non-JSON bodies stay {}
      }
      calls.push({ pathname, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(respond(pathname)));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  try {
    await listening.promise;
  } catch (err) {
    server.close();
    throw err;
  }
  const address = server.address();
  if (address === null || typeof address !== "object") {
    server.close();
    throw new Error("stub did not bind");
  }
  return {
    port: address.port,
    calls,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

function optionsFor(port: number, overrides: Partial<DelegateRuntimeOptions> = {}): DelegateRuntimeOptions {
  return {
    serviceId: "openclaw-remnic",
    target: { host: "127.0.0.1", port, authToken: "test-token" },
    namespace: "",
    allowPromptInjection: true,
    passive: false,
    gateHeartbeatTurns: false,
    recallBudgetChars: 8_000,
    resolveSessionDisabled: async () => false,
    cleanUserMessage: (text: string) => text,
    hookTimeoutMs: 5_000,
    shouldSkipRecall: () => false,
    flushOnResetEnabled: true,
    recallTimeoutMs: 5_000,
    observeTimeoutMs: 5_000,
    flushTimeoutMs: 5_000,
    ...overrides,
  };
}

async function invoke(
  api: RecordingApi,
  hook: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown> = {},
): Promise<unknown> {
  const list = api.handlers.get(hook);
  assert.ok(list && list.length === 1, `exactly one handler registered for ${hook}`);
  return await list[0](event, ctx);
}

test("delegate recall injects daemon context under the memory header", async () => {
  const stub = await startDaemonStub(() => ({ context: "remembered daemon context", count: 2 }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));

    const result = (await invoke(
      api,
      "before_prompt_build",
      { prompt: "what did we decide about the rollout?" },
      { sessionKey: "session-a" },
    )) as Record<string, unknown>;

    assert.ok(result, "recall handler returns an injection");
    assert.match(String(result.prependSystemContext), /## Memory Context \(Remnic\)/);
    assert.match(String(result.prependSystemContext), /remembered daemon context/);
    assert.equal(result.prependContext, result.prependSystemContext);

    const recall = stub.calls.find((call) => call.pathname === "/engram/v1/recall");
    assert.ok(recall, "daemon recall route was called");
    assert.equal(recall.body.sessionKey, "session-a");
    assert.equal(recall.body.query, "what did we decide about the rollout?");
  } finally {
    await stub.close();
  }
});

test("delegate recall degrades to no injection when the daemon fails", async () => {
  const stub = await startDaemonStub(() => {
    throw new Error("unreachable"); // respond() throwing crashes the handler; use 500 instead
  });
  await stub.close();
  // Point at the now-closed port: connection refused.
  const api = recordingApi();
  registerDelegateRuntime(api, optionsFor(stub.port));
  const result = await invoke(
    api,
    "before_agent_start",
    { prompt: "anything at all here" },
    { sessionKey: "session-b" },
  );
  assert.equal(result, undefined, "daemon failure must not break the agent turn");
});

test("delegate agent_end observes exactly the last turn's textual messages", async () => {
  const stub = await startDaemonStub(() => ({ accepted: 2 }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));

    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "new question" },
          { role: "toolResult", content: "tool noise" },
          { role: "assistant", content: [{ type: "text", text: "new answer" }] },
        ],
      },
      { sessionKey: "session-c" },
    );

    const observe = stub.calls.find((call) => call.pathname === "/engram/v1/observe");
    assert.ok(observe, "daemon observe route was called");
    const messages = observe.body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(
      messages,
      [
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
      ],
      "only the last user/assistant turn is observed, tool noise dropped",
    );
  } finally {
    await stub.close();
  }
});

test("delegate flush fires on compaction, reset, and session end", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));

    await invoke(api, "before_compaction", {}, { sessionKey: "s1" });
    await invoke(api, "before_reset", { sessionKey: "s2" }, {});
    await invoke(api, "session_end", {}, { sessionKey: "s3" });

    const flushes = stub.calls.filter(
      (call) => call.pathname === "/engram/v1/lcm/compaction/flush",
    );
    assert.deepEqual(
      flushes.map((call) => call.body.sessionKey),
      ["s1", "s2", "s3"],
      "each lifecycle boundary flushes its own session",
    );
  } finally {
    await stub.close();
  }
});

test("delegate passive mode registers no hooks", async () => {
  const api = recordingApi();
  registerDelegateRuntime(api, optionsFor(1, { passive: true }));
  assert.equal(api.handlers.size, 0, "passive slot mode must not register hooks");
});

test("delegate honors allowPromptInjection=false but keeps observe/flush", async () => {
  const api = recordingApi();
  registerDelegateRuntime(api, optionsFor(1, { allowPromptInjection: false }));
  assert.equal(api.handlers.has("before_prompt_build"), false);
  assert.equal(api.handlers.has("before_agent_start"), false);
  assert.ok(api.handlers.has("agent_end"), "observe hook still registered");
  assert.ok(api.handlers.has("before_reset"), "flush hooks still registered");
});

test("resolveBridgeMode is explicit-only: config delegate activates, absence stays embedded", () => {
  const priorEnv = process.env.REMNIC_BRIDGE_MODE;
  Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
  try {
    assert.equal(resolveBridgeMode("embedded").mode, "embedded");
    assert.equal(resolveBridgeMode("delegate").mode, "delegate");
    process.env.REMNIC_BRIDGE_MODE = "embedded";
    assert.equal(
      resolveBridgeMode("delegate").mode,
      "embedded",
      "env override outranks config",
    );
  } finally {
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorEnv;
  }
});

test("delegate observe skips heartbeat-triggered turns when gated", async () => {
  const stub = await startDaemonStub(() => ({ accepted: 0 }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { gateHeartbeatTurns: true }));
    await invoke(
      api,
      "agent_end",
      {
        success: true,
        trigger: "heartbeat",
        messages: [{ role: "user", content: "heartbeat chatter" }],
      },
      { sessionKey: "hb" },
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/observe").length,
      0,
      "heartbeat turns must not be observed when the gate is on",
    );
  } finally {
    await stub.close();
  }
});

test("delegate recall trims injected context to recallBudgetChars", async () => {
  const stub = await startDaemonStub(() => ({ context: "x".repeat(500) }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { recallBudgetChars: 100 }));
    const result = (await invoke(
      api,
      "before_prompt_build",
      { prompt: "long enough query" },
      { sessionKey: "budget" },
    )) as Record<string, unknown>;
    const injected = String(result.prependSystemContext);
    assert.ok(
      injected.length <= 100 + "## Memory Context (Remnic)\n\n".length,
      `injection stays within budget (+header): got ${injected.length}`,
    );
  } finally {
    await stub.close();
  }
});

test("delegate uses the section builder on hosts that expose it (no hook injection)", async () => {
  const stub = await startDaemonStub(() => ({ context: "section daemon context" }));
  try {
    const api = recordingApi();
    const captured: {
      builder: null | ((params: { sessionKey?: string }) => string[] | null);
    } = { builder: null };
    const sectionApi = Object.assign(api, {
      registerMemoryPromptSection(builder: (params: { sessionKey?: string }) => string[] | null): void {
        captured.builder = builder;
      },
    });
    registerDelegateRuntime(sectionApi, optionsFor(stub.port));
    const builder = captured.builder;
    if (builder === null) {
      throw new Error("section builder was not registered");
    }

    const result = await invoke(
      api,
      "before_prompt_build",
      { prompt: "query for the section path" },
      { sessionKey: "sect" },
    );
    assert.equal(result, undefined, "hook must not inject when the builder owns injection");
    const lines = builder({ sessionKey: "sect" });
    assert.ok(lines && lines.join("\n").includes("section daemon context"), "builder serves the recall");
    assert.equal(builder({ sessionKey: "sect" }), null, "consumed lines are evicted");
  } finally {
    await stub.close();
  }
});

test("maybeRegisterDelegateRuntime deduplicates hook binding per api object", async () => {
  const stub = await startDaemonStub(() => ({ context: "ctx" }));
  try {
    const priorEnv = process.env.REMNIC_BRIDGE_MODE;
    const priorHost = process.env.REMNIC_HOST;
    const priorPort = process.env.REMNIC_PORT;
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    process.env.REMNIC_PORT = String(stub.port);
    try {
      const api = recordingApi();
      const opts = {
        serviceId: "openclaw-remnic",
        configBridgeMode: "delegate",
        passive: false,
        allowPromptInjection: true,
        gateHeartbeatTurns: false,
        recallBudgetChars: 8_000,
        memoryDir: "/tmp/remnic-delegate-test-memory",
        sessionTogglesEnabled: false,
        respectBundledActiveMemoryToggle: false,
        cleanUserMessage: (text: string) => text,
        hookTimeoutMs: 5_000,
        shouldSkipRecall: () => false,
        flushOnResetEnabled: true,
      };
      const healthDeps = { checkHealth: () => true };
      const first = maybeRegisterDelegateRuntime(api, opts, healthDeps);
      const second = maybeRegisterDelegateRuntime(api, opts, healthDeps);
      assert.equal(first, true, "first registration handles delegate");
      assert.equal(second, true, "second call still reports delegate handled");
      assert.equal(
        api.handlers.get("agent_end")?.length ?? 0,
        1,
        "hooks are bound exactly once per api object",
      );
      const legacy = maybeRegisterDelegateRuntime(
        api,
        { ...opts, serviceId: "openclaw-engram" },
        healthDeps,
      );
      assert.equal(legacy, true, "legacy service registers on the same api");
      assert.equal(
        api.handlers.get("agent_end")?.length ?? 0,
        2,
        "dedupe is scoped per serviceId, not per api object",
      );
    } finally {
      if (priorEnv === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
      else process.env.REMNIC_BRIDGE_MODE = priorEnv;
      if (priorHost === undefined) Reflect.deleteProperty(process.env, "REMNIC_HOST");
      else process.env.REMNIC_HOST = priorHost;
      if (priorPort === undefined) Reflect.deleteProperty(process.env, "REMNIC_PORT");
      else process.env.REMNIC_PORT = priorPort;
    }
  } finally {
    await stub.close();
  }
});

test("delegate recall registers with the configured hook timeout", async () => {
  const api = recordingApi();
  registerDelegateRuntime(api, optionsFor(1, { hookTimeoutMs: 1_234 }));
  assert.deepEqual(api.hookOpts.get("before_prompt_build"), { timeoutMs: 1_234 });
  assert.deepEqual(api.hookOpts.get("before_agent_start"), { timeoutMs: 1_234 });
});

test("delegate honors the zero-budget disable contract (no injection hooks)", () => {
  const api = recordingApi();
  registerDelegateRuntime(api, optionsFor(1, { recallBudgetChars: 0 }));
  assert.equal(api.handlers.has("before_prompt_build"), false, "0 disables recall injection");
  assert.equal(api.handlers.has("before_agent_start"), false);
  assert.ok(api.handlers.has("agent_end"), "observe is unaffected by the injection budget");
});

test("delegate recall skips sessions whose memory toggle is disabled", async () => {
  const stub = await startDaemonStub(() => ({ context: "should never inject" }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, {
        resolveSessionDisabled: async (sessionKey: string) => sessionKey === "muted",
      }),
    );
    const muted = await invoke(
      api,
      "before_prompt_build",
      { prompt: "query in a muted session" },
      { sessionKey: "muted" },
    );
    assert.equal(muted, undefined, "disabled session gets no injection");
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/recall").length,
      0,
      "daemon recall is not even attempted for a disabled session",
    );
    const active = (await invoke(
      api,
      "before_prompt_build",
      { prompt: "query in an active session" },
      { sessionKey: "active" },
    )) as Record<string, unknown>;
    assert.ok(active, "other sessions still recall normally");
  } finally {
    await stub.close();
  }
});

test("delegate observe cleans user envelopes but not assistant text", async () => {
  const stub = await startDaemonStub(() => ({ accepted: 2 }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, {
        cleanUserMessage: (text: string) => text.replace(/^\[channel\] /, ""),
      }),
    );
    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "[channel] the real question" },
          { role: "assistant", content: "[channel] stays verbatim" },
        ],
      },
      { sessionKey: "clean" },
    );
    const observe = stub.calls.find((call) => call.pathname === "/engram/v1/observe");
    assert.ok(observe, "observe was sent");
    assert.deepEqual(observe.body.messages, [
      { role: "user", content: "the real question" },
      { role: "assistant", content: "[channel] stays verbatim" },
    ]);
  } finally {
    await stub.close();
  }
});

test("delegate recall honors the cron-skip policy", async () => {
  const stub = await startDaemonStub(() => ({ context: "cron recall leaked" }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, {
        shouldSkipRecall: (sessionKey: string) => sessionKey.includes(":cron:"),
      }),
    );
    const cron = await invoke(
      api,
      "before_prompt_build",
      { prompt: "cron background query" },
      { sessionKey: "agent:cron:nighly" },
    );
    assert.equal(cron, undefined, "cron session gets no recall");
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/recall").length,
      0,
      "daemon recall never attempted for a cron session",
    );
  } finally {
    await stub.close();
  }
});

test("delegate flushOnResetEnabled=false skips reset and session_end flush", () => {
  const api = recordingApi();
  registerDelegateRuntime(api, optionsFor(1, { flushOnResetEnabled: false }));
  assert.ok(api.handlers.has("before_compaction"), "compaction flush always registers");
  assert.equal(api.handlers.has("before_reset"), false, "reset flush gated off");
  assert.equal(api.handlers.has("session_end"), false, "session_end flush gated off");
});
