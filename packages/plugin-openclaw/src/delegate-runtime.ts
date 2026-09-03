/**
 * Delegate bridge runtime (issue #2120).
 *
 * When bridge mode is `delegate`, the plugin does NOT construct the embedded
 * orchestrator. Instead it backs the core memory loop with the standalone
 * daemon's HTTP API — the same surface the Claude Code / Codex hooks and the
 * pi extension already use:
 *
 *   - memory injection    → POST /engram/v1/recall (before_prompt_build)
 *   - turn capture        → POST /engram/v1/observe (agent_end, last turn)
 *   - compaction/reset    → POST /engram/v1/lcm/compaction/flush
 *
 * Delegate also registers the host memory-capability surface (prompt builder,
 * runtime, flush plan, public artifacts) and a support-passport model
 * service. Those still call the daemon; this file does not start a second
 * orchestrator.
 *
 * Still embedded-only: tool and CLI registration, heartbeat/dreams surfaces,
 * hourly summary crons. The daemon already exposes the tool surface over
 * HTTP/MCP. That keeps a co-located gateway from running a second
 * orchestrator over the daemon's memory corpus (double maintenance crons,
 * duplicate extraction load, shared SQLite contention).
 */


import path from "node:path";
import {
  type RecallContextComposition,
  type RecallContextDegradation,
  renderMemoryContextPrompt,
} from "@remnic/core";
import { log } from "@remnic/core/logger";

import {
  DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS,
  probeDelegateAuthorization,
  reportDaemonAuthorizationFailure,
  type DelegateAuthorizationOperation,
  type DelegateAuthorizationPreflight,
} from "./delegate-authorization.js";

// Re-exported so existing importers of the runtime keep resolving.
export {
  probeDelegateAuthorization,
  type DelegateAuthorizationPreflight,
} from "./delegate-authorization.js";
import type { SessionNamespaceBindingStore } from "@remnic/core/session-namespace-bindings";
import { createDelegateNamespaceBindingStore } from "./delegate-namespace-bindings.js";
import {
  lifecycleSessionNamespacesFrom,
  rememberedNamespacesFor,
  sessionNamespaceFrom,
  withNamespace,
} from "./delegate-namespaces.js";
import { daemonTargetFor } from "./delegate-daemon-target.js";
import { ingestFlushPlanNotes } from "./delegate-flush-plan-ingest.js";
import { createFileToggleStore } from "@remnic/core/session-toggles";
import {
  type BridgeConfig,
  type DelegateDaemonTarget,
  checkDaemonHealthSync,
  daemonUrl,
  parseOpenClawBridgeConfig,
  resolveBridgeMode,
  requestedDelegate,
  resolveRequestedBridgeMode,
} from "./bridge.js";
import { REMNIC_OPENCLAW_LEGACY_PLUGIN_ID } from "./plugin-id.js";
import {
  extractLastTurn,
  extractTextContent,
} from "./transcript-turns.js";
import {
  type DelegateCapabilityApi,
  type DelegateCapabilityOptions,
  createDelegateMemoryCapability,
  registerDelegateMemoryCapability,
} from "./delegate-capability.js";
import type { SupportPassportModelRoute } from "@remnic/core";
import { createDelegateSupportPassportModelService } from "./delegate-support-passport-model.js";
import { registerDelegateTools } from "./delegate-tools.js";

export interface DelegateRuntimeOptions {
  serviceId: string;
  target: DelegateDaemonTarget;
  /** Session namespace forwarded on every daemon call ("" = daemon default). */
  namespace: string;
  /** Durable, per-session routing history for sparse lifecycle hooks. */
  namespaceBindings: SessionNamespaceBindingStore;
  /** Mirrors the embedded `hooks.allowPromptInjection` policy. */
  allowPromptInjection: boolean;
  /** Passive slot mode skips memory hooks and capabilities. */
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
  /** Embedded parity: `openclawToolsEnabled !== false` registers the model-facing tools. */
  openclawToolsEnabled?: boolean;
  /** Embedded parity: `openclawToolSnippetMaxChars` caps each search result's text. */
  openclawToolSnippetMaxChars?: number;
  /**
   * Memory-slot capability inputs (issue #2120). The daemon-backed capability
   * gives delegate mode the same host surface as embedded: prompt builder,
   * memory runtime, flush plan, and public artifacts.
   */
  capability: {
    memoryDir: string;
    workspaceDir: string;
    agentIds: string[];
    extractionMaxTurnChars?: unknown;
    flushModel?: string;
    configuredSearchBackend: "qmd" | "builtin";
    configuredQmdCommand: string;
  };
  /** Injectable clock for capability-cache expiry tests and deterministic hosts. */
  now?: () => number;
  supportPassportModelRoute?: SupportPassportModelRoute;
}

export interface DelegateHookApi extends DelegateCapabilityApi {
  on(
    hook: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
    opts?: { timeoutMs?: number },
  ): void;
  // Method syntax (bivariant params) so the real OpenClaw api — whose
  // builder parameter is a wider SDK union — remains assignable.
  registerMemoryPromptSection?(builder: (params: { sessionKey?: string }) => string[] | null): void;
  registerTool?(tool: Record<string, unknown>, opts?: { name?: string }): void;
  registerService?(service: {
    id: string;
    start(): Promise<void>;
    stop(): Promise<void>;
  }): void;
}
const DELEGATE_BATCH_FLUSH_CACHE_TTL_MS = 30_000;
/**
 * The daemon caps request bodies (128 KiB by default), and a host may hand the
 * hook its whole assembled prompt. The current turn is at the END of such a
 * prompt, so the query keeps the tail.
 */
