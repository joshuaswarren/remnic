import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { initLogger, resetLogger } from "@remnic/core/logger";

import {
  maybeRegisterDelegateRuntime,
  probeDelegateAuthorization,
  registerDelegateRuntime,
  type DelegateRuntimeOptions,
  type MaybeRegisterDelegateDeps,
} from "./delegate-runtime.js";
import { loadDaemonAuth, resolveBridgeMode } from "./bridge.js";
import { getJson } from "./delegate-http.js";
import { ingestFlushPlanNotes } from "./delegate-flush-plan-ingest.js";
import {
  SESSION_NAMESPACE_BINDING_MAX_ENTRIES,
  createFileSessionNamespaceBindingStore,
  createInMemorySessionNamespaceBindingStore,
} from "@remnic/core/session-namespace-bindings";

/**
 * Capability inputs shared by every delegate registration in this file. The
 * daemon-backed capability is exercised on its own in
 * delegate-capability.test.ts; here it only needs to construct.
 */
const TEST_CAPABILITY: DelegateRuntimeOptions["capability"] = {
  memoryDir: path.join(os.tmpdir(), "remnic-delegate-runtime-memory"),
  workspaceDir: path.join(os.tmpdir(), "remnic-delegate-runtime-workspace"),
  agentIds: ["generalist"],
  configuredSearchBackend: "qmd",
  configuredQmdCommand: "qmd",
};

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
  /** Resolves when the NEXT request for `pathname` arrives. */
  nextCall: (pathname: string) => Promise<RecordedCall>;
  close: () => Promise<void>;
}

interface RecordingApi {
  handlers: Map<string, HookHandler[]>;
  hookOpts: Map<string, unknown>;
  on: (hook: string, handler: HookHandler, opts?: { timeoutMs?: number }) => void;
}

test("delegate mode registers the support passport gateway worker as a host service", () => {
  const api = recordingApi() as RecordingApi & {
    services: Array<{ id: string }>;
    registerService(service: { id: string }): void;
  };
  api.services = [];
  api.registerService = (service) => api.services.push(service);
  registerDelegateRuntime(
    api,
    optionsFor(1, {
      supportPassportModelRoute: { kind: "gateway", invoke: async () => null },
    }),
  );
  assert.deepEqual(api.services.map((service) => service.id), [
    "openclaw-remnic:support-passport-model",
  ]);
});

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
  ) => Record<string, unknown> | Promise<Record<string, unknown> | null> | null,
  options: {
    batchFlush?: boolean;
    batchResponse?: boolean;
    capabilityResponses?: Array<{ status: number; body: Record<string, unknown> }>;
    /**
     * Answer a request with a real HTTP status. Returning `null` from
     * `respond` still yields 200, which is acceptance — a test that means
     * "the daemon refused" must say so with a status (issue #2303).
     */
    statusFor?: (pathname: string, body: Record<string, unknown>) => number | undefined;
  } = {},
): Promise<DaemonStub> {
  const calls: RecordedCall[] = [];
  const arrivals: Array<{ pathname: string; resolve: (call: RecordedCall) => void }> = [];
  let capabilityResponseIndex = 0;
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
      const call = { pathname, body };
      calls.push(call);
      for (const waiter of arrivals.splice(0)) {
        if (waiter.pathname === pathname) waiter.resolve(call);
        else arrivals.push(waiter);
      }
      const capabilityResponse =
        pathname === "/engram/v1/capabilities"
          ? options.capabilityResponses?.[capabilityResponseIndex++]
          : undefined;
      const responsePromise =
        // A real daemon always answers health with its namespace posture; the
        // capability refuses to scope a request without it.
        pathname === "/engram/v1/health"
          ? Promise.resolve({
              status: 200,
              body: { ok: true, memoryDir: TEST_CAPABILITY.memoryDir, namespacesEnabled: false },
            })
          : pathname === "/engram/v1/capabilities" && capabilityResponse !== undefined
          ? Promise.resolve(capabilityResponse)
          : pathname === "/engram/v1/capabilities" && options.batchFlush !== false
            ? Promise.resolve({ status: 200, body: { lcmCompactionFlushBatch: true } })
            : Promise.resolve()
                .then(() => respond(pathname, body))
                .then((response) => {
                  const requestedNamespaces = Array.isArray(body.namespaces)
                    ? body.namespaces
                    : undefined;
                  if (requestedNamespaces === undefined || options.batchResponse === false) {
                    return { status: 200, body: response };
                  }
                  if (response === null) return { status: 200, body: null };
                  return {
                    status: 200,
                    body: {
                      ...response,
                      enabled: response.enabled ?? true,
                      flushed: response.flushed ?? true,
                      sessionKey: body.sessionKey,
                      namespaces: requestedNamespaces,
                      results: requestedNamespaces.map((namespace) => ({
                        status: "fulfilled",
                        namespace,
                        result: response,
                      })),
                    },
                  };
                });
      void responsePromise
        .then(({ status, body: response }) => {
          if (res.destroyed) return;
          res.statusCode = options.statusFor?.(req.url ?? "", body) ?? status;
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
    nextCall: (pathname) => {
      const { promise, resolve } = Promise.withResolvers<RecordedCall>();
      arrivals.push({ pathname, resolve });
      return promise;
    },
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
    capability: TEST_CAPABILITY,
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

/**
 * `agent_end` returns before its observe POST settles (the turn capture is
 * detached from the hook), so a test that inspects the daemon's observe
 * calls waits for the expected number to ARRIVE first.
 */
async function observed(stub: DaemonStub, count = 1): Promise<RecordedCall[]> {
  const observes = () => stub.calls.filter((call) => call.pathname === "/engram/v1/observe");
  while (observes().length < count) await stub.nextCall("/engram/v1/observe");
  assert.equal(observes().length, count, `${count} observe call(s) reached the daemon`);
  return observes();
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

test("delegate forwards daemon degradation on the OpenClaw recall response (#2972)", async () => {
  const degradation = {
    state: "degraded",
    reason: "budget-compacted",
    budget: { contextBudget: 80, fullChars: 400, deliveredChars: 80 },
  };
  const stub = await startDaemonStub(() => ({
    context: "compact remembered decision",
    contextComposition: {
      context: "compact remembered decision",
      degradation,
    },
  }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const result = (await invoke(
      api,
      "before_prompt_build",
      { prompt: "what did we decide about the rollout?" },
      { sessionKey: "degraded-session" },
    )) as Record<string, unknown>;

    assert.ok(result && typeof result === "object");
    assert.deepEqual(result.degradation, degradation);
    assert.match(String(result.prependSystemContext), /compact remembered decision/);
    assert.equal(
      String(result.prependSystemContext).includes("budget-compacted"),
      false,
      "degradation stays out of the injected text",
    );
  } finally {
    await stub.close();
  }
});

test("delegate omits degradation on a healthy OpenClaw recall response (#2972)", async () => {
  const stub = await startDaemonStub(() => ({
    context: "remembered daemon context",
    contextComposition: { context: "remembered daemon context" },
  }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const result = (await invoke(
      api,
      "before_prompt_build",
      { prompt: "what did we decide about the rollout?" },
      { sessionKey: "healthy-session" },
    )) as Record<string, unknown>;

    assert.ok(result && typeof result === "object");
    assert.equal("degradation" in result, false);
    assert.match(String(result.prependSystemContext), /remembered daemon context/);
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
    "before_prompt_build",
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

    const [observe] = await observed(stub);
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

test("delegate fails closed when a singular flush response is null", async () => {
  const stub = await startDaemonStub((pathname) =>
    pathname === "/engram/v1/lcm/compaction/flush" ? null : { accepted: true },
  );
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));

    assert.equal(
      await invoke(api, "before_compaction", {}, { sessionKey: "null-flush-session" }),
      false,
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
    await observed(stub, 1);
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
    await observed(stub, 3);

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

test("delegate falls back to singular flushes when batch capability is unavailable", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }), { batchFlush: false });
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const sessionKey = "legacy-rebound-session";

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
    assert.deepEqual(
      flushes.map((call) => call.body.namespace).sort(),
      ["team-first", "team-second"],
    );
    assert.equal(flushes.every((call) => !("namespaces" in call.body)), true);
  } finally {
    await stub.close();
  }
});

test("delegate retries a transient or malformed batch capability probe", async () => {
  const stub = await startDaemonStub(
    () => ({ flushed: true }),
    {
      capabilityResponses: [
        { status: 200, body: {} },
        { status: 200, body: { lcmCompactionFlushBatch: true } },
      ],
    },
  );
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const sessionKey = "transient-capability-session";

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

    await invoke(api, "before_compaction", { sessionKey });
    await invoke(api, "before_reset", { sessionKey });

    const capabilityCalls = stub.calls.filter((call) => call.pathname === "/engram/v1/capabilities");
    assert.equal(capabilityCalls.length, 2);
    const flushes = stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.deepEqual(
      flushes.slice(0, 2).map((call) => call.body.namespace).sort(),
      ["team-first", "team-second"],
    );
    assert.deepEqual(flushes.at(-1)?.body.namespaces, ["team-first", "team-second"]);
  } finally {
    await stub.close();
  }
});

test("delegate revalidates cached negative batch support after expiry", async () => {
  let now = 0;
  const stub = await startDaemonStub(
    () => ({ flushed: true }),
    {
      capabilityResponses: [
        { status: 200, body: { lcmCompactionFlushBatch: false } },
        { status: 200, body: { lcmCompactionFlushBatch: true } },
      ],
    },
  );
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { now: () => now }));
    const sessionKey = "negative-capability-expiry-session";

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

    await invoke(api, "before_compaction", { sessionKey });
    now = Number.POSITIVE_INFINITY;
    await invoke(api, "before_reset", { sessionKey });

    const capabilityCalls = stub.calls.filter((call) => call.pathname === "/engram/v1/capabilities");
    assert.equal(capabilityCalls.length, 2);
    const flushes = stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.deepEqual(
      flushes.slice(0, 2).map((call) => call.body.namespace).sort(),
      ["team-first", "team-second"],
    );
    assert.deepEqual(flushes.at(-1)?.body.namespaces, ["team-first", "team-second"]);
  } finally {
    await stub.close();
  }
});

test("delegate revalidates cached positive batch support after expiry", async () => {
  let now = 0;
  const stub = await startDaemonStub(
    () => ({ flushed: true }),
    {
      capabilityResponses: [
        { status: 200, body: { lcmCompactionFlushBatch: true } },
        { status: 200, body: { lcmCompactionFlushBatch: false } },
      ],
    },
  );
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port, { now: () => now }));
    const sessionKey = "positive-capability-expiry-session";

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

    await invoke(api, "before_compaction", { sessionKey });
    now = Number.POSITIVE_INFINITY;
    await invoke(api, "before_reset", { sessionKey });

    const capabilityCalls = stub.calls.filter((call) => call.pathname === "/engram/v1/capabilities");
    assert.equal(capabilityCalls.length, 2);
    const flushes = stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.deepEqual(flushes[0]?.body.namespaces, ["team-first", "team-second"]);
    assert.deepEqual(
      flushes.slice(1).map((call) => call.body.namespace).sort(),
      ["team-first", "team-second"],
    );
  } finally {
    await stub.close();
  }
});
test("delegate reprobes batch support after daemon replacement", async () => {
  let replaced = false;
  const stub = await startDaemonStub(
    (_pathname, body) => {
      const requestedNamespaces = Array.isArray(body.namespaces) ? body.namespaces : undefined;
      if (requestedNamespaces !== undefined && !replaced) {
        replaced = true;
        return {
          enabled: true,
          flushed: true,
          sessionKey: body.sessionKey,
          namespaces: requestedNamespaces,
          results: requestedNamespaces.map((namespace) => ({
            status: "fulfilled",
            namespace,
            result: { enabled: true, flushed: true },
          })),
        };
      }
      return { flushed: true };
    },
    {
      batchResponse: false,
      capabilityResponses: [
        { status: 200, body: { lcmCompactionFlushBatch: true } },
        { status: 200, body: { lcmCompactionFlushBatch: false } },
      ],
    },
  );
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const sessionKey = "replaced-daemon-session";

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

    await invoke(api, "before_compaction", { sessionKey });
    await invoke(api, "before_reset", { sessionKey });
    await invoke(api, "session_end", { sessionKey });

    const capabilityCalls = stub.calls.filter((call) => call.pathname === "/engram/v1/capabilities");
    assert.equal(capabilityCalls.length, 2);
    const flushes = stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.deepEqual(flushes[0]?.body.namespaces, ["team-first", "team-second"]);
    assert.deepEqual(
      flushes
        .filter((call) => !("namespaces" in call.body))
        .slice(-2)
        .map((call) => call.body.namespace)
        .sort(),
      ["team-first", "team-second"],
    );
  } finally {
    await stub.close();
  }
});

