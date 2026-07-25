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
    assert.equal(
      result.prependContext,
      undefined,
      "before_prompt_build returns only prependSystemContext (dual keys could double-inject)",
    );

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

test("delegate lifecycle drains scoped extraction even when LCM is disabled", async () => {
  const stub = await startDaemonStub((pathname) =>
    pathname === "/engram/v1/lcm/compaction/flush"
      ? { enabled: false, flushed: false }
      : { flushed: true },
  );
  try {
    const api = recordingApi();
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, {
        namespace: "work",
        cwd: "/registration/base",
        projectTag: "Acme/Webshop",
      }),
    );

    const deadlineFloor = Date.now();
    await invoke(
      api,
      "before_compaction",
      { sessionKey: "s1", workspaceDir: "/event/compaction" },
      {},
    );
    await invoke(
      api,
      "before_reset",
      { sessionKey: "s2" },
      { workspaceDir: "/ctx/reset" },
    );
    await invoke(api, "session_end", {}, { sessionKey: "s3" });

    const lcmFlushes = stub.calls.filter(
      (call) => call.pathname === "/engram/v1/lcm/compaction/flush",
    );
    assert.deepEqual(
      lcmFlushes.map((call) => call.body.sessionKey),
      ["s1", "s2", "s3"],
      "each lifecycle boundary flushes its own LCM session",
    );

    const extractionFlushes = stub.calls.filter(
      (call) => call.pathname === "/engram/v1/extraction/force-flush",
    );
    const extractionScopes = extractionFlushes.map((call) => {
      const { deadlineMs, ...scope } = call.body;
      assert.ok(
        typeof deadlineMs === "number",
        "extraction drain forwards an absolute deadline",
      );
      assert.ok(
        deadlineMs > deadlineFloor,
        "extraction deadline starts from the lifecycle hook's shared timeout window",
      );
      return scope;
    });
    assert.deepEqual(
      extractionScopes,
      [
        {
          sessionKey: "s1",
          namespace: "work",
          cwd: "/event/compaction",
          projectTag: "Acme/Webshop",
        },
        {
          sessionKey: "s2",
          namespace: "work",
          cwd: "/ctx/reset",
          projectTag: "Acme/Webshop",
        },
        {
          sessionKey: "s3",
          namespace: "work",
          cwd: "/registration/base",
          projectTag: "Acme/Webshop",
        },
      ],
      "each lifecycle boundary drains the matching scoped extraction buffer once",
    );
  } finally {
    await stub.close();
  }
});

test("delegate lifecycle never falls back to the default extraction buffer", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));

    await invoke(api, "before_compaction", {}, {});

    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush").length,
      1,
      "legacy LCM flush behavior stays intact",
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/extraction/force-flush").length,
      0,
      "extraction drain requires an explicit lifecycle session",
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
    Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    assert.equal(resolveBridgeMode("embedded").mode, "embedded");
    assert.equal(resolveBridgeMode("").mode, "embedded");
    assert.throws(() => resolveBridgeMode("daemon"), /Invalid bridgeMode/);
    assert.throws(() => resolveBridgeMode("DELEGATE"), /Invalid bridgeMode/);
    process.env.REMNIC_BRIDGE_MODE = "daemon";
    assert.throws(
      () => resolveBridgeMode("embedded"),
      /Invalid REMNIC_BRIDGE_MODE env override/,
      "an invalid env override is rejected, not silently ignored",
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
    const marker = "\n\n...(memory context trimmed)";
    assert.ok(
      injected.length <= 100 + "## Memory Context (Remnic)\n\n".length + marker.length,
      `injection stays within budget (+header +marker): got ${injected.length}`,
    );
    assert.match(injected, /x{100}/, "trim retains the leading 100 budget chars of context");
    assert.ok(injected.endsWith(marker), "embedded-parity trim marker appended");
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

test("delegate flushOnResetEnabled=false keeps the compaction drains only", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { flushOnResetEnabled: false }));
    assert.ok(api.handlers.has("before_compaction"), "compaction drain always registers");
    assert.equal(api.handlers.has("before_reset"), false, "reset drain gated off");
    assert.equal(api.handlers.has("session_end"), false, "session-end drain gated off");

    await invoke(api, "before_compaction", {}, { sessionKey: "compaction-only" });

    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush").length,
      1,
      "compaction still drains LCM once",
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/extraction/force-flush").length,
      1,
      "compaction still drains extraction once",
    );
  } finally {
    await stub.close();
  }
});