const MAX_RECALL_QUERY_CHARS = 1_500;
const delegatePassportServiceApiServices = new WeakMap<object, Set<string>>();

import {
  getJson,
  postJson,
  postJsonWithStatus,
  type DelegateJsonResponse,
} from "./delegate-http.js";

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

function lifecycleSessionKeyFrom(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | undefined {
  const fromEvent = event?.sessionKey;
  if (fromEvent !== undefined) {
    return typeof fromEvent === "string" && fromEvent.length > 0 ? fromEvent : undefined;
  }
  return sessionKeyFrom(event, ctx);
}

function recallQueryFrom(
  event: Record<string, unknown>,
  cleanUserMessage: (text: string) => string,
): string {
  // The current turn is `event.prompt`; `event.messages` is the transcript
  // BEFORE it, so its last user entry is only a fallback for a host that ships
  // no usable prompt (embedded parity: the 5-char floor).
  let prompt = typeof event.prompt === "string" ? cleanUserMessage(event.prompt).trim() : "";
  if (prompt.length < 5 && Array.isArray(event.messages)) {
    const msgs = event.messages as Array<Record<string, unknown>>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") {
        const text = extractTextContent(msgs[i] as Record<string, unknown>).trim();
        if (text.length >= 5) {
          prompt = text;
          break;
        }
      }
    }
  }
  return prompt.length > MAX_RECALL_QUERY_CHARS ? prompt.slice(-MAX_RECALL_QUERY_CHARS) : prompt;
}

/** Embedded parity: the workspace dir can arrive per hook (ctx/event), not
 * just at registration. Prefer the hook-scoped value; fall back to the
 * registration-time cwd. */
function cwdFrom(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  fallback: string | undefined,
): string | undefined {
  const runtime = ctx?.runtime as Record<string, unknown> | undefined;
  for (const candidate of [ctx?.workspaceDir, event?.workspaceDir, runtime?.workspaceDir]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return fallback;
}

function readRecallDegradation(candidate: object): RecallContextDegradation | undefined {
  if (!("degradation" in candidate)) return undefined;
  const value = candidate.degradation;
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.state !== "string" || typeof rec.reason !== "string") return undefined;
  return value as RecallContextDegradation;
}

