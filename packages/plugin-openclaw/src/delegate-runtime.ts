/**
 * Delegate bridge runtime (issue #2120).
 *
 * When bridge mode is `delegate`, the plugin does NOT construct the embedded
 * orchestrator. Instead it backs the core memory loop with the standalone
 * daemon's HTTP API — the same surface the Claude Code / Codex hooks and the
 * pi extension already use:
 *
 *   - memory injection    → POST /engram/v1/recall (before_prompt_build or
 *                           legacy before_agent_start)
 *   - turn capture        → POST /engram/v1/observe (agent_end, last turn)
 *   - compaction/reset    → POST /engram/v1/lcm/compaction/flush
 *
 * Deliberately out of scope for delegate v1 (still embedded-only): tool and
 * CLI registration, heartbeat/dreams surfaces, hourly summary crons, public
 * artifacts, and the memory-capability object. The daemon already exposes the
 * tool surface over HTTP/MCP to any client that needs it. This keeps a
 * co-located gateway from running a second orchestrator over the daemon's
 * memory corpus (double maintenance crons, duplicate extraction load, shared
 * SQLite contention).
 */

import { log } from "@remnic/core/logger";
import path from "node:path";
import { createFileToggleStore } from "@remnic/core/session-toggles";
import {
  checkDaemonHealthSync,
  loadDaemonAuthToken,
  resolveBridgeMode,
} from "./bridge.js";
import {
  extractLastTurn,
  extractTextContent,
} from "./transcript-turns.js";

export interface DelegateDaemonTarget {
  host: string;
  port: number;
  authToken: string;
}

export interface DelegateRuntimeOptions {
  serviceId: string;
  target: DelegateDaemonTarget;
  /** Session namespace forwarded on every daemon call ("" = daemon default). */
  namespace: string;
  /** Mirrors the embedded `hooks.allowPromptInjection` policy. */
  allowPromptInjection: boolean;
  /** Passive slot mode: register nothing, exactly like embedded passive mode
   * skips prompt-injection and extraction hooks. */
  passive: boolean;
  /** Mirrors embedded `heartbeat.gateExtractionDuringHeartbeat`: skip
   * observing heartbeat-triggered turns. */
  gateHeartbeatTurns: boolean;
  /** Injection cap in characters. Embedded contract: `0` DISABLES memory
   * injection entirely (zero-limit semantics are a compatibility guarantee),
   * any positive value trims the injected context. */
  recallBudgetChars: number;
  /** Resolve the per-session memory toggle (embedded sessionToggleStore
   * parity); return true to skip recall for the session. */
  resolveSessionDisabled: (sessionKey: string, agentId: string) => Promise<boolean>;
  /** Embedded parity: strip OpenClaw channel envelopes from user messages
   * before they are observed. */
  cleanUserMessage: (text: string) => string;
  /** Passed as the hook registration timeout (embedded initGateTimeoutMs). */
  hookTimeoutMs: number;
  /** Embedded parity: `shouldSkipRecallForSession` (cron recall policy). */
  shouldSkipRecall: (sessionKey: string) => boolean;
  /** Embedded parity (issue #569): working dir for daemon git-context scoping. */
  cwd?: string;
  /** Embedded parity (issue #569): non-git project tag scoping. */
  projectTag?: string;
  /** Embedded parity: gate buffer flush on reset/session_end. */
  flushOnResetEnabled: boolean;
  recallTimeoutMs: number;
  observeTimeoutMs: number;
  flushTimeoutMs: number;
}

export interface DelegateHookApi {
  on(
    hook: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
    opts?: { timeoutMs?: number },
  ): void;
  // Method syntax (bivariant params) so the real OpenClaw api — whose
  // builder parameter is a wider SDK union — remains assignable.
  registerMemoryPromptSection?(builder: (params: { sessionKey?: string }) => string[] | null): void;
}

const MEMORY_CONTEXT_HEADER = "## Memory Context (Remnic)";

