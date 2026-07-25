import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { initLogger, resetLogger } from "@remnic/core/logger";

import {
  maybeRegisterDelegateRuntime,
  probeDelegateAuthorization,
  registerDelegateRuntime,
  type DelegateRuntimeOptions,
  type MaybeRegisterDelegateDeps,
} from "./delegate-runtime.js";
import { loadDaemonAuth, resolveBridgeMode } from "./bridge.js";
import {
  createFileSessionNamespaceBindingStore,
  createInMemorySessionNamespaceBindingStore,
} from "@remnic/core/session-namespace-bindings";

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
  respond: (
    pathname: string,
    body: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
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
      void Promise.resolve(respond(pathname, body))
        .then((response) => {
          if (res.destroyed) return;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(response));
        })
        .catch(() => {
          if (res.destroyed) return;
          res.statusCode = 500;
          res.end();
        });
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
    target: {
      host: "127.0.0.1",
      port,
      resolveAuthToken: () => ({
        token: "test-token",
        source: "OPENCLAW_REMNIC_ACCESS_TOKEN",
      }),
    },
    namespace: "",
    namespaceBindings: createInMemorySessionNamespaceBindingStore(),
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
    assert.equal("namespace" in recall.body, false, "default sessions preserve daemon default scope");
  } finally {
    await stub.close();
  }
});

test("delegate preserves the daemon's curiosity footer when applying a tighter budget", async () => {
  const footer =
    "## Open Question\n\n" +
    "Something I've been curious about: Which release needs an owner?\n\n" +
    "_Context: The rollout is blocked._";
  const body = "Remember the release plan. ".repeat(12);
  const stub = await startDaemonStub(() => ({
    context: `${body}\n\n---\n\n${footer}`,
    contextComposition: { context: body, footer },
  }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { recallBudgetChars: footer.length + 30 }));

    const result = await invoke(
      api,
      "before_prompt_build",
      { prompt: "Which release decision needs review?" },
      { sessionKey: "footer-session" },
    );

    assert.ok(result && typeof result === "object");
    assert.ok("prependSystemContext" in result);
    assert.match(String(result.prependSystemContext), /Which release needs an owner\?/);
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

test("delegate forwards the hook session namespace to recall, observe, and flush", async () => {
  const stub = await startDaemonStub((pathname) =>
    pathname === "/engram/v1/recall" ? { context: "scoped daemon context" } : { accepted: true },
  );
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const ctx = {
      sessionKey: "scoped-session",
      runtime: { agent: { session: { namespace: "team-alpha" } } },
    };

    await invoke(api, "before_prompt_build", { prompt: "recall scoped memory" }, ctx);
    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture scoped memory" },
          { role: "assistant", content: "scoped answer" },
        ],
      },
      ctx,
    );
    await invoke(api, "before_compaction", {}, ctx);

    const calls = stub.calls.filter((call) =>
      [
        "/engram/v1/recall",
        "/engram/v1/observe",
        "/engram/v1/lcm/compaction/flush",
      ].includes(call.pathname),
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((call) => call.body.namespace),
      ["team-alpha", "team-alpha", "team-alpha"],
    );
  } finally {
    await stub.close();
  }
});

test("delegate flush uses the ended session namespace after a session rebinding", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));

    await invoke(
      api,
      "before_reset",
      {
        sessionKey: "ended-session",
        runtime: { agent: { session: { namespace: "team-ended" } } },
      },
      {
        sessionKey: "successor-session",
        runtime: { agent: { session: { namespace: "team-successor" } } },
      },
    );

    const flush = stub.calls.find((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush);
    assert.equal(flush.body.sessionKey, "ended-session");
    assert.equal(flush.body.namespace, "team-ended");
  } finally {
    await stub.close();
  }
});

test("delegate fails closed when binding persistence fails", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, {
        namespaceBindings: {
          namespacesFor: async () => [],
          remember: async () => {
            throw new Error("binding storage unavailable");
          },
        },
      }),
    );

    await invoke(api, "session_end", {
      sessionKey: "persist-failure-session",
      runtime: { agent: { session: { namespace: "team-explicit" } } },
    });

    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush").length,
      0,
      "an explicit namespace must not be sent when its binding cannot be retained",
    );
  } finally {
    await stub.close();
  }
});