function readContextComposition(
  response: Record<string, unknown>,
  fallbackContext: string,
): RecallContextComposition {
  const candidate = response.contextComposition;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("context" in candidate) ||
    typeof candidate.context !== "string"
  ) {
    return { context: fallbackContext };
  }
  const composition: RecallContextComposition = { context: candidate.context };
  if ("footer" in candidate && typeof candidate.footer === "string") {
    composition.footer = candidate.footer;
  }
  const degradation = readRecallDegradation(candidate);
  if (degradation) composition.degradation = degradation;
  return composition;
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
  const { target, namespace, namespaceBindings } = options;
  const now = options.now ?? Date.now;
  if (options.supportPassportModelRoute) {
    const registeredServices = delegatePassportServiceApiServices.get(api);
    if (registeredServices?.has(options.serviceId)) {
      log.debug(
        `delegate register: ${options.serviceId} already has its support passport model service on this api`,
      );
    } else if (typeof api.registerService !== "function") {
      log.error(
        `[${options.serviceId}] delegate support passport gateway routing is unavailable: host exposes no service registration surface`,
      );
    } else {
      api.registerService(
        createDelegateSupportPassportModelService({
          serviceId: options.serviceId,
          target,
          route: options.supportPassportModelRoute,
        }),
      );
      const services = registeredServices ?? new Set<string>();
      services.add(options.serviceId);
      if (registeredServices === undefined) {
        delegatePassportServiceApiServices.set(api, services);
      }
    }
  }

  // Session-scoped cache of precomputed recall lines, mirroring the embedded
  // pre-compute-then-consume contract: the recall hook fills it, the
  // synchronous section builder consumes (and evicts) it, and the capability's
  // prompt builder only peeks so the two cannot double-consume. Declared
  // outside the injection gate so the capability can be registered either way.
  const promptLinesBySession = new Map<string, string[]>();
  // Embedded zero-limit contract: recallBudgetChars === 0 disables injection.
  const promptInjectionEnabled = options.allowPromptInjection && options.recallBudgetChars !== 0;
  const useSectionBuilder = typeof api.registerMemoryPromptSection === "function";
  // Only a SECTION-builder host (registerMemoryPromptSection, OpenClaw 1.x)
  // gets the pre-compute-then-consume contract: its builder runs after this
  // hook and injects the cached lines. OpenClaw 2.0 removed that API — the
  // capability's synchronous promptBuilder is read during host prompt
  // assembly, which never runs this hook first (issue #3057), so cached lines
  // would never be consumed and a void return would inject nothing. On such
  // hosts the hook returns the injection itself.
  const cachePromptLines = useSectionBuilder;

  // Capability searches and explicit tool reads scope through the SAME
  // per-session binding history the hooks use (the non-explicit branch of
  // sessionNamespaceFrom): the host hands the runtime a sessionKey but no
  // event/ctx to read an explicit namespace from, so the remembered binding —
  // else the registration-wide fallback — is the correct scope.
  const resolveSearchNamespace = async (sessionKey: unknown): Promise<string | undefined> => {
    // A non-STRING key from the untyped host must not reach the binding
    // store: its `encodeURIComponent` would coerce `123` to `"123"` and the
    // search would inherit the binding of a distinct, string-keyed session —
    // another tenant's namespace whenever the delegate token can read both.
    // An unusable key falls back to the registration scope, never a guess.
    if (typeof sessionKey === "string" && sessionKey.trim().length > 0) {
      const remembered = await rememberedNamespacesFor(sessionKey, namespaceBindings);
      if (remembered.length > 0) return remembered.at(-1) || undefined;
    }
    return namespace.trim() || undefined;
  };
  // Passive (slot not owned) still serves the explicit tools, like embedded:
  // the capability is BUILT for their search manager and scope resolver but
  // never registered with the host, which keeps the memory slot untouched.
  const capabilityOptions: DelegateCapabilityOptions = {
    serviceId: options.serviceId,
    target,
    namespace,
    resolveSearchNamespace,
    // The daemon's own namespace-aware probe, so a substituted default is
    // proven usable before the first search rather than 403-ing on it.
    verifyNamespaceAuthorization: async (candidate, timeoutMs, operations) => {
      const probe = await probeDelegateAuthorization(
        target,
        candidate,
        // What the caller is about to do. A token that grants recall/observe/
        // flush but not memory_search must not have those rejected locally.
        (operations as readonly DelegateAuthorizationOperation[] | undefined) ??
          DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS,
        timeoutMs,
      );
      return probe.state === "unavailable" ? undefined : probe.state === "authorized";
    },
    memoryDir: options.capability.memoryDir,
    workspaceDir: options.capability.workspaceDir,
    agentIds: options.capability.agentIds,
    allowPromptInjection: promptInjectionEnabled,
    // Peek only. The section builder's own builder function owns eviction,
    // and on hosts without one (OpenClaw 2.0) the hook never caches — it
    // injects directly — so this can never double-inject behind the hook.
    readPromptLines: (sessionKey) => promptLinesBySession.get(sessionKey) ?? null,
    extractionMaxTurnChars: options.capability.extractionMaxTurnChars,
    flushModel: options.capability.flushModel,
    configuredSearchBackend: options.capability.configuredSearchBackend,
    configuredQmdCommand: options.capability.configuredQmdCommand,
    searchTimeoutMs: options.recallTimeoutMs,
    healthTimeoutMs: options.recallTimeoutMs,
    now: options.now,
  };
  const capability = options.passive
    ? createDelegateMemoryCapability(capabilityOptions)
    : registerDelegateMemoryCapability(api, capabilityOptions);
  registerDelegateTools(api, {
    target,
    serviceId: options.serviceId,
    enabled: options.openclawToolsEnabled !== false,
    passive: options.passive,
    runtime: capability.runtime,
    agentId: options.capability.agentIds[0] ?? "main",
    snippetMaxChars: options.openclawToolSnippetMaxChars,
    timeoutMs: options.recallTimeoutMs,
    resolveSearchNamespace,
    resolveScopedNamespace: capability.resolveScopedNamespace,
  });
  if (options.passive) {
    log.info(
      `[${options.serviceId}] bridge mode delegate: memory slot not owned — passive, no memory hooks registered`,
    );
    return;
  }
  // Detached observe POSTs, per session (see `agent_end`). A flush for the
  // same session waits behind them so a turn is buffered before it is flushed.
  const observeChains = new Map<string, Promise<void>>();
  /** Session -> the token owning its deferred flush (see the flush handler). */
  const followUpFlushSessions = new Map<string, object>();
  if (promptInjectionEnabled) {
    /**
     * Recall for one query on behalf of a session. `undefined` when nothing
     * injects: policy skip, short query, daemon failure, or empty context.
     */
    const recallContext = async (
      query: string,
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ): Promise<
      { prompt: string; lines: string[]; degradation?: RecallContextDegradation } | undefined
    > => {
      const sessionKey = sessionKeyFrom(event, ctx);
      // Evict BEFORE the short-query exit: a turn whose prompt construction
      // aborted leaves lines behind, and returning early without clearing
      // would inject the PREVIOUS query's memory into this prompt.
      if (cachePromptLines) promptLinesBySession.delete(sessionKey);
      if (query.length < 5) return undefined;
      // The host abandons this hook at `hookTimeoutMs`, so namespace
      // resolution and the recall POST share ONE deadline rather than each
      // taking its own full timeout and together overrunning it.
      const promptDeadline = Date.now() + Math.min(options.hookTimeoutMs, options.recallTimeoutMs);
      const promptRemaining = (): number => promptDeadline - Date.now();
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
          "main";
        if (await options.resolveSessionDisabled(sessionKey, agentId)) {
          log.debug(`delegate recall skipped: session toggle disables memory for ${sessionKey}`);
          return undefined;
        }
        const cwd = cwdFrom(event, ctx, options.cwd);
        const scopedNamespace = await sessionNamespaceFrom(
          sessionKey,
          event,
          ctx,
          namespace,
          namespaceBindings,
        );
        const response = await postJson(
          target,
          options.serviceId,
          "/engram/v1/recall",
          await withNamespace(
            scopedNamespace,
            {
              query,
              sessionKey,
              mode: "auto",
              ...(cwd ? { cwd } : {}),
              ...(options.projectTag ? { projectTag: options.projectTag } : {}),
            },
            // ONE deadline for the whole hook: health resolution followed by
            // a full-timeout recall could otherwise run past `hookTimeoutMs`
            // and have the host abandon it with nothing injected.
            (explicit) =>
              capability.resolveScopedNamespace(explicit, promptRemaining(), ["recall"]),
          ),
          Math.max(1, promptRemaining()),
        );
        const rawContext = response?.context;
        if (typeof rawContext !== "string" || rawContext.trim().length === 0) {
          return undefined;
        }
        const composition = readContextComposition(response ?? {}, rawContext);
        const rendered = renderMemoryContextPrompt({
          ...composition,
          maxChars: options.recallBudgetChars,
        });
        if (!rendered) return undefined;
        return {
          prompt: rendered.prompt,
          lines: rendered.lines,
          ...(composition.degradation ? { degradation: composition.degradation } : {}),
        };
      } catch (err) {
        log.warn(`delegate recall failed: ${String(err)}`);
        return undefined;
      }
    };
    const recallHandler = async (
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> => {
      const recalled = await recallContext(recallQueryFrom(event, options.cleanUserMessage), event, ctx);
      if (!recalled) return undefined;
      if (cachePromptLines) {
        // A registered section builder injects; the hook only pre-computes.
        // Returning injection fields here too would double-inject.
        promptLinesBySession.set(sessionKeyFrom(event, ctx), recalled.lines);
        return undefined;
      }
      return {
        prependSystemContext: recalled.prompt,
        ...(recalled.degradation ? { degradation: recalled.degradation } : {}),
      };
    };
    api.on(
      "before_prompt_build",
      (event, ctx) => recallHandler(event, ctx),
      { timeoutMs: options.hookTimeoutMs },
    );
    // No `registerMemoryPromptPreparation`: that OpenClaw 2.0 step runs BEFORE
    // `before_prompt_build` and is handed only session/agent ids — never the
    // `runtime.agent.session.namespace` this turn binds — so on a rebinding
    // turn it could only recall the PREVIOUS scope into the new one. The hook
    // above sees the binding and injects this turn's recall in scope.
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
      // Embedded parity: the 10-char noise gate applies to the RAW extracted
      // text BEFORE envelope cleaning (a short question in a long envelope
      // must survive; embedded gates pre-clean).
      .filter((message) => extractTextContent(message).length >= 10)
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
    const cwd = cwdFrom(event, ctx, options.cwd);
    let scopedNamespace: string | undefined;
    try {
      // Awaited: the binding store is local, and the session's namespace must
      // be durable before the next hook on this session reads it.
      scopedNamespace = await sessionNamespaceFrom(
        sessionKey,
        event,
        ctx,
        namespace,
        namespaceBindings,
      );
    } catch (err) {
      log.warn(`delegate observe failed: ${String(err)}`);
      return;
    }
    // The daemon call is DETACHED from the hook. A daemon that accepts the
    // connection and never answers would otherwise hold the host's agent_end
    // for the whole observe timeout on every turn; the turn capture is not
    // worth that, and its result feeds nothing the host waits for. Per-session
    // chaining keeps turns in order and lets a flush wait behind them. That
    // wait draws on the flush deadline, so an observe gets at most HALF of
    // it: the drain can always outwait the observe (nothing lands after the
    // session's final flush), and the flush keeps the other half for its own
    // requests rather than inheriting a ~1ms remainder from a slow observe.
    const observe = async (): Promise<void> => {
      const observeDeadline = Date.now() + Math.min(options.observeTimeoutMs, options.flushTimeoutMs / 2);
      const observeRemaining = (): number => observeDeadline - Date.now();
      try {
        await postJson(
          target,
          options.serviceId,
          "/engram/v1/observe",
          await withNamespace(
            scopedNamespace,
            {
              sessionKey,
              messages: turn,
              ...(cwd ? { cwd } : {}),
              ...(options.projectTag ? { projectTag: options.projectTag } : {}),
            },
            (explicit) =>
              capability.resolveScopedNamespace(explicit, observeRemaining(), ["observe"]),
          ),
          Math.max(1, observeRemaining()),
        );
      } catch (err) {
        log.warn(`delegate observe failed: ${String(err)}`);
      }
    };
    const chained = (observeChains.get(sessionKey) ?? Promise.resolve()).then(observe);
    observeChains.set(sessionKey, chained);
    void chained.then(() => {
      if (observeChains.get(sessionKey) === chained) observeChains.delete(sessionKey);
    });
  });

  let cachedBatchFlushSupport: boolean | undefined;
  let cachedBatchFlushSupportExpiresAt = 0;
  let supportsBatchFlushPromise: Promise<boolean> | undefined;
  const invalidateCachedBatchFlushSupport = (): void => {
    cachedBatchFlushSupport = undefined;
    cachedBatchFlushSupportExpiresAt = 0;
  };
  const cacheBatchFlushSupport = (supported: boolean): void => {
    cachedBatchFlushSupport = supported;
    cachedBatchFlushSupportExpiresAt = now() + DELEGATE_BATCH_FLUSH_CACHE_TTL_MS;
  };
  const supportsBatchFlush = (timeoutMs: number): Promise<boolean> => {
    if (cachedBatchFlushSupport !== undefined) {
      if (now() < cachedBatchFlushSupportExpiresAt) {
        return Promise.resolve(cachedBatchFlushSupport);
      }
      invalidateCachedBatchFlushSupport();
    }
    if (supportsBatchFlushPromise !== undefined) return supportsBatchFlushPromise;
    const probe = getJson(
      target,
      options.serviceId,
      "/engram/v1/capabilities",
      timeoutMs,
    )
      .then((response) => {
        const isSuccessfulResponse = response.status >= 200 && response.status < 300;
        if (isSuccessfulResponse && response.body !== null) {
          const batchFlushSupport = response.body.lcmCompactionFlushBatch;
          if (typeof batchFlushSupport === "boolean") {
            cacheBatchFlushSupport(batchFlushSupport);
            return batchFlushSupport;
          }
          return false;
        }
        if (
          response.status === 204 ||
          response.status === 404 ||
          response.status === 405 ||
          response.status === 501
        ) {
          cacheBatchFlushSupport(false);
        }
        return false;
      })
      .catch(() => false);
    supportsBatchFlushPromise = probe.finally(() => {
      supportsBatchFlushPromise = undefined;
    });
    return supportsBatchFlushPromise;
  };
  const flushHandler = async (
    event: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const deadline = Date.now() + options.flushTimeoutMs;
      // The floor of 1 keeps a doomed POST from being sent with a zero timeout
      // (which some clients read as "no timeout"), but it must not disguise a
      // spent deadline from callers that can legitimately SKIP work.
      const remainingTimeout = (): number => Math.max(1, deadline - Date.now());
      const remainingBudget = (): number => deadline - Date.now();
      const sessionKey = lifecycleSessionKeyFrom(event, ctx);
      if (sessionKey === undefined) {
        log.warn("delegate flush skipped: lifecycle event has malformed session key");
        return false;
      }
      // The session's last turns may still be on their way to the daemon
      // (`agent_end` detaches the observe POST). Flushing ahead of them leaves
      // them buffered, but the drain cannot spend more than half the lifecycle
      // budget or the flush has nothing left — so when the QUEUE outlasts the
      // drain, this flush proceeds and a follow-up is chained behind it.
      const pendingObserve = observeChains.get(sessionKey);
      if (pendingObserve !== undefined) {
        const drainDeadline = Promise.withResolvers<void>();
        const timer = setTimeout(drainDeadline.resolve, Math.max(0, Math.min(remainingBudget(), options.flushTimeoutMs / 2)));
        timer.unref?.();
        const drained = await Promise.race([
          pendingObserve.then(() => true),
          drainDeadline.promise.then(() => false),
        ]);
        clearTimeout(timer);
        // One follow-up per session, draining the whole queue — the ended
        // generation's late turns AND anything observed after the hook
        // returned, since the daemon buffers per session and abandoning the
        // follow-up would strand the ended generation until a later lifecycle
        // event that may never come. Flushing a newer turn early is safe;
        // losing an ended session's turns is not. It flushes off a
        // scope-neutral event, so namespaces come from the session's bindings
        // rather than this event's captured (possibly superseded) metadata.
        if (!drained && !followUpFlushSessions.has(sessionKey)) {
          // Ownership is a TOKEN, not mere presence: this follow-up releases
          // the marker before its flush (below), that flush can install a
          // successor, and an unconditional clear afterwards would let the next
          // lifecycle event stack a second, overlapping drain on the session.
          const followUp = {};
          followUpFlushSessions.set(sessionKey, followUp);
          const releaseIfOwner = (): void => {
            if (followUpFlushSessions.get(sessionKey) === followUp) {
              followUpFlushSessions.delete(sessionKey);
            }
          };
          void pendingObserve
            .then(async () => {
              // ponytail: 8 rounds is the ceiling on ONE follow-up — a session
              // observing turns faster than they drain must not hold this
              // callback open forever.
              for (let round = 0; round < 8; round += 1) {
                const queued = observeChains.get(sessionKey);
                if (queued === undefined) break;
                await queued;
              }
              // Released BEFORE the flush: when the queue outlasted those
              // rounds, that flush's own drain must be free to chain the NEXT
              // follow-up, or the remainder stays buffered past `session_end`.
              // Each successor pays a full drain window, so a busy session is
              // rate-limited rather than spun on.
              releaseIfOwner();
              return flushHandler({ sessionKey }, {});
            })
            .catch((err: unknown) => log.warn(`delegate follow-up flush failed: ${String(err)}`))
            .finally(releaseIfOwner);
        }
      }
      const namespaces = await lifecycleSessionNamespacesFrom(
        sessionKey,
        event,
        ctx,
        namespace,
        namespaceBindings,
      );
      // BEFORE the transcript flush, so the host's durable notes and the
      // transcript reach the daemon in the order they were produced. A failure
      // here must not abort the flush that follows.
      try {
        await ingestFlushPlanNotes({
          target,
          serviceId: options.serviceId,
          workspaceDir: cwdFrom(event, ctx, options.capability.workspaceDir),
          sessionKey,
          // The session's CURRENT binding, which is the last entry of the
          // ordered history — `namespaces[0]` is where it started, so a
          // rebound session would file new notes under the previous tenant.
          namespace: namespaces.at(-1),
          // Re-read per chunk, not captured once: several posts must share
          // the flush's remaining budget rather than each taking it whole.
          remainingTimeoutMs: remainingBudget,
        });
      } catch (err) {
        log.warn(`delegate flush-plan ingestion failed: ${String(err)}`);
      }
      const flushNamespace = async (sessionNamespace: string | undefined) =>
        postJson(
          target,
          options.serviceId,
          "/engram/v1/lcm/compaction/flush",
          await withNamespace(sessionNamespace, { sessionKey }, (explicit) =>
            // Inside the flush's SHARED deadline: a health probe started here
            // with its own full timeout would overrun the hook.
            capability.resolveScopedNamespace(explicit, remainingBudget(), [
              "lcm_compaction_flush",
            ]),
          ),
          remainingTimeout(),
        );
      const flushIndividually = async (): Promise<boolean> => {
        const outcomes = await Promise.allSettled(namespaces.map(flushNamespace));
        return outcomes.every(
          (outcome) =>
            outcome.status === "fulfilled" &&
            outcome.value !== null &&
            outcome.value.flushed === true,
        );
      };
      if (namespaces.length <= 1 || (await supportsBatchFlush(remainingTimeout()))) {
        if (namespaces.length <= 1) {
          const response = await flushNamespace(namespaces[0]);
          return response !== null && response.flushed === true;
        }
        // Each entry goes through the SAME resolver as the singular flush and
        // every other delegate call, so a batch cannot widen scope where a
        // one-at-a-time flush would refuse. The RESOLVED list is what the
        // daemon echoes, so it is also what the response is validated against.
        const requestNamespaces = await Promise.all(
          namespaces.map(async (sessionNamespace) =>
            (await capability.resolveScopedNamespace(sessionNamespace || undefined, remainingBudget(), [
              "lcm_compaction_flush",
            ])) ?? "",
          ),
        );
        try {
          const response = await postJson(
            target,
            options.serviceId,
            "/engram/v1/lcm/compaction/flush",
            { sessionKey, namespaces: requestNamespaces },
            remainingTimeout(),
          );
          if (response === null) {
            invalidateCachedBatchFlushSupport();
            return flushIndividually();
          }
          const responseNamespaces = response.namespaces;
          const responseResults = response.results;
          const isBatchResponse =
            Array.isArray(responseNamespaces) &&
            Array.isArray(responseResults) &&
            responseNamespaces.length === requestNamespaces.length &&
            responseNamespaces.every(
              (responseNamespace, index) => responseNamespace === requestNamespaces[index],
            ) &&
            responseResults.length === requestNamespaces.length;
          if (!isBatchResponse) {
            invalidateCachedBatchFlushSupport();
            return flushIndividually();
          }
          if (response.flushed !== true) {
            invalidateCachedBatchFlushSupport();
            return false;
          }
          return true;
        } catch {
          invalidateCachedBatchFlushSupport();
          return flushIndividually();
        }
      }
      return flushIndividually();
    } catch (err) {
      log.warn(`delegate flush failed: ${String(err)}`);
      return false;
    }

  };
  api.on("before_compaction", flushHandler);
  if (options.flushOnResetEnabled) {
    const flushEndedSession = async (
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ): Promise<boolean> => flushHandler(event, ctx);
    api.on("before_reset", flushEndedSession);
    api.on("session_end", flushEndedSession);
  }

  log.info(
    `[${options.serviceId}] bridge mode delegate: memory loop backed by daemon at ` +
      `${target.host}:${target.port} (embedded orchestrator skipped; tools/CLI stay daemon-side)`,
  );
}