test("delegate falls back to singular flushes after a failed batch request", async () => {
  let batchAttempts = 0;
  const stub = await startDaemonStub((pathname) => {
    if (pathname === "/engram/v1/lcm/compaction/flush" && batchAttempts++ === 0) {
      throw new Error("transient batch failure");
    }
    return { flushed: true };
  });
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const sessionKey = "failed-batch-session";

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
    assert.equal(await invoke(api, "before_reset", { sessionKey }), true);
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/capabilities").length,
      2,
    );
    const flushes = stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.equal(flushes.length, 4);
    assert.deepEqual(flushes[0]?.body.namespaces, ["team-first", "team-second"]);
    assert.deepEqual(
      flushes.slice(1, 3).map((call) => call.body.namespace).sort(),
      ["team-first", "team-second"],
    );
    assert.deepEqual(flushes[3]?.body.namespaces, ["team-first", "team-second"]);
  } finally {
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
      capability: TEST_CAPABILITY,
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

test("delegate ignores a corrupt legacy binding file when canonical scope is available", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-delegate-bindings-"));
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorHost = process.env.REMNIC_HOST;
  const priorPort = process.env.REMNIC_PORT;
  const sessionKey = "corrupt-legacy-session";
  try {
    const primaryPath = path.join(
      memoryDir,
      "state",
      "plugins",
      "openclaw-remnic",
      "session-namespace-bindings.json",
    );
    const legacyPath = path.join(
      memoryDir,
      "state",
      "plugins",
      "openclaw-engram",
      "session-namespace-bindings.json",
    );
    fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      primaryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [encodeURIComponent(sessionKey)]: {
            namespaces: ["team-canonical"],
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );
    fs.writeFileSync(legacyPath, "{ malformed legacy binding");

    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    process.env.REMNIC_PORT = String(stub.port);
    const api = recordingApi();
    assert.equal(
      maybeRegisterDelegateRuntime(
        api,
        {
          serviceId: "openclaw-remnic",
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
          capability: TEST_CAPABILITY,
        },
        { checkHealth: () => true },
      ),
      true,
    );

    await invoke(api, "session_end", { sessionKey });
    const flush = stub.calls.find((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush);
    assert.equal(flush.body.namespace, "team-canonical");
    const flushCount = stub.calls.filter(
      (call) => call.pathname === "/engram/v1/lcm/compaction/flush",
    ).length;
    fs.rmSync(primaryPath);
    await invoke(api, "before_reset", { sessionKey: "missing-canonical-session" });
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/lcm/compaction/flush").length,
      flushCount,
    );
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

test("delegate restores full canonical history during concurrent explicit legacy migration", async () => {
  const stub = await startDaemonStub(() => ({ flushed: true }));
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-delegate-bindings-"));
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorHost = process.env.REMNIC_HOST;
  const priorPort = process.env.REMNIC_PORT;
  const sessionKey = "legacy-recency-session";
  const current = Array.from({ length: 40 }, (_unused, index) => `team-current-${index}`);
  const legacy = Array.from({ length: 40 }, (_unused, index) => `team-legacy-${index}`);
  const expected = [...legacy.slice(-22), ...current, "team-explicit", "team-explicit-second"];
  try {
    const primaryPath = path.join(
      memoryDir,
      "state",
      "plugins",
      "openclaw-remnic",
      "session-namespace-bindings.json",
    );
    const legacyPath = path.join(
      memoryDir,
      "state",
      "plugins",
      "openclaw-engram",
      "session-namespace-bindings.json",
    );
    fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const updatedAt = new Date().toISOString();
    fs.writeFileSync(
      primaryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [encodeURIComponent(sessionKey)]: { namespaces: current, updatedAt },
        },
      }),
    );
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        entries: {
          [encodeURIComponent(sessionKey)]: { namespaces: legacy, updatedAt },
        },
      }),
    );

    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    process.env.REMNIC_PORT = String(stub.port);
    const api = recordingApi();
    const secondApi = recordingApi();
    assert.equal(
      maybeRegisterDelegateRuntime(
        api,
        {
          serviceId: "openclaw-remnic",
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
          capability: TEST_CAPABILITY,
        },
        { checkHealth: () => true },
      ),
      true,
    );
    assert.equal(
      maybeRegisterDelegateRuntime(
        secondApi,
        {
          serviceId: "openclaw-remnic",
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
          capability: TEST_CAPABILITY,
        },
        { checkHealth: () => true },
      ),
      true,
    );

    await Promise.all([
      invoke(
        api,
        "agent_end",
        {
          success: true,
          messages: [
            { role: "user", content: "capture the explicit migration namespace" },
            { role: "assistant", content: "the explicit namespace is bound" },
          ],
        },
        { sessionKey, runtime: { agent: { session: { namespace: "team-explicit" } } } },
      ),
      invoke(
        secondApi,
        "agent_end",
        {
          success: true,
          messages: [
            { role: "user", content: "capture the second migration namespace" },
            { role: "assistant", content: "the second namespace is bound" },
          ],
        },
        { sessionKey, runtime: { agent: { session: { namespace: "team-explicit-second" } } } },
      ),
    ]);
    await invoke(api, "session_end", { sessionKey });
    const flush = stub.calls.find((call) => call.pathname === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush);
    assert.deepEqual(flush.body.namespaces, expected);
    const persisted = JSON.parse(fs.readFileSync(primaryPath, "utf8")) as {
      entries: Record<string, { namespaces: string[] }>;
    };
    assert.deepEqual(persisted.entries[encodeURIComponent(sessionKey)].namespaces, expected);
    const migratedLegacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as {
      entries: Record<string, unknown>;
    };
    assert.deepEqual(migratedLegacy.entries, {});
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

