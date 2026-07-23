import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import { registerDelegateRuntime, type DelegateRuntimeOptions } from "./delegate-runtime.js";
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
  on: (hook: string, handler: HookHandler) => void;
}

function recordingApi(): RecordingApi {
  const handlers = new Map<string, HookHandler[]>();
  return {
    handlers,
    on(hook: string, handler: HookHandler): void {
      const list = handlers.get(hook) ?? [];
      list.push(handler);
      handlers.set(hook, list);
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