export interface MaybeRegisterDelegateOptions {
  serviceId: string;
  /** The parsed plugin config's `bridgeMode` value. */
  configBridgeMode: string;
  /** Raw total timeout for liveness and older-daemon health fallback. */
  bridgeHealthTimeoutMs?: unknown;
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
  /** Embedded parity: `openclawToolsEnabled !== false` registers the model-facing tools. */
  openclawToolsEnabled?: boolean;
  /** Embedded parity: `openclawToolSnippetMaxChars` caps each search result's text. */
  openclawToolSnippetMaxChars?: number;
  /**
   * Memory-slot capability inputs (issue #2120) — forwarded verbatim to the
   * daemon-backed capability so delegate mode keeps the host surface embedded
   * mode provides.
   */
  capability: DelegateRuntimeOptions["capability"];
  supportPassportModelRoute?: SupportPassportModelRoute;
}

function activeDelegateAuthorizationOperations(
  options: MaybeRegisterDelegateOptions,
): readonly DelegateAuthorizationOperation[] {
  // `recall` is exercised only when prompt injection is on; observe, flush,
  // and the capability's memory_search always are. Filter by name rather than
  // slicing so reordering the list cannot silently drop the wrong operation.
  return options.allowPromptInjection && options.recallBudgetChars !== 0
    ? DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS
    : DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS.filter((operation) => operation !== "recall");
}
// Mirrors the embedded runtime's per-api hook dedup (globalThis HOOK_APIS
// WeakSet), scoped per serviceId: a migration install can register BOTH the
// canonical and legacy plugin ids against the same api object, and each
// service must get its own binding exactly once (double-register of one
// service would double-fire every handler).
const delegateHookApiServices = new WeakMap<object, Set<string>>();
// Service registration can span distinct OpenClaw api objects. Keep the active
// service IDs process-scoped so migration callbacks see sibling registrations.
const delegateActiveServiceIds = new Set<string>();
// Apis that previously fell back to embedded because the daemon was down. A
// later register() on the SAME api must NOT switch to delegate — the embedded
// hooks from the fallback are still bound (OpenClaw exposes no unregister), so
// switching would stack both memory paths (double recall/observe/flush).
const delegateEmbeddedFallbackApis = new WeakSet<object>();
/**
 * Apis where SOME service has bound delegate hooks. The canonical and legacy
 * plugin IDs register separately against one api, and those hooks serve every
 * session on it — so once delegate is established the sibling must reuse it
 * rather than bind an embedded runtime alongside.
 */