test("delegate records a matching default scope as a session rebind", async () => {
  const stub = await startDaemonStub((pathname) =>
    pathname === "/engram/v1/recall" ? { context: "default daemon context" } : { accepted: true },
  );
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const sessionKey = "default-rebound-session";

    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture the named session namespace" },
          { role: "assistant", content: "the namespace is bound" },
        ],
      },
      { sessionKey, runtime: { agent: { session: { namespace: "team-named" } } } },
    );
    const defaultScopeContext = { sessionKey, runtime: { agent: { session: {} } } };
    await invoke(
      api,
      "before_prompt_build",
      { prompt: "recall from the new default scope" },
      defaultScopeContext,
    );
    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture the new default scope" },
          { role: "assistant", content: "the default binding is explicit" },
        ],
      },
      defaultScopeContext,
    );
    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture sparse default scope metadata" },
          { role: "assistant", content: "the default binding remains current" },
        ],
      },
      { sessionKey },
    );

    const calls = stub.calls.filter((call) =>
      ["/engram/v1/recall", "/engram/v1/observe"].includes(call.pathname),
    );
    assert.equal(calls.length, 4);
    assert.equal(calls[0].body.namespace, "team-named");
    for (const call of calls.slice(1)) {
      assert.equal("namespace" in call.body, false);
    }
  } finally {
    await stub.close();
  }
});

test("delegate ignores unkeyed runtime metadata when resolving an ended session namespace", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));

    await invoke(
      api,
      "before_reset",
      { sessionKey: "ended-session" },
      { runtime: { agent: { session: { namespace: "team-successor" } } } },
    );

    const flush = stub.calls.find((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush);
    assert.equal(flush.body.sessionKey, "ended-session");
    assert.equal("namespace" in flush.body, false);
  } finally {
    await stub.close();
  }
});

test("delegate rejects malformed lifecycle session keys without ambient fallback", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const ctx = {
      sessionKey: "successor-session",
      runtime: { agent: { session: { namespace: "team-successor" } } },
    };

    for (const hook of ["before_reset", "session_end"]) {
      for (const sessionKey of [42, null, {}, ""]) {
        await invoke(api, hook, { sessionKey }, ctx);
      }
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("delegate rejects malformed namespace metadata without defaulting", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const ctx = {
      sessionKey: "malformed-session",
      runtime: { agent: { session: { namespace: 42 } } },
    };

    assert.equal(await invoke(api, "before_prompt_build", { prompt: "recall malformed scope" }, ctx), undefined);
    assert.equal(
      await invoke(
        api,
        "agent_end",
        {
          success: true,
          messages: [
            { role: "user", content: "capture malformed scope metadata" },
            { role: "assistant", content: "do not route this turn" },
          ],
        },
        ctx,
      ),
      undefined,
    );
    assert.equal(await invoke(api, "before_compaction", {}, ctx), false);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("delegate retains a proven namespace binding for a sparse ended-session flush", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const endedContext = {
      sessionKey: "ended-session",
      runtime: { agent: { session: { namespace: "team-ended" } } },
    };

    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture the ended session namespace" },
          { role: "assistant", content: "the namespace is bound" },
        ],
      },
      endedContext,
    );
    await invoke(
      api,
      "before_reset",
      { sessionKey: "ended-session" },
      {
        sessionKey: "successor-session",
        runtime: { agent: { session: { namespace: "team-successor" } } },
      },
    );

    const flush = stub.calls.find((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush);
    assert.equal(flush.body.sessionKey, "ended-session");
    assert.equal(flush.body.namespace, "team-ended");
  } finally {
    await stub.close();
  }
});

test("delegate retains a namespace binding after a failed ended-session flush", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  const unavailable = await startDaemonStub(() => ({ accepted: true }));
  const unavailablePort = unavailable.port;
  await unavailable.close();
  try {
    const api = recordingApi();
    const options = optionsFor(stub.port);
    registerDelegateRuntime(api, options);
    const endedContext = {
      sessionKey: "retry-session",
      runtime: { agent: { session: { namespace: "team-retry" } } },
    };

    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture the retry session namespace" },
          { role: "assistant", content: "the namespace is bound" },
        ],
      },
      endedContext,
    );
    options.target.port = unavailablePort;
    await invoke(api, "before_reset", { sessionKey: "retry-session" });
    options.target.port = stub.port;
    await invoke(api, "session_end", { sessionKey: "retry-session" });

    const flush = stub.calls.find((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush);
    assert.equal(flush.body.sessionKey, "retry-session");
    assert.equal(flush.body.namespace, "team-retry");
  } finally {
    await stub.close();
  }
});