test("delegate bounds completed legacy migration sessions and rechecks evicted keys", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-delegate-bindings-"));
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorHost = process.env.REMNIC_HOST;
  const priorPort = process.env.REMNIC_PORT;
  const sessionKey = "evicted-legacy-session";
  const primaryPath = path.join(
    memoryDir,
    "state",
    "plugins",
    "openclaw-remnic",
    "session-namespace-bindings.json",
  );
  const legacyPath = path.join(
    memoryDir,
    "state",
    "plugins",
    "openclaw-engram",
    "session-namespace-bindings.json",
  );
  try {
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    process.env.REMNIC_PORT = String(stub.port);
    const common = {
      serviceId: "openclaw-remnic",
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
      capability: TEST_CAPABILITY,
    };
    const api = recordingApi();
    assert.equal(maybeRegisterDelegateRuntime(api, common, { checkHealth: () => true }), true);
    const observe = async (key: string, namespace: string): Promise<void> => {
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
        { sessionKey: key, runtime: { agent: { session: { namespace } } } },
      );
    };

    await observe(sessionKey, "team-initial");
    for (let index = 0; index < SESSION_NAMESPACE_BINDING_MAX_ENTRIES; index += 1) {
      await observe(`legacy-cache-${index}`, `team-${index}`);
    }

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        entries: {
          [encodeURIComponent(sessionKey)]: {
            namespaces: ["team-recovered"],
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );
    await observe(sessionKey, "team-after");

    const persisted = JSON.parse(fs.readFileSync(primaryPath, "utf8")) as {
      entries: Record<string, { namespaces: string[] }>;
    };
    assert.deepEqual(
      persisted.entries[encodeURIComponent(sessionKey)]?.namespaces,
      ["team-recovered", "team-after"],
    );
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


test("delegate preserves legacy bindings while the legacy adapter is active", async () => {
  const stub = await startDaemonStub(() => ({ accepted: true }));
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-delegate-bindings-"));
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorHost = process.env.REMNIC_HOST;
  const priorPort = process.env.REMNIC_PORT;
  const sessionKey = "active-legacy-adapter-session";
  const legacyPath = path.join(
    memoryDir,
    "state",
    "plugins",
    "openclaw-engram",
    "session-namespace-bindings.json",
  );
  try {
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    process.env.REMNIC_PORT = String(stub.port);
    const common = {
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
      capability: TEST_CAPABILITY,
    };
    const legacyApi = recordingApi();
    const canonicalApi = recordingApi();
    assert.equal(
      maybeRegisterDelegateRuntime(
        legacyApi,
        { ...common, serviceId: "openclaw-engram" },
        { checkHealth: () => true },
      ),
      true,
    );
    assert.equal(
      maybeRegisterDelegateRuntime(
        canonicalApi,
        { ...common, serviceId: "openclaw-remnic" },
        { checkHealth: () => true },
      ),
      true,
    );
    assert.equal(legacyApi.handlers.get("agent_end")?.length, 1);
    assert.equal(canonicalApi.handlers.get("agent_end")?.length, 1);

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        entries: {
          [encodeURIComponent(sessionKey)]: {
            namespaces: ["team-legacy"],
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const canonicalAgentEnd = canonicalApi.handlers.get("agent_end")?.[0];
    assert.ok(canonicalAgentEnd);
    await canonicalAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "capture the canonical session namespace" },
          { role: "assistant", content: "the namespace is bound" },
        ],
      },
      { sessionKey, runtime: { agent: { session: { namespace: "team-canonical" } } } },
    );

    const persistedLegacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as {
      entries: Record<string, { namespaces: string[]; updatedAt: string }>;
    };
    assert.deepEqual(
      persistedLegacy.entries[encodeURIComponent(sessionKey)]?.namespaces,
      ["team-legacy"],
    );

    const lateSessionKey = "late-legacy-adapter-session";
    await canonicalAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "capture the first late canonical namespace" },
          { role: "assistant", content: "the first late namespace is bound" },
        ],
      },
      { sessionKey: lateSessionKey, runtime: { agent: { session: { namespace: "team-canonical-first" } } } },
    );
    persistedLegacy.entries[encodeURIComponent(lateSessionKey)] = {
      namespaces: ["team-legacy-late"],
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(legacyPath, JSON.stringify(persistedLegacy));
    await canonicalAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "capture the second late canonical namespace" },
          { role: "assistant", content: "the second late namespace is bound" },
        ],
      },
      { sessionKey: lateSessionKey, runtime: { agent: { session: { namespace: "team-canonical-second" } } } },
    );
    const canonicalPath = path.join(
      memoryDir,
      "state",
      "plugins",
      "openclaw-remnic",
      "session-namespace-bindings.json",
    );
    const persistedCanonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8")) as {
      entries: Record<string, { namespaces: string[] }>;
    };
    assert.deepEqual(
      persistedCanonical.entries[encodeURIComponent(lateSessionKey)]?.namespaces,
      ["team-legacy-late", "team-canonical-first", "team-canonical-second"],
    );
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
test("delegate passive mode skips memory hooks but keeps the passport model worker", async () => {
  const api = recordingApi() as RecordingApi & {
    services: Array<{ id: string }>;
    registerService(service: { id: string }): void;
  };
  api.services = [];
  api.registerService = (service) => api.services.push(service);
  registerDelegateRuntime(api, optionsFor(1, {
    passive: true,
    supportPassportModelRoute: { kind: "gateway", invoke: async () => null },
  }));
  assert.equal(api.handlers.size, 0, "passive slot mode must not register hooks");
  assert.deepEqual(api.services.map((service) => service.id), [
    "openclaw-remnic:support-passport-model",
  ]);
});

test("delegate honors allowPromptInjection=false but keeps observe/flush", async () => {
  const api = recordingApi();
  registerDelegateRuntime(api, optionsFor(1, { allowPromptInjection: false }));
  assert.equal(api.handlers.has("before_prompt_build"), false);
  assert.equal(api.handlers.has("before_agent_start"), false);
  assert.ok(api.handlers.has("agent_end"), "observe hook still registered");
  assert.ok(api.handlers.has("before_reset"), "flush hooks still registered");
});


const DAEMON_AUTH_ENV_VARS = [
  "OPENCLAW_REMNIC_ACCESS_TOKEN",
  "REMNIC_AUTH_TOKEN",
  "OPENCLAW_ENGRAM_ACCESS_TOKEN",
  "ENGRAM_AUTH_TOKEN",
] as const;
type DaemonAuthEnvVar = (typeof DAEMON_AUTH_ENV_VARS)[number];

/**
 * Run `body` against a scratch HOME with the daemon-auth environment set to
 * exactly `env` — every name not listed is unset, so an ambient credential on
 * the developer's machine or the CI runner cannot reach loadDaemonAuth().
 */