async function postJson(
  target: DelegateDaemonTarget,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.authToken) headers.Authorization = `Bearer ${target.authToken}`;
  const res = await fetch(`http://${target.host}:${target.port}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`daemon ${pathname} responded ${res.status}`);
  }
  const parsed: unknown = await res.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : null;
}

function sessionKeyFrom(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string {
  const fromCtx = ctx?.sessionKey;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const fromEvent = event?.sessionKey;
  if (typeof fromEvent === "string" && fromEvent.length > 0) return fromEvent;
  return "default";
}

function recallQueryFrom(event: Record<string, unknown>): string {
  // Mirrors the embedded recall hook: prefer event.prompt, but when it is
  // missing or shorter than 5 chars, scan event.messages backward for the most
  // recent user utterance >= 5 chars (before_prompt_build may only ship messages).
  let prompt = typeof event.prompt === "string" ? event.prompt : undefined;
  if ((!prompt || prompt.length < 5) && Array.isArray(event.messages)) {
    const msgs = event.messages as Array<Record<string, unknown>>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") {
        const text = extractTextContent(msgs[i] as Record<string, unknown>);
        if (text.length >= 5) {
          prompt = text;
          break;
        }
      }
    }
  }
  return prompt ?? "";
}

function withNamespace(
  namespace: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return namespace.length > 0 ? { ...body, namespace } : body;
}

/**
 * Register the delegate runtime against a healthy daemon.
 *
 * The caller is responsible for the health preflight (bridge
 * `checkDaemonHealth`) — this function only wires hooks and never throws:
 * per-hook daemon failures degrade to a log line, mirroring the "memory must
 * never break the agent turn" contract of the embedded hooks.
 */
export function registerDelegateRuntime(
  api: DelegateHookApi,
  options: DelegateRuntimeOptions,
): void {
  const { target, namespace } = options;
  if (options.passive) {
    log.info(
      `[${options.serviceId}] bridge mode delegate: memory slot not owned — passive, no hooks registered`,
    );
    return;
  }

  // Embedded zero-limit contract: recallBudgetChars === 0 disables injection.
  if (options.allowPromptInjection && options.recallBudgetChars !== 0) {
    // Session-scoped cache for the section-builder path, mirroring the
    // embedded pre-compute-then-consume contract: the hook fills it, the
    // synchronous builder consumes (and evicts) it.
    const promptLinesBySession = new Map<string, string[]>();
    const useSectionBuilder = typeof api.registerMemoryPromptSection === "function";

    const recallHandler = async (
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> => {
      const query = recallQueryFrom(event);
      if (query.trim().length < 5) return undefined;
      const sessionKey = sessionKeyFrom(event, ctx);
      if (useSectionBuilder) promptLinesBySession.delete(sessionKey);
      try {
        if (options.shouldSkipRecall(sessionKey)) {
          log.debug(`delegate recall skipped: cron policy excludes ${sessionKey}`);
          return undefined;
        }
        const runtimeAgent = (ctx?.runtime as Record<string, unknown> | undefined)
          ?.agent as Record<string, unknown> | undefined;
        const agentId =
          (typeof ctx?.agentId === "string" ? ctx.agentId : undefined) ??
          (typeof runtimeAgent?.id === "string" ? runtimeAgent.id : undefined) ??
          "";
        if (await options.resolveSessionDisabled(sessionKey, agentId)) {
          log.debug(`delegate recall skipped: session toggle disables memory for ${sessionKey}`);
          return undefined;
        }
        const response = await postJson(
          target,
          "/engram/v1/recall",
          withNamespace(namespace, {
            query,
            sessionKey,
            mode: "auto",
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.projectTag ? { projectTag: options.projectTag } : {}),
          }),
          options.recallTimeoutMs,
        );
        const rawContext = response?.context;
        if (typeof rawContext !== "string" || rawContext.trim().length === 0) {
          return undefined;
        }
        // Mirror the embedded recallBudgetChars trim so delegate mode cannot
        // exceed the configured injection budget (0 never reaches here — it
        // disables the handler above).
        const context = rawContext.slice(0, options.recallBudgetChars);
        const prompt = `${MEMORY_CONTEXT_HEADER}\n\n${context}`;
        if (useSectionBuilder) {
          // Section-builder hosts inject through the registered builder; the
          // hook only pre-computes. Returning injection fields here too would
          // double-inject.
          promptLinesBySession.set(sessionKey, prompt.split("\n"));
          return undefined;
        }
        // before_prompt_build consumes prependSystemContext; the legacy
        // before_agent_start path may consume either field, matching the
        // embedded handler's dual-field return.
        return { prependSystemContext: prompt, prependContext: prompt };
      } catch (err) {
        log.warn(`delegate recall failed: ${String(err)}`);
        return undefined;
      }
    };
    // Register on the modern hook AND the legacy hook: gateways emit one or
    // the other, never both, so dual registration cannot double-inject.
    api.on("before_prompt_build", recallHandler, { timeoutMs: options.hookTimeoutMs });
    api.on("before_agent_start", recallHandler, { timeoutMs: options.hookTimeoutMs });
    if (useSectionBuilder && api.registerMemoryPromptSection) {
      const memoryBuildFn = Object.assign(
        (params: { sessionKey?: string }): string[] | null => {
          const key = params?.sessionKey ?? "default";
          const lines = promptLinesBySession.get(key) ?? null;
          promptLinesBySession.delete(key);
          return lines;
        },
        { id: "remnic-delegate-memory", label: "Remnic Memory Context (delegate)" },
      );
      api.registerMemoryPromptSection(memoryBuildFn);
    }
  } else {
    log.info(
      `[${options.serviceId}] bridge mode delegate: prompt injection disabled by hooks policy`,
    );
  }

  api.on("agent_end", async (event, ctx) => {
    if (event.success !== true || !Array.isArray(event.messages)) return;
    if (event.messages.length === 0) return;
    // Mirror the embedded heartbeat gate: heartbeat-triggered turns are
    // operational chatter, not user memory.
    if (
      options.gateHeartbeatTurns &&
      (event.trigger === "heartbeat" || ctx?.trigger === "heartbeat")
    ) {
      return;
    }
    const sessionKey = sessionKeyFrom(event, ctx);
    const turn = extractLastTurn(event.messages as Array<Record<string, unknown>>)
      .map((message) => ({
        role: message.role,
        content:
          message.role === "user"
            ? options.cleanUserMessage(extractTextContent(message))
            : extractTextContent(message),
      }))
      .filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          message.content.trim().length > 0,
      );
    if (turn.length === 0) return;
    try {
      await postJson(
        target,
        "/engram/v1/observe",
        withNamespace(namespace, {
          sessionKey,
          messages: turn,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.projectTag ? { projectTag: options.projectTag } : {}),
        }),
        options.observeTimeoutMs,
      );
    } catch (err) {
      log.warn(`delegate observe failed: ${String(err)}`);
    }
  });

  const flushHandler = async (
    event: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): Promise<void> => {
    const sessionKey = sessionKeyFrom(event, ctx);
    try {
      await postJson(
        target,
        "/engram/v1/lcm/compaction/flush",
        withNamespace(namespace, { sessionKey }),
        options.flushTimeoutMs,
      );
    } catch (err) {
      log.warn(`delegate flush failed: ${String(err)}`);
    }
  };
  api.on("before_compaction", flushHandler);
  if (options.flushOnResetEnabled) {
    api.on("before_reset", flushHandler);
    api.on("session_end", flushHandler);
  }

  log.info(
    `[${options.serviceId}] bridge mode delegate: memory loop backed by daemon at ` +
      `${target.host}:${target.port} (embedded orchestrator skipped; tools/CLI/surfaces stay daemon-side)`,
  );
}

export interface MaybeRegisterDelegateOptions {
  serviceId: string;
  /** The parsed plugin config's `bridgeMode` value. */
  configBridgeMode: string;
  passive: boolean;
  allowPromptInjection: boolean;
  /** Embedded parity: `heartbeat.enabled && heartbeat.gateExtractionDuringHeartbeat`. */
  gateHeartbeatTurns: boolean;
  /** Embedded parity: the config's recallBudgetChars injection cap (0 disables). */
  recallBudgetChars: number;
  /** memoryDir used for the file-backed session toggle store. */
  memoryDir: string;
  /** Embedded parity: `sessionTogglesEnabled !== false` consults the store. */
  sessionTogglesEnabled: boolean;
  /** Embedded parity: also honor the bundled active-memory plugin's toggles. */
  respectBundledActiveMemoryToggle: boolean;
  /** Embedded parity: channel-envelope cleaner applied to observed user text. */
  cleanUserMessage: (text: string) => string;
  /** Embedded parity: hook registration timeout (initGateTimeoutMs). */
  hookTimeoutMs: number;
  /** Embedded parity: cron recall policy predicate. */
  shouldSkipRecall: (sessionKey: string) => boolean;
  /** Embedded parity (#569): daemon git-context working dir. */
  cwd?: string;
  /** Embedded parity (#569): non-git project tag. */
  projectTag?: string;
  /** Embedded parity: gate buffer flush on reset/session_end. */
  flushOnResetEnabled: boolean;
}

// Mirrors the embedded runtime's per-api hook dedup (globalThis HOOK_APIS
// WeakSet), scoped per serviceId: a migration install can register BOTH the
// canonical and legacy plugin ids against the same api object, and each
// service must get its own binding exactly once (double-register of one
// service would double-fire every handler).
const delegateHookApiServices = new WeakMap<object, Set<string>>();

/**
 * Resolve bridge mode, preflight the daemon, and register the delegate
 * runtime. Returns true when delegate mode handled registration (the caller
 * must skip the embedded runtime), false when the caller should proceed
 * embedded — either because delegate was not requested or because the
 * requested daemon failed its preflight (logged loudly).
 */
export interface MaybeRegisterDelegateDeps {
  /** Injectable preflight — defaults to the bridge's worker-backed sync probe. */
  checkHealth: (host: string, port: number) => boolean;
}

export function maybeRegisterDelegateRuntime(
  api: DelegateHookApi,
  options: MaybeRegisterDelegateOptions,
  deps: MaybeRegisterDelegateDeps = { checkHealth: checkDaemonHealthSync },
): boolean {
  const bridge = resolveBridgeMode(options.configBridgeMode);
  if (bridge.mode !== "delegate") return false;
  const boundServices = delegateHookApiServices.get(api);
  if (boundServices?.has(options.serviceId)) {
    log.debug(
      `delegate register: ${options.serviceId} already has hooks bound on this api — skipping duplicate registration`,
    );
    return true;
  }
  // register() is synchronous, so the preflight uses the bridge's
  // worker-backed sync health check (the same probe detectBridgeMode uses).
  if (!deps.checkHealth(bridge.daemonHost, bridge.daemonPort)) {
    log.error(
      `bridge mode delegate requested but no healthy daemon at ` +
        `${bridge.daemonHost}:${bridge.daemonPort} — falling back to the embedded runtime`,
    );
    return false;
  }
  (boundServices ?? delegateHookApiServices.set(api, new Set()).get(api))?.add(
    options.serviceId,
  );
  // Embedded toggle-store parity: same primary path (per-service plugin state)
  // and optional bundled active-memory secondary read.
  const toggleStore = options.sessionTogglesEnabled
    ? createFileToggleStore(
        path.join(options.memoryDir, "state", "plugins", options.serviceId, "session-toggles.json"),
        {
          secondaryReadOnlyPath: options.respectBundledActiveMemoryToggle
            ? path.join(options.memoryDir, "state", "plugins", "active-memory", "session-toggles.json")
            : undefined,
        },
      )
    : null;
  registerDelegateRuntime(api, {
    serviceId: options.serviceId,
    target: {
      host: bridge.daemonHost,
      port: bridge.daemonPort,
      authToken: loadDaemonAuthToken(),
    },
    namespace: "",
    allowPromptInjection: options.allowPromptInjection,
    passive: options.passive,
    gateHeartbeatTurns: options.gateHeartbeatTurns,
    recallBudgetChars: options.recallBudgetChars,
    resolveSessionDisabled: async (sessionKey: string, agentId: string) =>
      toggleStore ? (await toggleStore.resolve(sessionKey, agentId)).disabled === true : false,
    cleanUserMessage: options.cleanUserMessage,
    hookTimeoutMs: options.hookTimeoutMs,
    shouldSkipRecall: options.shouldSkipRecall,
    cwd: options.cwd,
    projectTag: options.projectTag,
    flushOnResetEnabled: options.flushOnResetEnabled,
    recallTimeoutMs: 25_000,
    observeTimeoutMs: 120_000,
    flushTimeoutMs: 55_000,
  });
  return true;
}
