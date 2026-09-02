import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  type SessionNamespaceBindingStore,
  createFileSessionNamespaceBindingStore,
} from "@remnic/core/session-namespace-bindings";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "@remnic/core/testing/lifecycle-matrix";
import { type DelegateRuntimeOptions, registerDelegateRuntime } from "../../delegate-runtime.js";

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

interface RecordedCall {
  pathname: string;
  body: Record<string, unknown>;
}

interface DelegateLifecycleState {
  directory: string;
  filePath: string;
  namespaceBindings: SessionNamespaceBindingStore;
  api: RecordingApi;
  daemon: DaemonStub;
  sessionKey: string;
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
  on: (hook: string, handler: HookHandler) => void;
}

function recordingApi(): RecordingApi {
  const handlers = new Map<string, HookHandler[]>();
  return {
    handlers,
    on(hook: string, handler: HookHandler): void {
      handlers.set(hook, [...(handlers.get(hook) ?? []), handler]);
    },
  };
}

async function startDaemonStub(): Promise<DaemonStub> {
  const calls: RecordedCall[] = [];
  const arrivals: Array<{ pathname: string; resolve: (call: RecordedCall) => void }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const call = { pathname: req.url ?? "", body };
      calls.push(call);
      for (const waiter of arrivals.splice(0)) {
        if (waiter.pathname === call.pathname) waiter.resolve(call);
        else arrivals.push(waiter);
      }
      res.setHeader("content-type", "application/json");
      const requestedNamespaces = Array.isArray(body.namespaces) ? body.namespaces : undefined;
      const response =
        req.url === "/engram/v1/recall"
          ? { context: "remembered" }
          // A real daemon always reports its namespace posture on health.
          : req.url === "/engram/v1/health"
            ? { ok: true, namespacesEnabled: false }
          : req.url === "/engram/v1/capabilities"
            ? { lcmCompactionFlushBatch: true }
            : requestedNamespaces !== undefined
              ? {
                  enabled: true,
                  flushed: true,
                  sessionKey: body.sessionKey,
                  namespaces: requestedNamespaces,
                  results: requestedNamespaces.map((namespace) => ({
                    status: "fulfilled",
                    namespace,
                    result: { enabled: true, flushed: true },
                  })),
                }
              : {
                  enabled: true,
                  flushed: true,
                  sessionKey: body.sessionKey,
                  namespace: typeof body.namespace === "string" ? body.namespace : "",
                };
      res.end(JSON.stringify(response));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("delegate matrix daemon did not bind");
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

function optionsFor(port: number, namespaceBindings: SessionNamespaceBindingStore): DelegateRuntimeOptions {
  return {
    serviceId: "delegate-lifecycle-matrix",
    target: {
      host: "127.0.0.1",
      port,
      resolveAuthToken: () => ({
        token: "",
        source: "no configured token",
      }),
    },
    namespace: "",
    namespaceBindings,
    allowPromptInjection: true,
    passive: false,
    gateHeartbeatTurns: false,
    recallBudgetChars: 8_000,
    resolveSessionDisabled: async () => false,
    cleanUserMessage: (text) => text,
    hookTimeoutMs: 5_000,
    shouldSkipRecall: () => false,
    flushOnResetEnabled: true,
    recallTimeoutMs: 5_000,
    observeTimeoutMs: 5_000,
    flushTimeoutMs: 5_000,
    capability: {
      memoryDir: path.join(os.tmpdir(), "remnic-delegate-matrix-memory"),
      workspaceDir: path.join(os.tmpdir(), "remnic-delegate-matrix-workspace"),
      agentIds: ["generalist"],
      configuredSearchBackend: "qmd",
      configuredQmdCommand: "qmd",
    },
  };
}

function registerRuntime(state: DelegateLifecycleState): void {
  state.api = recordingApi();
  registerDelegateRuntime(state.api, optionsFor(state.daemon.port, state.namespaceBindings));
}

async function invoke(
  state: DelegateLifecycleState,
  hook: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown> = {}
): Promise<unknown> {
  const handlers = state.api.handlers.get(hook);
  assert.ok(handlers && handlers.length === 1, `${hook} must have exactly one handler`);
  return await handlers[0](event, ctx);
}

function namespaceContext(sessionKey: string, namespace: string): Record<string, unknown> {
  return {
    sessionKey,
    runtime: { agent: { session: { namespace } } },
  };
}

function callsFor(state: DelegateLifecycleState, pathname: string): RecordedCall[] {
  return state.daemon.calls.filter((call) => call.pathname === pathname);
}

const subject: LifecycleSubject<DelegateLifecycleState> = {
  async setup(row: MatrixRow): Promise<DelegateLifecycleState> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-delegate-lifecycle-"));
    try {
      const filePath = path.join(directory, "session-namespace-bindings.json");
      const state: DelegateLifecycleState = {
        directory,
        filePath,
        namespaceBindings: createFileSessionNamespaceBindingStore(filePath),
        api: recordingApi(),
        daemon: await startDaemonStub(),
        sessionKey: `matrix-${row.id}`,
      };
      registerRuntime(state);
      return state;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  },

  async exercise(state: DelegateLifecycleState, row: MatrixRow): Promise<void> {
    const { sessionKey } = state;
    switch (row.id) {
      case "explicit-provider-identity": {
        await invoke(
          state,
          "before_prompt_build",
          { prompt: "recall this retained memory" },
          namespaceContext(sessionKey, "team-explicit")
        );
        // `agent_end` detaches its observe POST; wait for it to reach the daemon.
        const observeArrived = state.daemon.nextCall("/engram/v1/observe");
        await invoke(
          state,
          "agent_end",
          {
            success: true,
            sessionKey,
            messages: [
              { role: "user", content: "Please retain this meaningful user turn." },
              { role: "assistant", content: "I will retain this useful assistant response." },
            ],
          },
          namespaceContext(sessionKey, "team-explicit")
        );
        await observeArrived;
        return;
      }
      case "sparse-metadata-with-binding":
        await state.namespaceBindings.remember(sessionKey, "team-remembered");
        await invoke(state, "before_prompt_build", { prompt: "recall this retained memory" }, { sessionKey });
        return;
      case "sparse-metadata-without-binding":
        await invoke(state, "before_prompt_build", { prompt: "recall this retained memory" }, { sessionKey });
        return;
      case "provider-rebinding":
        await invoke(
          state,
          "before_prompt_build",
          { prompt: "recall the first provider binding" },
          namespaceContext(sessionKey, "team-first")
        );
        await invoke(
          state,
          "before_prompt_build",
          { prompt: "recall the rebound provider binding" },
          namespaceContext(sessionKey, "team-second")
        );
        await invoke(state, "before_compaction", { sessionKey });
        return;
      case "restart-reload-recovery":
        await invoke(
          state,
          "before_prompt_build",
          { prompt: "record the persisted provider binding" },
          namespaceContext(sessionKey, "team-persisted")
        );
        state.namespaceBindings = createFileSessionNamespaceBindingStore(state.filePath);
        registerRuntime(state);
        await invoke(
          state,
          "before_prompt_build",
          { prompt: "recover the persisted provider binding" },
          { sessionKey }
        );
        return;
      case "compaction-flush":
        assert.equal(
          await invoke(
            state,
            "before_compaction",
            { sessionKey },
            namespaceContext(sessionKey, "team-compaction"),
          ),
          true,
        );
        return;
      case "before-reset":
        assert.equal(
          await invoke(
            state,
            "before_reset",
            { sessionKey },
            namespaceContext(sessionKey, "team-reset"),
          ),
          true,
        );
        return;
      case "session-end":
        assert.equal(
          await invoke(
            state,
            "session_end",
            { sessionKey },
            namespaceContext(sessionKey, "team-end"),
          ),
          true,
        );
        return;
      case "dedupe-replay":
        await invoke(
          state,
          "before_prompt_build",
          { prompt: "record one replayable provider binding" },
          namespaceContext(sessionKey, "team-replay")
        );
        await invoke(
          state,
          "before_prompt_build",
          { prompt: "replay the same provider binding again" },
          namespaceContext(sessionKey, "team-replay")
        );
        await invoke(state, "before_compaction", { sessionKey });
        await invoke(state, "before_compaction", { sessionKey });
        return;
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled lifecycle row ${String(exhaustive)}`);
      }
    }
  },

  async invariants(state: DelegateLifecycleState, row: MatrixRow): Promise<void> {
    const recallCalls = callsFor(state, "/engram/v1/recall");
    const flushCalls = callsFor(state, "/engram/v1/lcm/compaction/flush");
    switch (row.id) {
      case "explicit-provider-identity": {
        assert.equal(recallCalls[0]?.body.namespace, "team-explicit");
        assert.equal(callsFor(state, "/engram/v1/observe")[0]?.body.namespace, "team-explicit");
        return;
      }
      case "sparse-metadata-with-binding":
        assert.equal(recallCalls[0]?.body.namespace, "team-remembered");
        return;
      case "sparse-metadata-without-binding":
        assert.equal(recallCalls.length, 1, "expected exactly one recall call");
        assert.equal("namespace" in (recallCalls[0]?.body ?? {}), false);
        return;
      case "provider-rebinding":
        assert.deepEqual(
          flushCalls.map((call) => call.body.namespaces),
          [["team-first", "team-second"]],
        );
        return;
      case "restart-reload-recovery":
        assert.equal(recallCalls.at(-1)?.body.namespace, "team-persisted");
        return;
      case "compaction-flush":
        assert.equal(flushCalls[0]?.body.namespace, "team-compaction");
        return;
      case "before-reset":
        assert.equal(flushCalls[0]?.body.namespace, "team-reset");
        return;
      case "session-end":
        assert.equal(flushCalls[0]?.body.namespace, "team-end");
        return;
      case "dedupe-replay":
        assert.deepEqual(await state.namespaceBindings.namespacesFor(state.sessionKey), ["team-replay"]);
        assert.deepEqual(
          flushCalls.map((call) => call.body.namespace),
          ["team-replay", "team-replay"]
        );
        return;
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled lifecycle row ${String(exhaustive)}`);
      }
    }
  },

  async teardown(state: DelegateLifecycleState): Promise<void> {
    await state.daemon.close();
    await rm(state.directory, { recursive: true, force: true });
  },
};

runLifecycleMatrix("openclaw-delegate-runtime", subject);