function withDaemonAuthEnv(
  env: Partial<Record<DaemonAuthEnvVar, string>>,
  body: (home: string) => void,
): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-daemon-auth-"));
  const priorHome = process.env.HOME;
  const priorAuth: Record<string, string | undefined> = {};
  for (const name of DAEMON_AUTH_ENV_VARS) priorAuth[name] = process.env[name];
  try {
    process.env.HOME = home;
    for (const name of DAEMON_AUTH_ENV_VARS) {
      const value = env[name];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    body(home);
  } finally {
    if (priorHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = priorHome;
    for (const name of DAEMON_AUTH_ENV_VARS) {
      const value = priorAuth[name];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("loadDaemonAuth selects only the OpenClaw token from multi-connector stores", () => {
  withDaemonAuthEnv({}, (home) => {
    const store = path.join(home, ".remnic", "tokens.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(
      store,
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
      store,
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
  });
});

test("loadDaemonAuth prefers REMNIC_AUTH_TOKEN over the legacy OPENCLAW_ENGRAM_ACCESS_TOKEN", () => {
  withDaemonAuthEnv(
    { REMNIC_AUTH_TOKEN: "current-token", OPENCLAW_ENGRAM_ACCESS_TOKEN: "stale-legacy-token" },
    () => {
      assert.deepEqual(loadDaemonAuth(), {
        token: "current-token",
        source: "REMNIC_AUTH_TOKEN",
      });
    },
  );
});

test("loadDaemonAuth ranks both current names above both legacy aliases", () => {
  withDaemonAuthEnv(
    {
      OPENCLAW_REMNIC_ACCESS_TOKEN: "connector-token",
      REMNIC_AUTH_TOKEN: "operator-token",
      OPENCLAW_ENGRAM_ACCESS_TOKEN: "legacy-connector-token",
      ENGRAM_AUTH_TOKEN: "legacy-operator-token",
    },
    () => {
      assert.deepEqual(loadDaemonAuth(), {
        token: "connector-token",
        source: "OPENCLAW_REMNIC_ACCESS_TOKEN",
      });
    },
  );
  // Drop the winner and the next current name takes over — not a legacy alias.
  withDaemonAuthEnv(
    {
      REMNIC_AUTH_TOKEN: "operator-token",
      OPENCLAW_ENGRAM_ACCESS_TOKEN: "legacy-connector-token",
      ENGRAM_AUTH_TOKEN: "legacy-operator-token",
    },
    () => {
      assert.deepEqual(loadDaemonAuth(), {
        token: "operator-token",
        source: "REMNIC_AUTH_TOKEN",
      });
    },
  );
});

test("loadDaemonAuth still accepts each legacy alias when no current name is set", () => {
  withDaemonAuthEnv(
    { OPENCLAW_ENGRAM_ACCESS_TOKEN: "legacy-connector-token", ENGRAM_AUTH_TOKEN: "legacy-operator-token" },
    () => {
      assert.deepEqual(loadDaemonAuth(), {
        token: "legacy-connector-token",
        source: "OPENCLAW_ENGRAM_ACCESS_TOKEN",
      });
    },
  );
  withDaemonAuthEnv({ ENGRAM_AUTH_TOKEN: "legacy-operator-token" }, () => {
    assert.deepEqual(loadDaemonAuth(), {
      token: "legacy-operator-token",
      source: "ENGRAM_AUTH_TOKEN",
    });
  });
});

test("loadDaemonAuth reports the variable it actually used", () => {
  // `source` drives the operator-facing auth error. Naming the wrong variable
  // sends someone rotating a credential that was never sent.
  for (const name of [
    "OPENCLAW_REMNIC_ACCESS_TOKEN",
    "REMNIC_AUTH_TOKEN",
    "OPENCLAW_ENGRAM_ACCESS_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ] as const) {
    withDaemonAuthEnv({ [name]: `token-via-${name}` }, () => {
      assert.deepEqual(loadDaemonAuth(), { token: `token-via-${name}`, source: name });
    });
  }
});
test("resolveBridgeMode: explicit values win, absence stays embedded", () => {
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

test("an OpenClaw 2.0 host (capability, no section builder) gets the hook's own injection (#3057)", async () => {
  // 2.0 removed registerMemoryPromptSection, and its synchronous capability
  // promptBuilder is read during host prompt assembly — which never runs this
  // hook. A void hook return therefore injected nothing: the hook must return
  // the injection itself, and the capability builder must have no cached lines
  // to double-inject behind it.
  const stub = await startDaemonStub(() => ({ context: "bridge daemon context", count: 2 }));
  try {
    const api = recordingApi();
    const capabilities: Array<{
      promptBuilder?: (params: { sessionKey?: string }) => string[] | null;
    }> = [];
    const capabilityApi = Object.assign(api, {
      registerMemoryCapability(capability: unknown): void {
        capabilities.push(
          capability as { promptBuilder?: (params: { sessionKey?: string }) => string[] | null },
        );
      },
    });
    registerDelegateRuntime(capabilityApi, optionsFor(stub.port));

    const result = (await invoke(
      api,
      "before_prompt_build",
      { prompt: "what did we decide about the rollout?" },
      { sessionKey: "v2" },
    )) as Record<string, unknown>;
    assert.ok(result, "the hook injects on a capability-only host");
    assert.match(String(result.prependSystemContext), /## Memory Context \(Remnic\)/);
    assert.match(String(result.prependSystemContext), /bridge daemon context/);
    assert.equal(
      result.prependContext,
      undefined,
      "before_prompt_build returns only prependSystemContext",
    );
    const promptBuilder = capabilities[0]?.promptBuilder;
    assert.equal(typeof promptBuilder, "function", "the capability exposed a promptBuilder");
    assert.equal(
      promptBuilder?.({ sessionKey: "v2" }) ?? null,
      null,
      "the capability builder has no cached lines to double-inject",
    );
  } finally {
    await stub.close();
  }
});

test("delegate registers a memory prompt preparation that recalls before prompt assembly", async () => {
  // OpenClaw's `prepareMemoryPromptSection` awaits registered preparations and
  // splices their lines into the memory section BEFORE `before_prompt_build`
  // runs, so the preparation is the only path that puts recall into the
  // system prompt's own memory section on a 2.0 host. The hook still injects
  // the prompt-specific recall afterwards.
  const stub = await startDaemonStub(() => ({ context: "prepared daemon context", count: 1 }));
  try {
    const api = recordingApi();
    const preparations: Array<(params: Record<string, unknown>) => Promise<readonly string[]>> = [];
    const preparationApi = Object.assign(api, {
      registerMemoryCapability(): void {},
      registerMemoryPromptPreparation(
        prepare: (params: Record<string, unknown>) => Promise<readonly string[]>,
      ): void {
        preparations.push(prepare);
      },
    });
    registerDelegateRuntime(preparationApi, optionsFor(stub.port));
    assert.equal(preparations.length, 1, "one preparation registered");

    const lines = await preparations[0]!({
      availableTools: new Set<string>(),
      agentId: "main",
      agentSessionKey: "agent:main:prepared",
    });
    const recall = stub.calls.find((call) => call.pathname === "/engram/v1/recall");
    assert.ok(recall, "the preparation POSTs /engram/v1/recall");
    assert.equal(recall.body.sessionKey, "agent:main:prepared");
    assert.ok(String(recall.body.query).length >= 5, "the preparation sends a usable query");
    assert.ok(lines.some((line) => line.includes("## Memory Context (Remnic)")));
    assert.ok(lines.some((line) => line.includes("prepared daemon context")));

    const result = (await invoke(
      api,
      "before_prompt_build",
      { prompt: "what did we decide about the rollout?" },
      { sessionKey: "agent:main:prepared" },
    )) as Record<string, unknown>;
    assert.match(
      String(result?.prependSystemContext),
      /prepared daemon context/,
      "before_prompt_build still prepends the prompt-specific recall",
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname === "/engram/v1/recall").length,
      2,
      "preparation and hook each recall once",
    );
  } finally {
    await stub.close();
  }
});

test("delegate prompt preparation honors the session toggle and cron policy", async () => {
  const stub = await startDaemonStub(() => ({ context: "never injected" }));
  try {
    const api = recordingApi();
    const preparations: Array<(params: Record<string, unknown>) => Promise<readonly string[]>> = [];
    Object.assign(api, {
      registerMemoryPromptPreparation(
        prepare: (params: Record<string, unknown>) => Promise<readonly string[]>,
      ): void {
        preparations.push(prepare);
      },
    });
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, {
        resolveSessionDisabled: async (sessionKey) => sessionKey === "muted",
        shouldSkipRecall: (sessionKey) => sessionKey.startsWith("agent:cron:"),
      }),
    );
    assert.deepEqual(await preparations[0]!({ agentSessionKey: "muted" }), []);
    assert.deepEqual(await preparations[0]!({ agentSessionKey: "agent:cron:nightly" }), []);
    assert.equal(stub.calls.filter((call) => call.pathname === "/engram/v1/recall").length, 0);
  } finally {
    await stub.close();
  }
});

test("delegate recall queries with the current user turn, capped so an assembled prompt cannot 413", async () => {
  const stub = await startDaemonStub(() => ({ context: "ctx" }));
  try {
    const api = recordingApi();
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, {
        cleanUserMessage: (text: string) => text.replace(/^\[channel\] /, ""),
      }),
    );
    // A host may hand the hook its whole assembled prompt (system text first,
    // the operator's turn last). The daemon caps request bodies, so the query
    // keeps the END of the prompt, where the current turn is.
    const assembled = `[channel] ${"system preamble ".repeat(500)}what did we decide about the rollout?`;
    await invoke(api, "before_prompt_build", { prompt: assembled }, { sessionKey: "cap" });
    const [first] = stub.calls.filter((call) => call.pathname === "/engram/v1/recall");
    assert.ok(first);
    const query = String(first.body.query);
    assert.equal(query.length, 1_500);
    assert.ok(query.endsWith("what did we decide about the rollout?"), "the tail is kept");

    // The current turn outranks history: `messages` is the transcript BEFORE
    // this turn, so its last user entry is the previous question.
    await invoke(
      api,
      "before_prompt_build",
      {
        prompt: "[channel] the current question",
        messages: [{ role: "user", content: "the previous question" }],
      },
      { sessionKey: "cap" },
    );
    const [, second] = stub.calls.filter((call) => call.pathname === "/engram/v1/recall");
    assert.equal(second?.body.query, "the current question", "envelope stripped, current turn used");
  } finally {
    await stub.close();
  }
});

test("delegate agent_end returns before the observe POST settles and flush waits for it", async () => {
  // A daemon that accepts the connection and never answers must not hold the
  // host's agent_end hook for the whole observe timeout. The capture is
  // detached from the hook; a later flush for the same session still waits
  // for it so the turn is buffered before it is flushed.
  const observeGate = Promise.withResolvers<void>();
  const stub = await startDaemonStub(async (pathname) => {
    if (pathname === "/engram/v1/observe") {
      await observeGate.promise;
      return { accepted: 1 };
    }
    return { flushed: true };
  });
  try {
    const api = recordingApi();
    registerDelegateRuntime(api, optionsFor(stub.port));
    const observeArrived = stub.nextCall("/engram/v1/observe");
    await invoke(
      api,
      "agent_end",
      {
        success: true,
        messages: [
          { role: "user", content: "a question worth remembering" },
          { role: "assistant", content: "an answer worth remembering" },
        ],
      },
      { sessionKey: "detached" },
    );
    await observeArrived;
    const requestsBeforeFlush = stub.calls.length;
    const flushing = invoke(api, "before_compaction", {}, { sessionKey: "detached" });
    // Real time, deliberately: the daemon still holds the observe open, and a
    // flush that did NOT wait for it would already have probed health and
    // posted within this window on loopback. No event exists to await for
    // "nothing happened".
    await sleep(150);
    assert.equal(
      stub.calls.length,
      requestsBeforeFlush,
      "the flush issues no request while the session's observe is in flight",
    );
    observeGate.resolve();
    assert.equal(await flushing, true);
    const order = stub.calls
      .map((call) => call.pathname)
      .filter((pathname) => pathname === "/engram/v1/observe" || pathname === "/engram/v1/lcm/compaction/flush");
    assert.deepEqual(order, ["/engram/v1/observe", "/engram/v1/lcm/compaction/flush"]);
  } finally {
    observeGate.resolve();
    await stub.close();
  }
});

test("delegate registers daemon-backed memory_search and memory_get tools when the host exposes registerTool", async () => {
  const memoryPath = "facts/2026-01-01/fact-1.md";
  const stub = await startDaemonStub((pathname) => {
    if (pathname === "/engram/v1/memories/search") {
      return {
        query: "rollout",
        count: 1,
        results: [{ path: memoryPath, score: 0.9, snippet: "we decided to roll out on Monday" }],
      };
    }
    if (pathname.startsWith("/engram/v1/memories/fact-1")) {
      return { found: true, memory: { id: "fact-1", content: "we decided to roll out on Monday" } };
    }
    return { accepted: true };
  });
  try {
    const api = recordingApi();
    const registered: string[] = [];
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    Object.assign(api, {
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }): void {
        registered.push(tool.name);
        tools.set(tool.name, tool);
      },
    });
    const namespaceBindings = createInMemorySessionNamespaceBindingStore();
    registerDelegateRuntime(api, optionsFor(stub.port, { namespaceBindings }));
    // The legacy plugin id registers on the SAME api; a second `memory_search`
    // there is a host tool-name conflict, not a second tool.
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, { namespaceBindings, serviceId: "openclaw-engram" }),
    );
    assert.deepEqual(registered.sort(), ["memory_get", "memory_search"]);

    const searched = (await tools.get("memory_search")!.execute(
      "tc-1",
      { query: "rollout", limit: 3 },
      undefined,
      { sessionKey: "tool-session" },
    )) as { content: Array<{ text: string }> };
    const search = stub.calls.find((call) => call.pathname === "/engram/v1/memories/search");
    assert.ok(search, "memory_search POSTs the daemon's ranked search");
    assert.equal(search.body.query, "rollout");
    assert.equal(search.body.maxResults, 3);
    const searchPayload = JSON.parse(searched.content[0]!.text) as {
      count: number;
      results: Array<{ citation?: string; snippet: string; score: number }>;
    };
    assert.equal(searchPayload.count, 1);
    assert.equal(searchPayload.results[0]?.citation, memoryPath);
    assert.equal(searchPayload.results[0]?.snippet, "we decided to roll out on Monday");

    // The session binding decides memory_get's scope; the model may only
    // restate it. An unbound session reads the daemon default and cannot
    // name another tenant's namespace to reach a known memory id.
    await assert.rejects(
      tools.get("memory_get")!.execute(
        "tc-2",
        { id: "fact-1", namespace: "team-other" },
        undefined,
        { sessionKey: "tool-session" },
      ),
      /does not match the session's memory scope/,
    );
    assert.equal(
      stub.calls.some((call) => call.pathname.startsWith("/engram/v1/memories/fact-1")),
      false,
      "a mismatched scope never reaches the daemon",
    );
    await namespaceBindings.remember("tool-session", "team-alpha");
    const got = (await tools.get("memory_get")!.execute(
      "tc-2",
      { id: "fact-1", namespace: "team-alpha" },
      undefined,
      { sessionKey: "tool-session" },
    )) as { content: Array<{ text: string }> };
    const get = stub.calls.find((call) => call.pathname.startsWith("/engram/v1/memories/fact-1"));
    assert.ok(get, "memory_get reads the daemon's memory route");
    const getUrl = new URL(get.pathname, "http://daemon");
    assert.equal(getUrl.pathname, "/engram/v1/memories/fact-1");
    assert.equal(getUrl.searchParams.get("namespace"), "team-alpha");
    assert.equal(getUrl.searchParams.get("sessionKey"), "tool-session");
    const getPayload = JSON.parse(got.content[0]!.text) as { found: boolean; memory: { id: string } };
    assert.equal(getPayload.found, true);
    assert.equal(getPayload.memory.id, "fact-1");

    await assert.rejects(
      tools.get("memory_search")!.execute("tc-3", { query: "   " }, undefined, {}),
      /non-empty query/,
    );
    await assert.rejects(tools.get("memory_get")!.execute("tc-4", {}, undefined, {}), /requires an id/);
  } finally {
    await stub.close();
  }
});