const delegateBoundApis = new WeakSet<object>();
const delegateAuthorizationPreflightServices = new WeakMap<object, Set<string>>();

/**
 * Resolve bridge mode, preflight the daemon, and register the delegate
 * runtime. Returns true when delegate mode handled registration (the caller
 * must skip the embedded runtime), false when the caller should proceed
 * embedded — either because delegate was not requested or because the
 * requested daemon failed its preflight (logged loudly).
 */
export interface MaybeRegisterDelegateDeps {
  /** Injectable liveness preflight — defaults to the bridge's worker-backed sync probe. */
  checkHealth: (host: string, port: number, timeoutMs: number) => boolean;
  /** Injectable authorization preflight for standalone daemon compatibility. */
  probeAuthorization?: (
    target: DelegateDaemonTarget,
    namespace: string,
    operations: readonly DelegateAuthorizationOperation[],
  ) => Promise<DelegateAuthorizationPreflight>;
}

export function maybeRegisterDelegateRuntime(
  api: DelegateHookApi,
  options: MaybeRegisterDelegateOptions,
  deps: MaybeRegisterDelegateDeps = { checkHealth: checkDaemonHealthSync },
): boolean {
  // BEFORE any health-dependent resolution: if this service already has
  // delegate hooks on this api, they are still attached (OpenClaw exposes no
  // unregister). Re-probing could resolve `embedded` on a transient daemon
  // failure, and returning false would then stack embedded hooks on top of
  // the live delegate ones — two memory paths over one corpus.
  const boundServices = delegateHookApiServices.get(api);
  if (boundServices?.has(options.serviceId)) {
    log.debug(
      `delegate register: ${options.serviceId} already has hooks bound on this api — skipping duplicate registration`,
    );
    return true;
  }
  // BEFORE any health-dependent resolution. The result is already irrevocably
  // embedded on this api, so running `auto`'s synchronous endpoint walk first
  // would let a stalling endpoint block every reload and sibling registration
  // for the full configured timeout to reach a foregone conclusion.
  if (delegateEmbeddedFallbackApis.has(api)) {
    log.debug(
      `delegate register: ${options.serviceId} previously fell back to embedded on this api — staying embedded to avoid stacking memory paths`,
    );
    return false;
  }
  let bridge: BridgeConfig;
  let bridgeHealthTimeoutMs: number;
  try {
    // Parsed BEFORE mode resolution: `auto` probes the daemon inside
    // resolveBridgeMode and must honor the configured timeout.
    bridgeHealthTimeoutMs = parseOpenClawBridgeConfig({
      bridgeHealthTimeoutMs: options.bridgeHealthTimeoutMs,
    }).healthTimeoutMs;
    bridge = resolveBridgeMode(options.configBridgeMode, {
      memoryDir: options.memoryDir,
      timeoutMs: bridgeHealthTimeoutMs,
      onSkip: (reason) =>
        log.info(`[${options.serviceId}] bridge mode auto: staying embedded — ${reason}`),
    });
  } catch (err) {
    // An invalid bridgeMode or health timeout (config typo or bad env
    // override) must not abort the whole plugin registration — reject LOUDLY,
    // then run embedded so the deployment keeps its memory loop (AGENTS.md §4:
    // side effects must not crash the main flow).
    //
    const wantedDelegate = requestedDelegate(options.configBridgeMode);
    log.error(
      wantedDelegate
        ? `${String(err)} — falling back to the embedded runtime`
        : `${String(err)} — the deployment is embedded, so this only affects delegate mode`,
    );
    // Returning `false` has the caller bind the embedded runtime on this api,
    // and OpenClaw exposes no unregister — so the api is irrevocably embedded
    // whatever the deployment MEANT. Recording that is what stops a later
    // register() (value corrected, or bridgeMode flipped to delegate) from
    // adding delegate hooks beside the ones already attached and running two
    // memory paths over one corpus. A PASSIVE registration binds nothing, so
    // it has nothing to record — the same rule the healthy-embedded path
    // below already follows.
    if (!options.passive) delegateEmbeddedFallbackApis.add(api);
    return false;
  }
  if (bridge.mode !== "delegate") {
    // A SIBLING service (canonical + legacy plugin IDs register separately
    // against one api) may already have delegate hooks bound here, and those
    // serve every session on it. Reporting embedded now would have the caller
    // bind an embedded runtime BESIDE them — two memory paths over one corpus,
    // the exact failure this mode prevents. A transient probe failure for the
    // second service must not undo the first service's established mode, so
    // the api is reported handled and nothing new is bound.
    if (delegateBoundApis.has(api)) {
      log.warn(
        `[${options.serviceId}] bridge mode resolved embedded, but a sibling service already bound delegate hooks on this api — reusing them instead of stacking an embedded runtime`,
      );
      return true;
    }
    // The caller will bind embedded hooks on this api (unless passive, which
    // binds nothing and must not poison a later delegate registration).
    // Record active registers so a later reload that flips to delegate on the
    // SAME api stays embedded instead of stacking both memory paths.
    //
    // This is deliberate for `auto` too. Once embedded hooks are bound there is
    // no way to take them off — OpenClaw exposes no unregister — so adopting
    // delegate on a later register() of the same api would run BOTH memory
    // paths over one corpus, which is the exact failure this whole mode exists
    // to prevent. Picking up a daemon that appeared after startup therefore
    // needs a gateway restart, and the log says so rather than leaving an
    // operator wondering why `auto` never switched.
    if (!options.passive) {
      delegateEmbeddedFallbackApis.add(api);
      if (resolveRequestedBridgeMode(options.configBridgeMode) === "auto") {
        log.info(
          `[${options.serviceId}] bridge mode auto: embedded hooks are bound on this api — ` +
            `a daemon that starts later is picked up on the next gateway restart`,
        );
      }
    }
    return false;
  }
  // register() is synchronous, so the preflight uses the bridge's
  // worker-backed sync health check. `auto` already proved the daemon healthy
  // as part of its corpus-identity probe, so re-checking would let one
  // registration spend twice `bridgeHealthTimeoutMs` — which the config
  // documents as the TOTAL preflight budget. Only the explicit `delegate`
  // path, which has probed nothing yet, pays for the liveness request.
  if (!bridge.healthVerified) {
    // The configured interface address is tried only after loopback refuses:
    // a daemon bound to exactly that address answers no loopback dial.
    const hosts =
      bridge.daemonHostFallback === undefined
        ? [bridge.daemonHost]
        : [bridge.daemonHost, bridge.daemonHostFallback];
    // ONE preflight budget across both dials, as the auto walk already does:
    // a loopback that accepts and stalls must not let the fallback spend the
    // documented total again.
    const preflightDeadline = Date.now() + bridgeHealthTimeoutMs;
    const healthyHost = hosts.find((host, index) => {
      const remaining = index === 0 ? bridgeHealthTimeoutMs : preflightDeadline - Date.now();
      return remaining > 0 && deps.checkHealth(host, bridge.daemonPort, remaining);
    });
    if (healthyHost !== undefined && healthyHost !== bridge.daemonHost) {
      log.info(
        `[${options.serviceId}] bridge mode delegate: loopback refused, dialing the configured address ${healthyHost}`,
      );
      bridge = { ...bridge, daemonHost: healthyHost };
    }
    if (healthyHost === undefined) {
      // Same sibling rule as the embedded-resolution branch: when delegate hooks
      // are already bound on this api by the canonical/legacy counterpart, a
      // transient probe failure here must not hand the caller an embedded
      // runtime to stack beside them.
      if (delegateBoundApis.has(api)) {
        log.warn(
          `[${options.serviceId}] no healthy daemon at ${hosts.join("/")}:${bridge.daemonPort}, ` +
            `but a sibling service already bound delegate hooks on this api — reusing them instead of stacking an embedded runtime`,
        );
        return true;
      }
      // Record the fallback so a later register() on the same api does not switch
      // to delegate and stack memory paths on top of the embedded hooks just bound.
      delegateEmbeddedFallbackApis.add(api);
      log.error(
        `bridge mode delegate requested but no healthy daemon at ` +
          `${hosts.join("/")}:${bridge.daemonPort} — falling back to the embedded runtime`,
      );
      return false;
    }
  }
  // Passive mode attaches no hooks — recording it as bound would make a later
  // ACTIVE register() on the same api skip both delegate and embedded paths.
  if (!options.passive) {
    (boundServices ?? delegateHookApiServices.set(api, new Set()).get(api))?.add(
      options.serviceId,
    );
    delegateActiveServiceIds.add(options.serviceId);
    // Delegate is now the api's established mode, so a sibling service
    // registering later reuses these hooks instead of binding embedded ones
    // beside them. Passive registrations bind nothing and must not claim it.
    delegateBoundApis.add(api);
  }
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
  const target = daemonTargetFor(bridge);
  registerDelegateRuntime(api, {
    serviceId: options.serviceId,
    target,
    namespace: "",
    namespaceBindings: createDelegateNamespaceBindingStore(
      options.memoryDir,
      options.serviceId,
      () => delegateActiveServiceIds.has(REMNIC_OPENCLAW_LEGACY_PLUGIN_ID),
    ),
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
    openclawToolsEnabled: options.openclawToolsEnabled,
    openclawToolSnippetMaxChars: options.openclawToolSnippetMaxChars,
    capability: options.capability,
    recallTimeoutMs: 25_000,
    observeTimeoutMs: 120_000,
    flushTimeoutMs: 55_000,
    supportPassportModelRoute: options.supportPassportModelRoute,
  });
  let preflightServices = delegateAuthorizationPreflightServices.get(api);
  if (!options.passive && !preflightServices?.has(options.serviceId)) {
    if (!preflightServices) {
      preflightServices = new Set<string>();
      delegateAuthorizationPreflightServices.set(api, preflightServices);
    }
    preflightServices.add(options.serviceId);
    const operations = activeDelegateAuthorizationOperations(options);
    const probe = deps.probeAuthorization ?? probeDelegateAuthorization;
    const operationLabel = operations.join("/");
    void probe(target, "", operations)
      .then((result) => {
        if (result.state === "authorized") return;
        if (result.state === "unauthorized") {
          log.warn(
            `delegate authorization preflight rejected ${operationLabel} (${result.status}; token source: ${result.tokenSource}) — runtime remains active`,
          );
          return;
        }
        log.warn(
          `delegate authorization preflight could not verify ${operationLabel} (token source: ${result.tokenSource}) — runtime remains active`,
        );
      })
      .catch(() => {
        log.warn("delegate authorization preflight could not complete — runtime remains active");
      });
  }
  return true;
}