test("maybeRegister stays embedded after a daemon-down fallback (no stacking)", async () => {
  const priorEnv = process.env.REMNIC_BRIDGE_MODE;
  process.env.REMNIC_BRIDGE_MODE = "delegate";
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
      cleanUserMessage: (t: string) => t,
      hookTimeoutMs: 5_000,
      shouldSkipRecall: () => false,
      flushOnResetEnabled: true,
    };
    // First call: daemon down -> falls back to embedded.
    let first = maybeRegisterDelegateRuntime(api, opts, { checkHealth: () => false });
    assert.equal(first, false, "daemon down falls back to embedded");
    // Second call on the SAME api: daemon now up, but must NOT switch to delegate
    // (embedded hooks from the fallback are still bound — switching would stack).
    let second = maybeRegisterDelegateRuntime(api, opts, { checkHealth: () => true });
    assert.equal(second, false, "stays embedded to avoid stacking memory paths");
    assert.equal(
      api.handlers.size,
      0,
      "no delegate hooks bound after a prior embedded fallback",
    );
  } finally {
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorEnv;
  }
});

test("delegate recall degrades to no injection on a daemon HTTP error response", async () => {
  const stub = await startDaemonStub(() => {
    throw new Error("boom"); // startDaemonStub catches nothing: force via 500 below
  });
  await stub.close();
  const errServer = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.end("{}");
  });
  const listening = Promise.withResolvers<void>();
  errServer.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = errServer.address();
  if (address === null || typeof address !== "object") throw new Error("no bind");
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(address.port));
    const result = await invoke(
      api,
      "before_prompt_build",
      { prompt: "long enough query text" },
      { sessionKey: "http-500" },
    );
    assert.equal(result, undefined, "HTTP 500 from the daemon must not break the turn");
  } finally {
    const closed = Promise.withResolvers<void>();
    errServer.close(() => closed.resolve());
    await closed.promise;
  }
});

test("delegate recall prefers the hook-scoped workspace dir over registration cwd", async () => {
  const stub = await startDaemonStub(() => ({ context: "scoped context" }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { cwd: "/registration/base" }));
    await invoke(
      api,
      "before_prompt_build",
      { prompt: "project scoped query" },
      { sessionKey: "scoped", workspaceDir: "/hook/project" },
    );
    const recall = stub.calls.find((call) => call.pathname === "/engram/v1/recall");
    assert.ok(recall, "recall sent");
    assert.equal(recall.body.cwd, "/hook/project", "hook ctx workspaceDir wins");
    await invoke(
      api,
      "before_prompt_build",
      { prompt: "another scoped query" },
      { sessionKey: "fallback" },
    );
    const second = stub.calls.filter((call) => call.pathname === "/engram/v1/recall")[1];
    assert.equal(second?.body.cwd, "/registration/base", "falls back to registration cwd");
  } finally {
    await stub.close();
  }
});