test("explicit delegate preflight retries the configured interface address after loopback refuses", () => {
  const local = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal);
  if (local === undefined) return;
  const prior = { mode: process.env.REMNIC_BRIDGE_MODE, host: process.env.REMNIC_HOST, port: process.env.REMNIC_PORT };
  process.env.REMNIC_BRIDGE_MODE = "delegate";
  process.env.REMNIC_HOST = local.address;
  process.env.REMNIC_PORT = "4318";
  try {
    const probed: string[] = [];
    const handled = maybeRegisterDelegateRuntime(
      recordingApi(),
      {
        serviceId: "openclaw-remnic",
        configBridgeMode: "delegate",
        passive: false,
        allowPromptInjection: true,
        gateHeartbeatTurns: false,
        recallBudgetChars: 8_000,
        memoryDir: path.join(os.tmpdir(), "remnic-delegate-nic-fallback"),
        sessionTogglesEnabled: false,
        respectBundledActiveMemoryToggle: false,
        cleanUserMessage: (text: string) => text,
        hookTimeoutMs: 5_000,
        shouldSkipRecall: () => false,
        flushOnResetEnabled: true,
        capability: TEST_CAPABILITY,
      },
      {
        checkHealth: (host) => {
          probed.push(host);
          return host === local.address;
        },
        probeAuthorization: async () => ({ state: "authorized", tokenSource: "test" }) as never,
      },
    );
    assert.equal(handled, true, "delegate registered against the configured address");
    assert.deepEqual(probed, ["127.0.0.1", local.address], "loopback first, then the NIC");
  } finally {
    for (const [key, value] of [
      ["REMNIC_BRIDGE_MODE", prior.mode],
      ["REMNIC_HOST", prior.host],
      ["REMNIC_PORT", prior.port],
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
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
        capability: TEST_CAPABILITY,
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
  assert.equal(api.handlers.has("before_agent_start"), false);
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
    const [observe] = await observed(stub);
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
      capability: TEST_CAPABILITY,
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

test("maybeRegister passes the configured timeout to the daemon health preflight", () => {
  const priorEnv = process.env.REMNIC_BRIDGE_MODE;
  const priorLegacyEnv = process.env.ENGRAM_BRIDGE_MODE;
  Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
  Reflect.deleteProperty(process.env, "ENGRAM_BRIDGE_MODE");
  try {
    const api = recordingApi();
    let capturedTimeoutMs: number | undefined;
    const handled = maybeRegisterDelegateRuntime(
      api,
      {
        serviceId: "openclaw-remnic",
        configBridgeMode: "delegate",
        bridgeHealthTimeoutMs: 7_500,
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
        capability: TEST_CAPABILITY,
      },
      {
        checkHealth: (_host, _port, timeoutMs) => {
          capturedTimeoutMs = timeoutMs;
          return false;
        },
      },
    );

    assert.equal(handled, false);
    assert.equal(capturedTimeoutMs, 7_500);
  } finally {
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorEnv;
    if (priorLegacyEnv === undefined) Reflect.deleteProperty(process.env, "ENGRAM_BRIDGE_MODE");
    else process.env.ENGRAM_BRIDGE_MODE = priorLegacyEnv;
  }
});

test("maybeRegister rejects an invalid delegate timeout and falls back to embedded", () => {
  const priorEnv = process.env.REMNIC_BRIDGE_MODE;
  const priorLegacyEnv = process.env.ENGRAM_BRIDGE_MODE;
  Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
  Reflect.deleteProperty(process.env, "ENGRAM_BRIDGE_MODE");
  try {
    const api = recordingApi();
    let healthCalls = 0;
    const handled = maybeRegisterDelegateRuntime(
      api,
      {
        serviceId: "openclaw-remnic",
        configBridgeMode: "delegate",
        bridgeHealthTimeoutMs: 0,
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
        capability: TEST_CAPABILITY,
      },
      {
        checkHealth: () => {
          healthCalls += 1;
          return true;
        },
      },
    );

    assert.equal(handled, false);
    assert.equal(healthCalls, 0);
  } finally {
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorEnv;
    if (priorLegacyEnv === undefined) Reflect.deleteProperty(process.env, "ENGRAM_BRIDGE_MODE");
    else process.env.ENGRAM_BRIDGE_MODE = priorLegacyEnv;
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
      capability: TEST_CAPABILITY,
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

test("maybeRegister: passive registration does not poison active hooks or duplicate its passport service", () => {
  const priorEnv = process.env.REMNIC_BRIDGE_MODE;
  process.env.REMNIC_BRIDGE_MODE = "delegate";
  try {
    const api = recordingApi() as RecordingApi & {
      services: Array<{ id: string }>;
      registerService(service: { id: string }): void;
    };
    api.services = [];
    api.registerService = (service) => api.services.push(service);
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
      capability: TEST_CAPABILITY,
      supportPassportModelRoute: { kind: "gateway" as const, invoke: async () => null },
    };
    const healthDeps = { checkHealth: () => true };
    assert.equal(maybeRegisterDelegateRuntime(api, opts, healthDeps), true, "passive handled");
    assert.equal(api.handlers.size, 0, "passive binds no hooks");
    assert.deepEqual(api.services.map((service) => service.id), [
      "openclaw-remnic:support-passport-model",
    ]);
    const active = maybeRegisterDelegateRuntime(api, { ...opts, passive: false }, healthDeps);
    assert.equal(active, true, "later active registration is not deduped away");
    assert.ok((api.handlers.get("agent_end")?.length ?? 0) >= 1, "active registration binds hooks");
    assert.equal(api.services.length, 1, "the passport model service stays registered once");
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
      capability: TEST_CAPABILITY,
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
    // The capability's health probe rides the same server; this test is about
    // the RECALL route's token, so record only that one.
    if (String(req.url).startsWith("/engram/v1/recall")) {
      receivedAuthorization.push(req.headers.authorization);
    }
    res.setHeader("content-type", "application/json");
    if (String(req.url).startsWith("/engram/v1/health")) {
      res.end(JSON.stringify({ ok: true, namespacesEnabled: false }));
      return;
    }
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
test("delegate retries a TRIGGER_REAUTHENTICATION response after token rotation", async () => {
  let currentToken = "stale-token";
  let attempts = 0;
  const server = http.createServer((req, res) => {
    attempts += 1;
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer fresh-token") {
      currentToken = "fresh-token";
      res.writeHead(401);
      res.end(
        JSON.stringify({
          error_code: "UNAUTHORIZED",
          action: "TRIGGER_REAUTHENTICATION",
        }),
      );
      return;
    }
    res.end(JSON.stringify({ context: "same-session recovery" }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await getJson(
      {
        host: "127.0.0.1",
        port: address.port,
        resolveAuthToken: () => ({
          token: currentToken,
          source: "OPENCLAW_REMNIC_ACCESS_TOKEN",
        }),
      },
      "reauth-test",
      "/engram/v1/recall",
      1_000,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body?.context, "same-session recovery");
    assert.equal(attempts, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
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
    // Health stays readable: this test is about the MEMORY routes rejecting a
    // token, and the capability needs a namespace posture to scope with.
    if (String(req.url).startsWith("/engram/v1/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, namespacesEnabled: false }));
      return;
    }
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
      // The capability probes health to resolve the daemon's default namespace
      // before each scoped write; it is not one of the auth-logged routes.
      "/engram/v1/health",
      "/engram/v1/recall",
      "/engram/v1/observe",
      "/engram/v1/lcm/compaction/flush",
    ]));
    // This test is about the AUTHORIZATION log; the capability separately
    // reports that the stub daemon serves no confirmable corpus, which is
    // correct and covered in delegate-capability.test.ts.
    const authErrors = errors.filter((message) => message.includes("authorization failed"));
    assert.equal(authErrors.length, 4, "each route/status pair emits one error");
    assert.deepEqual(warnings, [], "auth failures replace generic degradation warnings");
    assert.equal(authErrors.filter((message) => message.includes("(401;")).length, 1);
    assert.equal(authErrors.filter((message) => message.includes("(403;")).length, 3);
    for (const message of authErrors) {
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
      /\/engram\/v1\/authorization\?op=recall&op=observe&op=lcm_compaction_flush&op=memory_search&namespace=/,
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
    capability: TEST_CAPABILITY,
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
    ["recall", "observe", "lcm_compaction_flush", "memory_search"],
    ["observe", "lcm_compaction_flush", "memory_search"],
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
    capability: TEST_CAPABILITY,
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
      assert.deepEqual(operations, ["observe", "lcm_compaction_flush", "memory_search"]);
    }
  } finally {
    if (priorMode === undefined) Reflect.deleteProperty(process.env, "REMNIC_BRIDGE_MODE");
    else process.env.REMNIC_BRIDGE_MODE = priorMode;
  }
});

test("a short query evicts the previous turn's cached recall", async () => {
  // On a builder host the hook does not inject; if prompt construction aborted
  // last turn the lines are still cached. A short query must not leave them
  // there for the builder to splice into the NEXT prompt.
  const stub = await startDaemonStub(() => ({ context: "stale daemon context" }));
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
    if (builder === null) throw new Error("section builder was not registered");

    // Turn 1 populates the cache; prompt construction never consumes it.
    await invoke(api, "before_prompt_build", { prompt: "a real query worth recalling" }, { sessionKey: "s" });
    // Turn 2 is too short to recall for.
    await invoke(api, "before_prompt_build", { prompt: "hi" }, { sessionKey: "s" });
    assert.equal(
      builder({ sessionKey: "s" }),
      null,
      "the short turn cleared the stale lines instead of re-injecting them",
    );
  } finally {
    await stub.close();
  }
});

test("an invalid health timeout still records the embedded bind it causes", async () => {
  // The timeout is parsed before mode resolution, so a bad value throws even
  // when the deployment never wanted delegate. Whatever it MEANT, returning
  // false has the caller bind the embedded runtime on this api, and OpenClaw
  // exposes no unregister — so a later delegate registration on the same api
  // would add delegate hooks BESIDE the attached embedded ones and run two
  // memory paths over one corpus.
  const stub = await startDaemonStub(() => ({ context: "ctx" }));
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorHost = process.env.REMNIC_HOST;
  const priorPort = process.env.REMNIC_PORT;
  try {
    delete process.env.REMNIC_BRIDGE_MODE;
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embedded-timeout-"));
    const common = {
      serviceId: "embedded-timeout",
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
      capability: TEST_CAPABILITY,
    };
    const api = recordingApi();
    const bad = maybeRegisterDelegateRuntime(
      api,
      { ...common, configBridgeMode: "embedded", bridgeHealthTimeoutMs: "not-a-number" },
      { checkHealth: () => true },
    );
    assert.equal(bad, false, "registration declines, embedded continues");

    // The SAME api can still take a delegate registration afterwards.
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    process.env.REMNIC_PORT = String(stub.port);
    const good = maybeRegisterDelegateRuntime(
      api,
      { ...common, configBridgeMode: "delegate" },
      { checkHealth: () => true },
    );
    assert.equal(
      good,
      false,
      "the api is irrevocably embedded, so delegate must not stack on top of it",
    );
    assert.ok(
      api.handlers.has("before_prompt_build") === false,
      "and no delegate hook was bound beside the embedded runtime",
    );

    // A PASSIVE registration binds nothing, so it records nothing.
    const passiveApi = recordingApi();
    assert.equal(
      maybeRegisterDelegateRuntime(
        passiveApi,
        {
          ...common,
          passive: true,
          configBridgeMode: "embedded",
          bridgeHealthTimeoutMs: "not-a-number",
        },
        { checkHealth: () => true },
      ),
      false,
    );
    assert.equal(
      maybeRegisterDelegateRuntime(
        passiveApi,
        { ...common, configBridgeMode: "delegate" },
        { checkHealth: () => true },
      ),
      true,
      "a passive failure left the api free to take delegate later",
    );
    await rm(memoryDir, { recursive: true, force: true });
  } finally {
    if (priorMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = priorMode;
    if (priorHost === undefined) delete process.env.REMNIC_HOST;
    else process.env.REMNIC_HOST = priorHost;
    if (priorPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = priorPort;
    await stub.close();
  }
});

test("a sibling service keeps the api's delegate mode when its own probe fails", async () => {
  // Canonical and legacy plugin IDs register separately on ONE api. If the
  // second service's probe transiently fails, binding its embedded runtime
  // beside the first's delegate hooks would run two memory paths over one
  // corpus - the exact failure this mode prevents.
  const stub = await startDaemonStub(() => ({ context: "ctx" }));
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorHost = process.env.REMNIC_HOST;
  const priorPort = process.env.REMNIC_PORT;
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sibling-mode-"));
  try {
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    process.env.REMNIC_PORT = String(stub.port);
    const common = {
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
      capability: TEST_CAPABILITY,
    };
    const api = recordingApi();
    // First service binds delegate.
    assert.equal(
      maybeRegisterDelegateRuntime(
        api,
        { ...common, serviceId: "openclaw-remnic" },
        { checkHealth: () => true },
      ),
      true,
    );
    // Second service's own health probe fails.
    assert.equal(
      maybeRegisterDelegateRuntime(
        api,
        { ...common, serviceId: "openclaw-engram" },
        { checkHealth: () => false },
      ),
      true,
      "reported handled, so the caller binds no embedded runtime beside delegate",
    );
  } finally {
    if (priorMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = priorMode;
    if (priorHost === undefined) delete process.env.REMNIC_HOST;
    else process.env.REMNIC_HOST = priorHost;
    if (priorPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = priorPort;
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an api that already fell back skips the endpoint walk entirely", async () => {
  // The result is irrevocably embedded, so running `auto`'s synchronous walk
  // to reach that foregone conclusion lets a stalling endpoint block every
  // reload for the full configured timeout.
  const priorMode = process.env.REMNIC_BRIDGE_MODE;
  const priorHost = process.env.REMNIC_HOST;
  const priorPort = process.env.REMNIC_PORT;
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fallback-skip-"));
  try {
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_HOST = "127.0.0.1";
    // Nothing listens here, so the first attempt records the fallback.
    process.env.REMNIC_PORT = "4870";
    const common = {
      serviceId: "fallback-skip",
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
      capability: TEST_CAPABILITY,
    };
    const api = recordingApi();
    assert.equal(
      maybeRegisterDelegateRuntime(api, common, { checkHealth: () => false }),
      false,
      "the first attempt falls back and records it",
    );
    // A second registration must not consult health again.
    let probed = false;
    assert.equal(
      maybeRegisterDelegateRuntime(api, common, {
        checkHealth: () => {
          probed = true;
          return true;
        },
      }),
      false,
    );
    assert.equal(probed, false, "no health-dependent work on an already-decided api");
  } finally {
    if (priorMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = priorMode;
    if (priorHost === undefined) delete process.env.REMNIC_HOST;
    else process.env.REMNIC_HOST = priorHost;
    if (priorPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = priorPort;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

const HEALTH_WORKER_STUB = `
import http from "node:http";
import { parentPort, workerData } from "node:worker_threads";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, namespacesEnabled: false, memoryDir: workerData.memoryDir }));
});
server.listen(workerData.port ?? 0, "127.0.0.1", () => {
  parentPort.postMessage({ port: server.address().port });
});
parentPort.on("message", () => server.close(() => process.exit(0)));
`;

test("a rotated UNIT credential reaches delegate routes without a gateway restart", async () => {
  // End-to-end counterpart to the config-token rotation above: the credential
  // detection authenticated with must not be frozen just because it came from
  // the unit rather than a config file.
  //
  // Detection is SYNCHRONOUS (`Atomics.wait`), so its health probe cannot be
  // answered by a server on this thread — a worker serves it, then hands the
  // port to an in-process server for the async recall routes.
  const memoryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-unit-rot-mem-")));
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(HEALTH_WORKER_STUB)}`), {
    type: "module",
    workerData: { memoryDir },
  } as ConstructorParameters<typeof Worker>[1] & { type: "module" });
  const ready = Promise.withResolvers<number>();
  worker.on("message", (message: { port: number }) => ready.resolve(message.port));
  worker.on("error", ready.reject);
  const port = await ready.promise;

  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-unit-rot-home-"));
  const unitDir = path.join(home, ".config", "systemd", "user");
  await mkdir(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, "remnic.service");
  const writeUnitToken = async (token: string): Promise<void> => {
    await writeFile(
      unitPath,
      [
        "[Service]",
        "Environment=REMNIC_HOST=127.0.0.1",
        `Environment=REMNIC_PORT=${port}`,
        `Environment=REMNIC_AUTH_TOKEN=${token}`,
        "",
      ].join("\n"),
      "utf8",
    );
  };
  await writeUnitToken("unit-token-v1");

  const priorHome = process.env.HOME;
  const priorEnv = new Map(
    ["REMNIC_BRIDGE_MODE", "REMNIC_HOST", "REMNIC_PORT"].map((key) => [key, process.env[key]]),
  );
  let server: http.Server | undefined;
  try {
    process.env.HOME = home;
    for (const key of priorEnv.keys()) Reflect.deleteProperty(process.env, key);
    const api = recordingApi();
    assert.equal(
      maybeRegisterDelegateRuntime(
        api,
        {
          serviceId: "unit-rotation",
          configBridgeMode: "auto",
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
          capability: TEST_CAPABILITY,
        },
        { checkHealth: () => true },
      ),
      true,
      "auto delegated to the same-corpus daemon the unit names",
    );

    // Hand the port to a server on this thread, which the async routes reach.
    worker.postMessage("close");
    await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    const recallAuthorization: Array<string | undefined> = [];
    server = http.createServer((req, res) => {
      const pathname = String(req.url);
      res.setHeader("content-type", "application/json");
      if (pathname.startsWith("/engram/v1/recall")) {
        recallAuthorization.push(req.headers.authorization);
        res.end(JSON.stringify({ context: "delegated context" }));
        return;
      }
      res.end(JSON.stringify({ ok: true, namespacesEnabled: false, memoryDir }));
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(port, "127.0.0.1", listening.resolve);
    await listening.promise;

    await invoke(api, "before_prompt_build", { prompt: "what did we decide?" }, { sessionKey: "s" });
    // The administrator rotates the unit's credential and restarts the daemon.
    await writeUnitToken("unit-token-v2");
    await invoke(api, "before_prompt_build", { prompt: "what did we decide?" }, { sessionKey: "s" });

    assert.deepEqual(recallAuthorization, ["Bearer unit-token-v1", "Bearer unit-token-v2"]);
  } finally {
    if (priorHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await worker.terminate();
    const listener = server;
    if (listener !== undefined) {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(home, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});

/**
 * The plan file's contents, treating a missing file as drained.
 *
 * Ingestion claims the notes by renaming the file aside (issue #2303), so a
 * fully-delivered plan leaves no file behind unless the host appended again.
 * Both states mean the same thing to the host: nothing is pending.
 */
async function readPlanOrEmpty(planPath: string): Promise<string> {
  try {
    return await readFile(planPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw err;
  }
}

test("the host's flush-plan notes reach the daemon and the file is cleared", async () => {
  // The capability advertises a flush plan, so OpenClaw appends durable notes
  // to the gateway workspace. Embedded mode ingests that file from
  // `src/index.ts`; delegate mode returns before that wiring, so without this
  // the notes the host was told to write are read by nobody.
  const observed: Array<Record<string, unknown>> = [];
  const stub = await startDaemonStub((pathname, body) => {
    if (pathname.startsWith("/engram/v1/observe")) observed.push(body);
    return { flushed: true };
  });
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-flushplan-ws-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "flush-plan-svc", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, "- the user prefers terse commit messages\n", "utf8");
  try {
    const api = recordingApi();
    registerDelegateRuntime(
      api,
      optionsFor(stub.port, {
        serviceId: "flush-plan-svc",
        capability: { ...TEST_CAPABILITY, workspaceDir },
      }),
    );
    await invoke(api, "before_compaction", {}, { sessionKey: "s", workspaceDir });

    assert.equal(observed.length, 1, "the notes were handed to the daemon");
    assert.match(
      String((observed[0]?.messages as Array<{ content?: string }>)?.[0]?.content),
      /terse commit messages/,
    );
    assert.equal(await readPlanOrEmpty(planPath), "", "and the file was cleared after acceptance");
  } finally {
    await stub.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("a non-string search session key cannot inherit another session's binding", async () => {
  // The binding store's `encodeURIComponent` coerces `123` to `"123"`, so a
  // numeric key from the untyped host would search the namespace bound to the
  // distinct string-keyed session "123" — another tenant whenever the delegate
  // token can read both.
  const searched: Array<Record<string, unknown>> = [];
  const stub = await startDaemonStub((pathname, body) => {
    if (pathname.startsWith("/engram/v1/memories/search")) {
      searched.push(body);
      return { query: "q", count: 0, results: [] };
    }
    return { ok: true, namespacesEnabled: true, defaultNamespace: "fallback" };
  });
  try {
    let captured: { runtime?: { getMemorySearchManager?: (p: unknown) => Promise<unknown> } } = {};
    const api = recordingApi() as unknown as Record<string, unknown>;
    api.registerMemoryCapability = (capability: unknown) => {
      captured = capability as typeof captured;
    };
    // The FILE store is the one that coerces (`encodeURIComponent`), so it is
    // the one this guard protects. Bind the STRING session "123".
    const bindingsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-coerced-key-"));
    const namespaceBindings = createFileSessionNamespaceBindingStore(
      path.join(bindingsDir, "bindings"),
    );
    await namespaceBindings.remember("123", "tenant-a");
    registerDelegateRuntime(api as never, optionsFor(stub.port, { namespaceBindings }));

    const handout = (await captured.runtime?.getMemorySearchManager?.({
      cfg: {},
      agentId: "main",
    })) as { manager?: { search(q: string, o?: unknown): Promise<unknown> } } | undefined;
    await handout?.manager?.search("q", { sessionKey: 123 as unknown as string });

    assert.equal(searched.length, 1, "the search reached the daemon");
    assert.notEqual(
      searched[0]?.namespace,
      "tenant-a",
      "a numeric key did not inherit the string key's binding",
    );
  } finally {
    await stub.close();
  }
});

test("flush-plan notes survive a rejection, a concurrent append, and a symlink", async () => {
  // Three ways the ingestion could destroy notes the daemon never took.
  const stub = await startDaemonStub(
    (pathname) => (pathname.startsWith("/engram/v1/observe") ? null : { flushed: true }),
    {
      // A refusal is an HTTP status, not a null body: a 200 means the
      // daemon TOOK the notes (issue #2303).
      statusFor: (pathname) =>
        pathname.startsWith("/engram/v1/observe") ? 403 : undefined,
    },
  );
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fp-guard-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "guard-svc", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  const options = {
    target: { host: "127.0.0.1", port: stub.port, resolveAuthToken: () => ({ token: "t", source: "daemon configuration" as const }) },
    serviceId: "guard-svc",
    workspaceDir,
    sessionKey: "s",
    namespace: undefined,
    remainingTimeoutMs: () => 5_000,
  };

  let accepting: Awaited<ReturnType<typeof startDaemonStub>> | undefined;
  try {
    // 1. A REFUSED observe (403) must keep the notes. They stay in the
    // snapshot rather than being written back over the file the host appends
    // to; the next claim merges the snapshot ahead of newly claimed notes.
    await writeFile(planPath, "- keep me\n", "utf8");
    await ingestFlushPlanNotes(options);
    assert.equal(
      await readPlanOrEmpty(`${planPath}.inflight`),
      "- keep me\n",
      "rejected notes were kept for the next flush",
    );

    // 2. An append that lands mid-flight must survive the truncation.
    await stub.close();
    let appended = false;
    const acceptedBodies: string[] = [];
    accepting = await startDaemonStub(async (pathname, body) => {
      if (pathname.startsWith("/engram/v1/observe")) {
        acceptedBodies.push(
          String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
        );
        if (appended) {
          appended = false;
          // A real host APPENDS; it never rewrites the file. Rotation has
          // already moved the claimed notes aside, so this creates a fresh
          // plan file holding only the new note (issue #2303).
          await appendFile(planPath, "- appended later\n", "utf8");
        }
      }
      return { ok: true };
    });
    const appending = {
      ...options,
      target: { ...options.target, port: accepting.port },
    };
    await rm(`${planPath}.inflight`, { force: true });
    await writeFile(planPath, "- sent\n", "utf8");
    // The stub appends while the observe is in flight, so the write provably
    // lands between the ingestion's read and its commit.
    appended = true;
    await ingestFlushPlanNotes(appending);
    assert.deepEqual(
      acceptedBodies,
      ["- sent\n", "- appended later\n"],
      "the mid-flight append was delivered rather than truncated away",
    );
    assert.equal(await readPlanOrEmpty(planPath), "", "and the file drained");

    // 3. A symlinked plan file is refused outright.
    await rm(planPath, { force: true });
    const target = path.join(workspaceDir, "outside.md");
    await writeFile(target, "- someone else's file\n", "utf8");
    await symlink(target, planPath);
    await ingestFlushPlanNotes(appending);
    assert.equal(
      await readFile(target, "utf8"),
      "- someone else's file\n",
      "the symlink target was neither read nor truncated",
    );
  } finally {
    await accepting?.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("oversized flush-plan notes drain in chunks instead of deadlocking", async () => {
  // Past the daemon's `maxBodyBytes`, a single-message post 413s forever and
  // the keep-on-rejection rule turns that into a permanent deadlock: every
  // later flush resends the same oversized body.
  const bodies: string[] = [];
  const stub = await startDaemonStub((pathname, body) => {
    if (pathname.startsWith("/engram/v1/observe")) {
      const content = String(
        (body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? "",
      );
      // Reject anything a default-configured daemon would.
      if (Buffer.byteLength(content, "utf8") > 131_072) return null;
      bodies.push(content);
    }
    return { ok: true };
  });
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fp-chunk-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "chunk-svc", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  // ~300 KiB of notes: three chunks at the 96 KiB bound.
  const line = `- ${"note ".repeat(40)}\n`;
  const notes = line.repeat(Math.ceil((300 * 1024) / line.length));
  await writeFile(planPath, notes, "utf8");
  try {
    await ingestFlushPlanNotes({
      target: {
        host: "127.0.0.1",
        port: stub.port,
        resolveAuthToken: () => ({ token: "t", source: "daemon configuration" as const }),
      },
      serviceId: "chunk-svc",
      workspaceDir,
      sessionKey: "s",
      namespace: undefined,
      remainingTimeoutMs: () => 10_000,
    });
    assert.ok(bodies.length >= 3, `posted in ${bodies.length} chunks`);
    assert.ok(
      bodies.every((b) => Buffer.byteLength(b, "utf8") <= 131_072),
      "every chunk fit the daemon's body limit",
    );
    assert.equal(bodies.join(""), notes, "and together they carry every note exactly once");
    assert.equal(await readPlanOrEmpty(planPath), "", "the file drained");
  } finally {
    await stub.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("a 413 halves the chunk while an auth refusal stops immediately", async () => {
  // The old contract collapsed every failure to `null`, so an auth refusal
  // ran the halving ladder and a real 413 threw instead of adapting
  // (issue #2303).
  const observeSizes: number[] = [];
  const limit = 8 * 1024;
  const stub = await startDaemonStub(
    (pathname, body) => {
      if (pathname.startsWith("/engram/v1/observe")) {
        observeSizes.push(
          Buffer.byteLength(
            String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
            "utf8",
          ),
        );
      }
      return { ok: true };
    },
    {
      statusFor: (pathname, body) => {
        if (!pathname.startsWith("/engram/v1/observe")) return undefined;
        const content = String(
          (body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? "",
        );
        return Buffer.byteLength(content, "utf8") > limit ? 413 : undefined;
      },
    },
  );
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fp-413-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "s413", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  const line = `- ${"note ".repeat(40)}\n`;
  const notes = line.repeat(Math.ceil((40 * 1024) / line.length));
  await writeFile(planPath, notes, "utf8");

  let refusing: Awaited<ReturnType<typeof startDaemonStub>> | undefined;
  let firstClosed = false;
  try {
    const target = {
      host: "127.0.0.1",
      port: stub.port,
      resolveAuthToken: () => ({ token: "t", source: "daemon configuration" as const }),
    };
    await ingestFlushPlanNotes({
      target,
      serviceId: "s413",
      workspaceDir,
      sessionKey: "s",
      namespace: undefined,
      remainingTimeoutMs: () => 10_000,
    });
    assert.ok(
      observeSizes.some((size) => size > limit),
      "the first attempt used the large chunk",
    );
    assert.ok(
      observeSizes.filter((size) => size <= limit).length >= 4,
      `halved down to the daemon's limit, sizes: ${observeSizes.join(",")}`,
    );
    assert.equal(await readPlanOrEmpty(planPath), "", "and every note drained");

    // An auth refusal must NOT walk the halving ladder.
    await stub.close();
    firstClosed = true;
    const authAttempts: number[] = [];
    refusing = await startDaemonStub(
      (pathname, body) => {
        if (pathname.startsWith("/engram/v1/observe")) {
          authAttempts.push(
            Buffer.byteLength(
              String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
              "utf8",
            ),
          );
        }
        return { ok: true };
      },
      {
        statusFor: (pathname) =>
          pathname.startsWith("/engram/v1/observe") ? 401 : undefined,
      },
    );
    await writeFile(planPath, notes, "utf8");
    await ingestFlushPlanNotes({
      target: { ...target, port: refusing.port },
      serviceId: "s413",
      workspaceDir,
      sessionKey: "s",
      namespace: undefined,
      remainingTimeoutMs: () => 10_000,
    });
    assert.equal(authAttempts.length, 1, "a refused credential is not retried at smaller sizes");
    assert.equal(
      await readPlanOrEmpty(`${planPath}.inflight`),
      notes,
      "and the notes were kept in the snapshot for the next flush",
    );
  } finally {
    if (!firstClosed) await stub.close();
    await refusing?.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("an interrupted ingestion's notes are recovered on the next run", async () => {
  // Rotation claims the notes by rename. A crash between the rename and the
  // post would strand them without this recovery (issue #2303).
  const delivered: string[] = [];
  const stub = await startDaemonStub((pathname, body) => {
    if (pathname.startsWith("/engram/v1/observe")) {
      delivered.push(
        String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
      );
    }
    return { ok: true };
  });
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fp-recover-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "recov", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  try {
    // Simulate the crash: an inflight snapshot with no plan file.
    await writeFile(`${planPath}.inflight`, "- stranded note\n", "utf8");
    await writeFile(planPath, "- fresh note\n", "utf8");
    await ingestFlushPlanNotes({
      target: {
        host: "127.0.0.1",
        port: stub.port,
        resolveAuthToken: () => ({ token: "t", source: "daemon configuration" as const }),
      },
      serviceId: "recov",
      workspaceDir,
      sessionKey: "s",
      namespace: undefined,
      remainingTimeoutMs: () => 5_000,
    });
    assert.deepEqual(
      delivered,
      ["- stranded note\n- fresh note\n"],
      "the stranded note was recovered ahead of the newer one",
    );
    assert.equal(await readPlanOrEmpty(planPath), "", "and the plan drained");
    assert.equal(await readPlanOrEmpty(`${planPath}.inflight`), "", "the snapshot was removed");
  } finally {
    await stub.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("a stranded rotate target is recovered ahead of newer notes", async () => {
  // A run that died between its rename and its merge left the notes only in
  // `.rotating`. Recovery that read `.inflight` alone stranded them (#2303).
  const delivered: string[] = [];
  const stub = await startDaemonStub((pathname, body) => {
    if (pathname.startsWith("/engram/v1/observe")) {
      delivered.push(
        String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
      );
    }
    return { ok: true };
  });
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fp-rot-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "rot", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  try {
    await writeFile(`${planPath}.rotating`, "- stranded in rotate\n", "utf8");
    await writeFile(`${planPath}.inflight`, "- stranded in flight\n", "utf8");
    await writeFile(planPath, "- fresh\n", "utf8");
    await ingestFlushPlanNotes({
      target: {
        host: "127.0.0.1",
        port: stub.port,
        resolveAuthToken: () => ({ token: "t", source: "daemon configuration" as const }),
      },
      serviceId: "rot",
      workspaceDir,
      sessionKey: "s",
      namespace: undefined,
      remainingTimeoutMs: () => 5_000,
    });
    assert.deepEqual(
      delivered,
      ["- stranded in flight\n- stranded in rotate\n- fresh\n"],
      "every stranded note was recovered, oldest first",
    );
    assert.equal(await readPlanOrEmpty(`${planPath}.rotating`), "", "the rotate target is gone");
    assert.equal(await readPlanOrEmpty(`${planPath}.inflight`), "", "the snapshot is gone");
  } finally {
    await stub.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("a note the daemon can never accept is quarantined, not left blocking the queue", async () => {
  // At the minimum chunk size the chunk is one line. Keeping it stalled every
  // note behind it on every future flush (#2303).
  const delivered: string[] = [];
  const stub = await startDaemonStub(
    (pathname, body) => {
      if (pathname.startsWith("/engram/v1/observe")) {
        delivered.push(
          String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
        );
      }
      return { ok: true };
    },
    {
      statusFor: (pathname, body) => {
        if (!pathname.startsWith("/engram/v1/observe")) return undefined;
        const content = String(
          (body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? "",
        );
        return content.includes("HUGE") ? 413 : undefined;
      },
    },
  );
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fp-quar-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "quar", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  try {
    await writeFile(planPath, "- HUGE unacceptable note\n- ordinary note\n", "utf8");
    await ingestFlushPlanNotes({
      target: {
        host: "127.0.0.1",
        port: stub.port,
        resolveAuthToken: () => ({ token: "t", source: "daemon configuration" as const }),
      },
      serviceId: "quar",
      workspaceDir,
      sessionKey: "s",
      namespace: undefined,
      remainingTimeoutMs: () => 5_000,
    });
    assert.deepEqual(delivered.at(-1), "- ordinary note\n", "the queue drained past the bad note");
    assert.equal(
      await readPlanOrEmpty(`${planPath}.oversized`),
      "- HUGE unacceptable note\n",
      "and the refused note is preserved in the sidecar",
    );
    assert.equal(await readPlanOrEmpty(planPath), "", "nothing is left pending");
  } finally {
    await stub.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("a symlinked snapshot sidecar is refused before it is read", async () => {
  // `flush-plan.md.inflight` pointed at another file would send that file to
  // the daemon and then overwrite it (#2303).
  const stub = await startDaemonStub(() => ({ ok: true }));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fp-link-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "link", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  try {
    const outside = path.join(workspaceDir, "secrets.md");
    await writeFile(outside, "- someone else's file\n", "utf8");
    await writeFile(planPath, "- real note\n", "utf8");
    await symlink(outside, `${planPath}.inflight`);
    await ingestFlushPlanNotes({
      target: {
        host: "127.0.0.1",
        port: stub.port,
        resolveAuthToken: () => ({ token: "t", source: "daemon configuration" as const }),
      },
      serviceId: "link",
      workspaceDir,
      sessionKey: "s",
      namespace: undefined,
      remainingTimeoutMs: () => 5_000,
    });
    assert.equal(
      await readPlanOrEmpty(outside),
      "- someone else's file\n",
      "the symlink target was neither read nor overwritten",
    );
    assert.equal(await readPlanOrEmpty(planPath), "- real note\n", "and the notes were kept");
  } finally {
    await stub.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("a daemon limit below the chunk floor splits instead of quarantining good notes", async () => {
  // With maxBodyBytes under the observe chunk size, a small daemon limit
  // does NOT mean the chunk is one line — it can still be a multi-line batch.
  // The trigger for quarantine is the chunk's shape, not a byte floor (#2303).
  const delivered: string[] = [];
  const limit = 200;
  const overLimit = (body: Record<string, unknown>): boolean =>
    Buffer.byteLength(
      String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
      "utf8",
    ) > limit;
  const stub = await startDaemonStub(
    (pathname, body) => {
      // Record only what the daemon ACCEPTS; a 413 delivers nothing.
      if (pathname.startsWith("/engram/v1/observe") && !overLimit(body)) {
        delivered.push(
          String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
        );
      }
      return { ok: true };
    },
    {
      statusFor: (pathname, body) =>
        pathname.startsWith("/engram/v1/observe") && overLimit(body) ? 413 : undefined,
    },
  );
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fp-subfloor-"));
  const planPath = path.join(workspaceDir, "state", "plugins", "sub", "flush-plan.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  try {
    const notes = Array.from({ length: 40 }, (_, i) => `- short note ${i}\n`).join("");
    await writeFile(planPath, notes, "utf8");
    await ingestFlushPlanNotes({
      target: {
        host: "127.0.0.1",
        port: stub.port,
        resolveAuthToken: () => ({ token: "t", source: "daemon configuration" as const }),
      },
      serviceId: "sub",
      workspaceDir,
      sessionKey: "s",
      namespace: undefined,
      remainingTimeoutMs: () => 10_000,
    });
    assert.equal(
      await readPlanOrEmpty(`${planPath}.oversized`),
      "",
      "no acceptable note was quarantined",
    );
    assert.equal(delivered.join(""), notes, "every note was delivered exactly once");
    assert.equal(await readPlanOrEmpty(`${planPath}.inflight`), "", "and nothing is left pending");
  } finally {
    await stub.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
