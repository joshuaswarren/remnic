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

import path from "node:path";
import {
  type RecallContextComposition,
  renderMemoryContextPrompt,
} from "@remnic/core";
import { log } from "@remnic/core/logger";
import {
  type SessionNamespaceBindingStore,
  createFileSessionNamespaceBindingStore,
} from "@remnic/core/session-namespace-bindings";
import { createFileToggleStore } from "@remnic/core/session-toggles";
import {
  checkDaemonHealthSync,
  loadDaemonAuth,
  resolveBridgeMode,
  type DaemonAuthToken,
} from "./bridge.js";
import {
  REMNIC_OPENCLAW_LEGACY_PLUGIN_ID,
  REMNIC_OPENCLAW_PLUGIN_ID,
} from "./plugin-id.js";
import {
  extractLastTurn,
  extractTextContent,
} from "./transcript-turns.js";

export interface DelegateDaemonTarget {
  host: string;
  port: number;
  resolveAuthToken: () => DaemonAuthToken;
}

export interface DelegateRuntimeOptions {
  serviceId: string;
  target: DelegateDaemonTarget;
  /** Session namespace forwarded on every daemon call ("" = daemon default). */
  namespace: string;
  /** Durable, per-session routing history for sparse lifecycle hooks. */
  namespaceBindings: SessionNamespaceBindingStore;
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
const DELEGATE_NAMESPACE_MAX_LENGTH = 256;

const DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS = [
  "recall",
  "observe",
  "lcm_compaction_flush",
] as const;

type DelegateAuthorizationOperation = (typeof DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS)[number];

export interface DelegateAuthorizationPreflight {
  readonly state: "authorized" | "unauthorized" | "unavailable";
  readonly tokenSource: DaemonAuthToken["source"];
  readonly status?: 401 | 403;
}

function daemonUrl(target: DelegateDaemonTarget, pathname: string): string {
  const host = target.host.includes(":") && !target.host.startsWith("[")
    ? `[${target.host}]`
    : target.host;
  return `http://${host}:${target.port}${pathname}`;
}

const daemonAuthFailureLogKeys = new Set<string>();

function reportDaemonAuthorizationFailure(
  serviceId: string,
  pathname: string,
  status: 401 | 403,
  tokenSource: DaemonAuthToken["source"],
): void {
  const key = `${serviceId}:${pathname}:${status}:${tokenSource}`;
  if (daemonAuthFailureLogKeys.has(key)) return;
  daemonAuthFailureLogKeys.add(key);
  log.error(
    `delegate ${pathname} authorization failed (${status}; token source: ${tokenSource})`,
  );
}

export async function probeDelegateAuthorization(
  target: DelegateDaemonTarget,
  namespace = "",
  operations: readonly DelegateAuthorizationOperation[] = DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS,
): Promise<DelegateAuthorizationPreflight> {
  const auth = target.resolveAuthToken();
  const headers = auth.token ? { Authorization: `Bearer ${auth.token}` } : undefined;
  const query = new URLSearchParams();
  for (const operation of operations) query.append("op", operation);
  query.set("namespace", namespace);
  try {
    const response = await fetch(daemonUrl(target, `/engram/v1/authorization?${query}`), {
      headers,
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
    if (response.status === 200) {
      return { state: "authorized", tokenSource: auth.source };
    }
    if (response.status === 401 || response.status === 403) {
      return { state: "unauthorized", status: response.status, tokenSource: auth.source };
    }
  } catch {
    return { state: "unavailable", tokenSource: auth.source };
  }
  return { state: "unavailable", tokenSource: auth.source };
}
async function postJson(
  target: DelegateDaemonTarget,
  serviceId: string,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = target.resolveAuthToken();
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(daemonUrl(target, pathname), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const status = res.status === 401 ? 401 : 403;
      await res.body?.cancel();
      reportDaemonAuthorizationFailure(serviceId, pathname, status, auth.source);
      return null;
    }
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

function withNamespace(
  namespace: string | undefined,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return namespace ? { ...body, namespace } : body;
}

interface ExplicitSessionNamespace {
  namespace: string | undefined;
}

function explicitSessionNamespaceFrom(
  sessionKey: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): ExplicitSessionNamespace | undefined {
  const eventSessionKey = typeof event.sessionKey === "string" ? event.sessionKey : undefined;
  const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
  const sources =
    eventSessionKey === sessionKey
      ? [event, ctx]
      : ctxSessionKey === sessionKey
        ? [ctx, event]
        : [ctx, event];
  for (const source of sources) {
    const sourceSessionKey = typeof source.sessionKey === "string" ? source.sessionKey : undefined;
    if (sourceSessionKey !== sessionKey) continue;
    const runtime = source.runtime;
    if (typeof runtime !== "object" || runtime === null) continue;
    const agent = (runtime as Record<string, unknown>).agent;
    if (typeof agent !== "object" || agent === null) continue;
    const session = (agent as Record<string, unknown>).session;
    if (typeof session !== "object" || session === null) continue;
    const namespace = (session as Record<string, unknown>).namespace;
    if (namespace !== undefined && typeof namespace !== "string") {
      throw new Error("delegate session namespace metadata must be a string");
    }
    return { namespace: typeof namespace === "string" ? namespace.trim() || undefined : undefined };
  }
  return undefined;
}

async function rememberedNamespacesFor(
  sessionKey: string,
  namespaceBindings: SessionNamespaceBindingStore,
): Promise<string[]> {
  return namespaceBindings.namespacesFor(sessionKey);
}

async function rememberNamespace(
  sessionKey: string,
  namespace: string,
  namespaceBindings: SessionNamespaceBindingStore,
): Promise<void> {
  if (namespace.length > DELEGATE_NAMESPACE_MAX_LENGTH) {
    throw new Error(
      `delegate session namespace exceeds the daemon limit of ${DELEGATE_NAMESPACE_MAX_LENGTH} characters`,
    );
  }
  try {
    await namespaceBindings.remember(sessionKey, namespace);
  } catch (err) {
    log.warn(`delegate namespace binding persistence failed: ${String(err)}`);
  }
}

async function sessionNamespaceFrom(
  sessionKey: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  fallback: string,
  namespaceBindings: SessionNamespaceBindingStore,
): Promise<string | undefined> {
  const explicit = explicitSessionNamespaceFrom(sessionKey, event, ctx);
  if (explicit !== undefined) {
    await rememberNamespace(sessionKey, explicit.namespace ?? "", namespaceBindings);
    return explicit.namespace;
  }
  const remembered = await rememberedNamespacesFor(sessionKey, namespaceBindings);
  return remembered.length > 0 ? remembered.at(-1) || undefined : fallback.trim() || undefined;
}

async function lifecycleSessionNamespacesFrom(
  sessionKey: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  fallback: string,
  namespaceBindings: SessionNamespaceBindingStore,
): Promise<Array<string | undefined>> {
  const explicit = explicitSessionNamespaceFrom(sessionKey, event, ctx);
  if (explicit !== undefined) {
    await rememberNamespace(sessionKey, explicit.namespace ?? "", namespaceBindings);
  }
  const remembered = await rememberedNamespacesFor(sessionKey, namespaceBindings);
  if (explicit !== undefined) {
    const explicitNamespace = explicit.namespace ?? "";
    const namespaces = remembered.includes(explicitNamespace)
      ? remembered
      : [...remembered, explicitNamespace];
    return namespaces.map((namespace) => namespace || undefined);
  }
  if (remembered.length > 0) return remembered.map((namespace) => namespace || undefined);
  return [fallback.trim() || undefined];
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
  if ("footer" in candidate && typeof candidate.footer === "string") {
    return { context: candidate.context, footer: candidate.footer };
  }
  return { context: candidate.context };
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
      hook: "before_prompt_build" | "before_agent_start",
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
          withNamespace(scopedNamespace, {
            query,
            sessionKey,
            mode: "auto",
            ...(cwd ? { cwd } : {}),
            ...(options.projectTag ? { projectTag: options.projectTag } : {}),
          }),
          options.recallTimeoutMs,
        );
        const rawContext = response?.context;
        if (typeof rawContext !== "string" || rawContext.trim().length === 0) {
          return undefined;
        }
        const rendered = renderMemoryContextPrompt({
          ...readContextComposition(response ?? {}, rawContext),
          maxChars: options.recallBudgetChars,
        });
        if (!rendered) return undefined;
        const prompt = rendered.prompt;
        if (useSectionBuilder) {
          // Section-builder hosts inject through the registered builder; the
          // hook only pre-computes. Returning injection fields here too would
          // double-inject.
          promptLinesBySession.set(sessionKey, rendered.lines);
          return undefined;
        }
        // Embedded parity: before_prompt_build consumes ONLY
        // prependSystemContext (returning both keys could double-inject on
        // hosts that honor both); the legacy before_agent_start path returns
        // the dual-field shape.
        return hook === "before_prompt_build"
          ? { prependSystemContext: prompt }
          : { prependSystemContext: prompt, prependContext: prompt };
      } catch (err) {
        log.warn(`delegate recall failed: ${String(err)}`);
        return undefined;
      }
    };
    // Register on the modern hook AND the legacy hook: gateways emit one or
    // the other, never both, so dual registration cannot double-inject.
    api.on(
      "before_prompt_build",
      (event, ctx) => recallHandler("before_prompt_build", event, ctx),
      { timeoutMs: options.hookTimeoutMs },
    );
    api.on(
      "before_agent_start",
      (event, ctx) => recallHandler("before_agent_start", event, ctx),
      { timeoutMs: options.hookTimeoutMs },
    );
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
    try {
      const cwd = cwdFrom(event, ctx, options.cwd);
      const scopedNamespace = await sessionNamespaceFrom(
        sessionKey,
        event,
        ctx,
        namespace,
        namespaceBindings,
      );
      await postJson(
        target,
        options.serviceId,
        "/engram/v1/observe",
        withNamespace(scopedNamespace, {
          sessionKey,
          messages: turn,
          ...(cwd ? { cwd } : {}),
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
  ): Promise<boolean> => {
    try {
      const sessionKey = lifecycleSessionKeyFrom(event, ctx);
      if (sessionKey === undefined) {
        log.warn("delegate flush skipped: lifecycle event has malformed session key");
        return false;
      }
      const namespaces = await lifecycleSessionNamespacesFrom(
        sessionKey,
        event,
        ctx,
        namespace,
        namespaceBindings,
      );
      const response = await postJson(
        target,
        options.serviceId,
        "/engram/v1/lcm/compaction/flush",
        namespaces.length > 1
          ? {
              sessionKey,
              namespaces: namespaces.map((sessionNamespace) => sessionNamespace ?? ""),
            }
          : withNamespace(namespaces[0], { sessionKey }),
        options.flushTimeoutMs,
      );
      return response?.flushed !== false;
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
    ): Promise<void> => {
      await flushHandler(event, ctx);
    };
    api.on("before_reset", flushEndedSession);
    api.on("session_end", flushEndedSession);
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

function activeDelegateAuthorizationOperations(
  options: MaybeRegisterDelegateOptions,
): readonly DelegateAuthorizationOperation[] {
  return options.allowPromptInjection && options.recallBudgetChars !== 0
    ? DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS
    : DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS.slice(1);
}
function createDelegateNamespaceBindingStore(
  memoryDir: string,
  serviceId: string,
): SessionNamespaceBindingStore {
  const bindingPath = (pluginId: string): string =>
    path.join(memoryDir, "state", "plugins", pluginId, "session-namespace-bindings.json");
  const primary = createFileSessionNamespaceBindingStore(bindingPath(serviceId));
  if (serviceId !== REMNIC_OPENCLAW_PLUGIN_ID) return primary;

  const legacy = createFileSessionNamespaceBindingStore(
    bindingPath(REMNIC_OPENCLAW_LEGACY_PLUGIN_ID),
  );
  return {
    async namespacesFor(sessionKey: string): Promise<string[]> {
      const current = await primary.namespacesFor(sessionKey);
      return current.length > 0 ? current : legacy.namespacesFor(sessionKey);
    },
    async remember(sessionKey: string, namespace: string): Promise<void> {
      const current = await primary.namespacesFor(sessionKey);
      if (current.length === 0) {
        const previous = await legacy.namespacesFor(sessionKey);
        for (const remembered of previous) {
          await primary.remember(sessionKey, remembered);
        }
      }
      await primary.remember(sessionKey, namespace);
    },
  };
}

// Mirrors the embedded runtime's per-api hook dedup (globalThis HOOK_APIS
// WeakSet), scoped per serviceId: a migration install can register BOTH the
// canonical and legacy plugin ids against the same api object, and each
// service must get its own binding exactly once (double-register of one
// service would double-fire every handler).
const delegateHookApiServices = new WeakMap<object, Set<string>>();
// Apis that previously fell back to embedded because the daemon was down. A
// later register() on the SAME api must NOT switch to delegate — the embedded
// hooks from the fallback are still bound (OpenClaw exposes no unregister), so
// switching would stack both memory paths (double recall/observe/flush).
const delegateEmbeddedFallbackApis = new WeakSet<object>();
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
  checkHealth: (host: string, port: number) => boolean;
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
  let bridge: ReturnType<typeof resolveBridgeMode>;
  try {
    bridge = resolveBridgeMode(options.configBridgeMode);
  } catch (err) {
    // An invalid bridgeMode (config typo or bad env override) must not abort
    // the whole plugin registration — reject LOUDLY, then run embedded so the
    // deployment keeps its memory loop (AGENTS.md §4: side effects must not
    // crash the main flow).
    log.error(`${String(err)} — falling back to the embedded runtime`);
    delegateEmbeddedFallbackApis.add(api);
    return false;
  }
  if (delegateEmbeddedFallbackApis.has(api)) {
    log.debug(
      `delegate register: ${options.serviceId} previously fell back to embedded on this api — staying embedded to avoid stacking memory paths`,
    );
    return false;
  }
  if (bridge.mode !== "delegate") {
    // The caller will bind embedded hooks on this api (unless passive, which
    // binds nothing and must not poison a later delegate registration).
    // Record active registers so a later reload that flips to delegate on the
    // SAME api stays embedded instead of stacking both memory paths.
    if (!options.passive) delegateEmbeddedFallbackApis.add(api);
    return false;
  }
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
    // Record the fallback so a later register() on the same api does not switch
    // to delegate and stack memory paths on top of the embedded hooks just bound.
    delegateEmbeddedFallbackApis.add(api);
    log.error(
      `bridge mode delegate requested but no healthy daemon at ` +
        `${bridge.daemonHost}:${bridge.daemonPort} — falling back to the embedded runtime`,
    );
    return false;
  }
  // Passive mode attaches no hooks — recording it as bound would make a later
  // ACTIVE register() on the same api skip both delegate and embedded paths.
  if (!options.passive) {
    (boundServices ?? delegateHookApiServices.set(api, new Set()).get(api))?.add(
      options.serviceId,
    );
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
  const target: DelegateDaemonTarget = {
    host: bridge.daemonHost,
    port: bridge.daemonPort,
    resolveAuthToken: loadDaemonAuth,
  };
  registerDelegateRuntime(api, {
    serviceId: options.serviceId,
    target,
    namespace: "",
    namespaceBindings: createDelegateNamespaceBindingStore(options.memoryDir, options.serviceId),
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