test("maybeRegister: invalid bridgeMode logs and falls back to embedded (no throw)", () => {
  const priorEnv = process.env.REMNIC_BRIDGE_MODE;
  Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
  try {
    const api = recordingApi();
    const opts = {
      serviceId: "openclaw-remnic",
      configBridgeMode: "daemon",
      passive: false,
      allowPromptInjection: true,
      gateHeartbeatTurns: false,
      recallBudgetChars: 8_000,
      memoryDir: "/tmp/remnic-delegate-test-memory",
      sessionTogglesEnabled: false,
      respectBundledActiveMemoryToggle: false,
      cleanUserMessage: (t: string) => t,
      hookTimeoutMs: 5_000,
      shouldSkipRecall: () => false,
      flushOnResetEnabled: true,
    };
    let handled = true;
    assert.doesNotThrow(() => {
      handled = maybeRegisterDelegateRuntime(api, opts, { checkHealth: () => true });
    }, "invalid bridgeMode must not abort plugin registration");
    assert.equal(handled, false, "falls back to embedded");
    assert.equal(api.handlers.size, 0, "no delegate hooks bound");
  } finally {
    if (priorEnv !== undefined) process.env.REMNIC_BRIDGE_MODE = priorEnv;
  }
});

test("maybeRegister: passive registration does not poison a later active one", () => {
  const priorEnv = process.env.REMNIC_BRIDGE_MODE;
  process.env.REMNIC_BRIDGE_MODE = "delegate";
  try {
    const api = recordingApi();
    const opts = {
      serviceId: "openclaw-remnic",
      configBridgeMode: "delegate",
      passive: true,
      allowPromptInjection: true,
      gateHeartbeatTurns: false,
      recallBudgetChars: 8_000,
      memoryDir: "/tmp/remnic-delegate-test-memory",
      sessionTogglesEnabled: false,
      respectBundledActiveMemoryToggle: false,
      cleanUserMessage: (t: string) => t,
      hookTimeoutMs: 5_000,
      shouldSkipRecall: () => false,
      flushOnResetEnabled: true,
    };
    const healthDeps = { checkHealth: () => true };
    assert.equal(maybeRegisterDelegateRuntime(api, opts, healthDeps), true, "passive handled");
    assert.equal(api.handlers.size, 0, "passive binds no hooks");
    const active = maybeRegisterDelegateRuntime(api, { ...opts, passive: false }, healthDeps);
    assert.equal(active, true, "later active registration is not deduped away");
    assert.ok((api.handlers.get("agent_end")?.length ?? 0) >= 1, "active registration binds hooks");
  } finally {
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorEnv;
  }
});

test("delegate observe drops sub-10-char noise turns (embedded parity)", async () => {
  const stub = await startDaemonStub(() => ({ accepted: 0 }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    await invoke(
      api,
      "agent_end",
      { success: true, messages: [{ role: "user", content: "ok" }, { role: "assistant", content: "yes" }] },
      { sessionKey: "noise" },
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/observe").length,
      0,
      "all-noise turn is not observed",
    );
  } finally {
    await stub.close();
  }
});

test("maybeRegister: an embedded-mode registration blocks a later delegate flip on the same api", () => {
  const priorEnv = process.env.REMNIC_BRIDGE_MODE;
  Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
  try {
    const api = recordingApi();
    const opts = {
      serviceId: "openclaw-remnic",
      configBridgeMode: "embedded",
      passive: false,
      allowPromptInjection: true,
      gateHeartbeatTurns: false,
      recallBudgetChars: 8_000,
      memoryDir: "/tmp/remnic-delegate-test-memory",
      sessionTogglesEnabled: false,
      respectBundledActiveMemoryToggle: false,
      cleanUserMessage: (t: string) => t,
      hookTimeoutMs: 5_000,
      shouldSkipRecall: () => false,
      flushOnResetEnabled: true,
    };
    const healthDeps = { checkHealth: () => true };
    assert.equal(maybeRegisterDelegateRuntime(api, opts, healthDeps), false, "embedded mode");
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    assert.equal(
      maybeRegisterDelegateRuntime(api, opts, healthDeps),
      false,
      "a reload flipping to delegate on the same api stays embedded (no stacking)",
    );
    assert.equal(api.handlers.size, 0, "no delegate hooks bound");
  } finally {
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorEnv;
  }
});