test("delegate retains a namespace binding across runtime re-registration", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  try {
    const namespaceBindings = createInMemorySessionNamespaceBindingStore();
    const originalApi = recordingApi();
    registerDelegateRuntime(originalApi, optionsFor(stub.port, { namespaceBindings }));
    const endedContext = {
      sessionKey: "reload-session",
      runtime: { agent: { session: { namespace: "team-reload" } } },
    };

    await invoke(
      originalApi,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture the reload session namespace" },
          { role: "assistant", content: "the namespace is bound" },
        ],
      },
      endedContext,
    );

    const reloadedApi = recordingApi();
    registerDelegateRuntime(reloadedApi, optionsFor(stub.port, { namespaceBindings }));
    await invoke(reloadedApi, "session_end", { sessionKey: "reload-session" });

    const flush = stub.calls.find((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush);
    assert.equal(flush.body.sessionKey, "reload-session");
    assert.equal(flush.body.namespace, "team-reload");
  } finally {
    await stub.close();
  }
});

test("delegate replays ended-session flushes in the remembered namespace", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const endedContext = {
      sessionKey: "replayed-session",
      runtime: { agent: { session: { namespace: "team-replayed" } } },
    };

    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture the replayed session namespace" },
          { role: "assistant", content: "the namespace is bound" },
        ],
      },
      endedContext,
    );
    await invoke(api, "before_reset", { sessionKey: "replayed-session" });
    await invoke(api, "session_end", { sessionKey: "replayed-session" });

    const flushes = stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.deepEqual(
      flushes.map((call) => call.body.namespace),
      ["team-replayed", "team-replayed"],
    );
  } finally {
    await stub.close();
  }
});

test("delegate flushes every namespace observed before a session rebind", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const sessionKey = "rebound-session";

    for (const namespace of ["team-first", "team-second"]) {
      await invoke(
        api,
        "agent_end",
        {
          success: true,
          messages: [
            { role: "user", content: `capture the ${namespace} session namespace` },
            { role: "assistant", content: "the namespace is bound" },
          ],
        },
        { sessionKey, runtime: { agent: { session: { namespace } } } },
      );
    }
    await invoke(api, "session_end", { sessionKey });

    const flushes = stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.equal(flushes.length, 1);
    assert.deepEqual(flushes[0]?.body.namespaces, ["team-first", "team-second"]);
  } finally {
    await stub.close();
  }
});

test("delegate batches rebound namespace flushes within one hook deadline", async () => {
  const pendingFlushes: Array<() => void> = [];
  const stub = await startDaemonStub((pathname) => {
    if (pathname !== "/engram/v1/lcm/compaction/flush") return { accepted: true };
    return new Promise<Record<string, unknown>>((resolve) => {
      pendingFlushes.push(() => resolve({ flushed: true }));
      if (pendingFlushes.length === 1) {
        for (const flush of pendingFlushes) flush();
      }
    });
  });
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { flushTimeoutMs: 50 }));
    const sessionKey = "concurrent-rebound-session";

    for (const namespace of ["team-first", "team-second"]) {
      await invoke(
        api,
        "agent_end",
        {
          success: true,
          messages: [
            { role: "user", content: `capture the ${namespace} session namespace` },
            { role: "assistant", content: "the namespace is bound" },
          ],
        },
        { sessionKey, runtime: { agent: { session: { namespace } } } },
      );
    }

    assert.equal(await invoke(api, "before_compaction", { sessionKey }), true);
    const flushes = stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.equal(flushes.length, 1);
    assert.deepEqual(flushes[0]?.body.namespaces, ["team-first", "team-second"]);
  } finally {
    for (const flush of pendingFlushes.splice(0)) flush();
    await stub.close();
  }
});

test("delegate reloads a persisted namespace binding after its daemon host configuration changes", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-delegate-bindings-"));
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorHost = process.env.REMNIC_HOST;
  const priorPort = process.env.REMNIC_PORT;
  try {
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    process.env.REMNIC_PORT = String(stub.port);
    const common = {
      serviceId: "persistent-delegate",
      configBridgeMode: "delegate",
      passive: false,
      allowPromptInjection: true,
      gateHeartbeatTurns: false,
      recallBudgetChars: 8_000,
      memoryDir,
      sessionTogglesEnabled: false,
      respectBundledActiveMemoryToggle: false,
      cleanUserMessage: (text: string) => text,
      hookTimeoutMs: 5_000,
      shouldSkipRecall: () => false,
      flushOnResetEnabled: true,
    };
    const firstApi = recordingApi();
    assert.equal(maybeRegisterDelegateRuntime(firstApi, common, { checkHealth: () => true }), true);
    await invoke(
      firstApi,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "capture the persisted namespace binding" },
          { role: "assistant", content: "the namespace is bound" },
        ],
      },
      {
        sessionKey: "persisted-session",
        runtime: { agent: { session: { namespace: "team-persisted" } } },
      },
    );
    const persistedBindings = createFileSessionNamespaceBindingStore(
      path.join(
        memoryDir,
        "state",
        "plugins",
        "persistent-delegate",
        "session-namespace-bindings.json",
      ),
    );
    assert.deepEqual(await persistedBindings.namespacesFor("persisted-session"), ["team-persisted"]);

    process.env.REMNIC_HOST = "localhost";
    const reloadedApi = recordingApi();
    assert.equal(maybeRegisterDelegateRuntime(reloadedApi, common, { checkHealth: () => true }), true);
    await invoke(reloadedApi, "session_end", { sessionKey: "persisted-session" });

    const flush = stub.calls.find((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush);
    assert.equal(flush.body.namespace, "team-persisted");
  } finally {
    if (priorMode === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorMode;
    if (priorHost === undefined) Reflect.deleteProperty(process.env, "REMNIC_HOST");
    else process.env.REMNIC_HOST = priorHost;
    if (priorPort === undefined) Reflect.deleteProperty(process.env, "REMNIC_PORT");
    else process.env.REMNIC_PORT = priorPort;
    await rm(memoryDir, { recursive: true, force: true });
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


test("loadDaemonAuth selects only the OpenClaw token from multi-connector stores", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-token-"));
  const priorHome = process.env.HOME;
  const authVariables = [
    "OPENCLAW_REMNIC_ACCESS_TOKEN",
    "OPENCLAW_ENGRAM_ACCESS_TOKEN",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ] as const;
  const priorAuth = new Map(authVariables.map((name) => [name, process.env[name]]));
  try {
    for (const name of authVariables) Reflect.deleteProperty(process.env, name);
    process.env.HOME = tempHome;
    fs.mkdirSync(path.join(tempHome, ".remnic"), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, ".remnic", "tokens.json"),
      JSON.stringify({
        tokens: [
          { token: "remnic_other_token", connector: "other", createdAt: "2026-01-01T00:00:00.000Z" },
          { token: "remnic_openclaw_token", connector: "openclaw", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );

    assert.deepEqual(loadDaemonAuth(), {
      token: "remnic_openclaw_token",
      source: "remnic token store",
    });

    fs.writeFileSync(
      path.join(tempHome, ".remnic", "tokens.json"),
      JSON.stringify({
        tokens: [
          { token: "remnic_other_token", connector: "other", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );
    assert.deepEqual(loadDaemonAuth(), {
      token: "",
      source: "no configured token",
    });
  } finally {
    if (priorHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = priorHome;
    for (const [name, value] of priorAuth) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
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

test("delegate bounds context through the shared prompt renderer", async () => {
  const stub = await startDaemonStub(() => ({ context: "x".repeat(500) }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { recallBudgetChars: 100 }));
    const result = await invoke(
      api,
      "before_prompt_build",
      { prompt: "long enough query" },
      { sessionKey: "budget" },
    );
    assert.ok(result && typeof result === "object" && "prependSystemContext" in result);
    const injected = String(result.prependSystemContext);
    const header = "## Memory Context (Remnic)\n\n";
    const instruction =
      "\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.";
    const marker = "\n\n...(memory context trimmed)";
    assert.equal(
      injected.slice(header.length, injected.indexOf(instruction)),
      "x".repeat(100 - marker.length) + marker,
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

test("delegate runtime reloads a rotated daemon token without re-registering hooks", async () => {
  let currentToken = "expired-token";
  const receivedAuthorization: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    receivedAuthorization.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer accepted-token") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.end(JSON.stringify({ context: "recovered context" }));
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const target: DelegateRuntimeOptions["target"] = {
    host: "127.0.0.1",
    port: address.port,
    resolveAuthToken: () => ({
      token: currentToken,
      source: "OPENCLAW_REMNIC_ACCESS_TOKEN",
    }),
  };
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(address.port, { target }));

    const first = await invoke(
      api,
      "before_prompt_build",
      { prompt: "what did we decide about the durable release?" },
      { sessionKey: "rotation" },
    );
    assert.equal(first, undefined, "the expired token receives no injected context");

    currentToken = "accepted-token";
    const second = await invoke(
      api,
      "before_prompt_build",
      { prompt: "what did we decide about the durable release?" },
      { sessionKey: "rotation" },
    );
    assert.match(String((second as Record<string, unknown>)?.prependSystemContext), /recovered context/);
    assert.deepEqual(receivedAuthorization, ["Bearer expired-token", "Bearer accepted-token"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("delegate daemon auth failures log one sanitized error per route and status", async (t) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  initLogger(
    {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
    false,
    { timestamps: false },
  );
  t.after(() => resetLogger());

  let status: 401 | 403 = 401;
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const target: DelegateRuntimeOptions["target"] = {
    host: "127.0.0.1",
    port: address.port,
    resolveAuthToken: () => ({
      token: "test-token",
      source: "OPENCLAW_REMNIC_ACCESS_TOKEN",
    }),
  };
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(address.port, {
      target,
      serviceId: "auth-logging-test",
    }));

    const recallEvent = { prompt: "what did we decide about the rollout?" };
    await invoke(api, "before_prompt_build", recallEvent, { sessionKey: "auth" });
    await invoke(api, "before_prompt_build", recallEvent, { sessionKey: "auth" });

    status = 403;
    await invoke(api, "before_prompt_build", recallEvent, { sessionKey: "auth" });
    await invoke(api, "before_prompt_build", recallEvent, { sessionKey: "auth" });
    const observeEvent = {
      success: true,
      messages: [
        { role: "user", content: "captured question" },
        { role: "assistant", content: "captured answer" },
      ],
    };
    await invoke(api, "agent_end", observeEvent, { sessionKey: "auth" });
    await invoke(api, "agent_end", observeEvent, { sessionKey: "auth" });
    const secondApi = recordingApi();
    registerDelegateRuntime(secondApi, optionsFor(address.port, {
      target: { ...target },
      serviceId: "auth-logging-test",
    }));
    await invoke(secondApi, "before_prompt_build", recallEvent, { sessionKey: "auth" });

    await invoke(api, "before_compaction", {}, { sessionKey: "auth" });
    await invoke(api, "before_compaction", {}, { sessionKey: "auth" });

    assert.deepEqual(new Set(paths), new Set([
      "/engram/v1/recall",
      "/engram/v1/observe",
      "/engram/v1/lcm/compaction/flush",
    ]));
    assert.equal(errors.length, 4, "each route/status pair emits one error");
    assert.equal(warnings.length, 0, "auth failures replace generic degradation warnings");
    assert.equal(errors.filter((message) => message.includes("(401;")).length, 1);
    assert.equal(errors.filter((message) => message.includes("(403;")).length, 3);
    for (const message of errors) {
      assert.match(message, /token source: OPENCLAW_REMNIC_ACCESS_TOKEN/);
      assert.doesNotMatch(message, /test-token/);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("delegate authorization probe reports grant, rejection, and network failure without exposing credentials", async () => {
  let responseStatus = 200;
  const receivedAuthorization: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.match(
      String(req.url),
      /\/engram\/v1\/authorization\?op=recall&op=observe&op=lcm_compaction_flush&namespace=/,
    );
    receivedAuthorization.push(req.headers.authorization);
    res.writeHead(responseStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ authorized: responseStatus === 200 }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const target: DelegateRuntimeOptions["target"] = {
    host: "127.0.0.1",
    port: address.port,
    resolveAuthToken: () => ({
      token: "test-preflight-token",
      source: "OPENCLAW_REMNIC_ACCESS_TOKEN",
    }),
  };
  try {
    assert.deepEqual(await probeDelegateAuthorization(target), {
      state: "authorized",
      tokenSource: "OPENCLAW_REMNIC_ACCESS_TOKEN",
    });

    responseStatus = 403;
    assert.deepEqual(await probeDelegateAuthorization(target), {
      state: "unauthorized",
      status: 403,
      tokenSource: "OPENCLAW_REMNIC_ACCESS_TOKEN",
    });
    assert.deepEqual(receivedAuthorization, ["Bearer test-preflight-token", "Bearer test-preflight-token"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }

  const unavailable: DelegateRuntimeOptions["target"] = {
    host: "127.0.0.1",
    port: 1,
    resolveAuthToken: () => ({
      token: "test-preflight-token",
      source: "OPENCLAW_REMNIC_ACCESS_TOKEN",
    }),
  };
  assert.deepEqual(await probeDelegateAuthorization(unavailable), {
    state: "unavailable",
    tokenSource: "OPENCLAW_REMNIC_ACCESS_TOKEN",
  });
});

test("delegate activation warns each service once and keeps its memory hooks", async (t) => {
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorToken = process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  const warnings: string[] = [];
  initLogger(
    {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    },
    false,
    { timestamps: false },
  );
  t.after(() => {
    resetLogger();
    if (priorMode === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorMode;
    if (priorToken === undefined) Reflect.deleteProperty(process.env, "OPENCLAW_REMNIC_ACCESS_TOKEN");
    else process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = priorToken;
  });
  process.env.REMNIC_BRIDGE_MODE = "delegate";
  process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = "test-preflight-token";
  const api = recordingApi();
  const options = {
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
  let probeCalls = 0;
  const probedOperations: Array<readonly string[]> = [];
  const deps: MaybeRegisterDelegateDeps = {
    checkHealth: () => true,
    probeAuthorization: async (_target, _namespace, operations) => {
      probeCalls += 1;
      probedOperations.push(operations);
      return {
        state: "unauthorized" as const,
        status: 403 as const,
        tokenSource: "OPENCLAW_REMNIC_ACCESS_TOKEN" as const,
      };
    },
  };
  assert.equal(maybeRegisterDelegateRuntime(api, options, deps), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(api.handlers.has("agent_end"), "authorization preflight must not fall back to embedded");
  assert.equal(probeCalls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /authorization preflight rejected/);
  assert.match(warnings[0]!, /OPENCLAW_REMNIC_ACCESS_TOKEN/);
  assert.doesNotMatch(warnings[0]!, /test-preflight-token/);

  assert.equal(
    maybeRegisterDelegateRuntime(
      api,
      { ...options, serviceId: "openclaw-engram", allowPromptInjection: false },
      deps,
    ),
    true,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 2, "each service receives a preflight");
  assert.equal(warnings.length, 2);
  assert.deepEqual(probedOperations, [
    ["recall", "observe", "lcm_compaction_flush"],
    ["observe", "lcm_compaction_flush"],
  ]);
});

test("delegate authorization preflight probes only the operations enabled by configuration", async () => {
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  process.env.REMNIC_BRIDGE_MODE = "delegate";
  const options = {
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
  try {
    for (const disabledRecall of [
      { allowPromptInjection: false },
      { recallBudgetChars: 0 },
    ]) {
      let operations: readonly string[] | undefined;
      const api = recordingApi();
      assert.equal(
        maybeRegisterDelegateRuntime(
          api,
          { ...options, ...disabledRecall },
          {
            checkHealth: () => true,
            probeAuthorization: async (_target, _namespace, requestedOperations) => {
              operations = requestedOperations;
              return {
                state: "authorized",
                tokenSource: "no configured token",
              };
            },
          },
        ),
        true,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(operations, ["observe", "lcm_compaction_flush"]);
    }
  } finally {
    if (priorMode === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorMode;
  }
});
