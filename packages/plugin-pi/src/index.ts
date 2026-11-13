import { createHash, randomUUID } from "node:crypto";
import path from "node:path";


import { DEFAULT_CONFIG, loadConfig, type LoadConfigOptions, type RemnicPiConfig } from "./config.js";
import {
  RemnicClient,
  RemnicHttpError,
  RemnicRequestAbortedError,
  isTransientNetworkError,
  type McpTool,
  type ObserveMessage,
  type ObserveOptions,
} from "./client.js";
import { resolvePiAgentHome } from "./paths.js";
import {
  hashObservedMessage,
  observedMessageDedupeKey,
  sessionKeyFromContext,
  summarizeMessages,
  textFromMessage,
  toObserveMessage,
} from "./messages.js";
import { RecallTimeoutBreaker, isRecallTimeoutError } from "./recall-timeout-breaker.js";
import { createMcpRegistration } from "./mcp-registration.js";
import { joinStartupProbe, runStartupProbeChain, type DaemonHealthVerdict } from "./startup-probe.js";
import { classifyObserveFailure, ObserveOutbox } from "./outbox.js";
import {
  emitRecallTimeoutTrip,
  RECALL_DISABLED_STATUS,
  refreshOfflineStatusLabel,
  remnicStatusLabel,
  type DaemonProbeResult,
} from "./status-label.js";

import {
  MAX_OBSERVED_HASHES,
  drainObserveOutboxAtStartup,
  liveReplayKey,
  startObserveOutboxDrain,
  rememberLiveObservedReplayKey,
  rememberObservedHash,
  skipLiveObservedReplayMessages,
} from "./observe-flow.js";
export type { DaemonProbeResult } from "./status-label.js";

export type PiApi = {
  on(event: string, handler: (event: any, ctx: any) => unknown | Promise<unknown>): void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }): void;
  registerTool(tool: Record<string, unknown>): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
};

export type RemnicPiConfigInput = Omit<RemnicPiConfig, "recallTimeoutThreshold" | "recallTimeoutWindow"> &
  Partial<Pick<RemnicPiConfig, "recallTimeoutThreshold" | "recallTimeoutWindow">>;

export interface RemnicPiExtensionOptions extends LoadConfigOptions {
  config?: RemnicPiConfigInput;
}

const STATE_CUSTOM_TYPE = "remnic_state";
/** A retry needs at least this much remaining startup budget to be worth starting. */
const MCP_TOOLS_LIST_RETRY_FLOOR_MS = 250;
const MAX_SESSION_STATES = 50;
const MAX_CONTEXT_CHARS = 12000;
const TRUNCATION_NOTICE = "\n\n[Remnic context truncated]";
const SESSION_OWNED_FIELDS = new Set(["sessionKey", "namespace", "cwd"]);
const RECALL_BREAKER_REGISTRY_KEY = Symbol.for("remnic.plugin-pi.recall-timeout-breakers");
const recallBreakerRegistry = globalThis as { [key: symbol]: Map<string, RecallTimeoutBreaker> | undefined };
const PROCESS_SCOPED_RECALL_BREAKERS =
  recallBreakerRegistry[RECALL_BREAKER_REGISTRY_KEY] ??= new Map<string, RecallTimeoutBreaker>();
const RECALL_PRODUCING_TOOL_NAMES: Record<string, true> = {
  "remnic.recall": true,
  "remnic.recall_xray": true,
};

/**
 * Match an MCP tool name against the recognized Remnic namespace and derive the
 * Pi-safe registered name. Two catalog shapes are supported:
 *
 * - legacy dotted form:  `remnic.recall`      -> pi: `remnic_recall`
 * - current underscore:  `remnic_recall`      -> pi: `remnic_recall`
 *
 * Only names starting with the exact `remnic.` or `remnic_` prefix and a
 * nonempty alphanumeric/underscore suffix are accepted. The server-side name
 * is echoed verbatim in tools/call so the request is accepted by whichever
 * server shape produced the catalog.
 */
export function matchRemnicMcpToolName(name: unknown): { serverToolName: string; piToolName: string } | null {
  if (typeof name !== "string") return null;
  let rest: string | null = null;
  if (name.startsWith("remnic.")) {
    rest = name.slice("remnic.".length);
  } else if (name.startsWith("remnic_")) {
    rest = name.slice("remnic_".length);
  }
  if (rest === null || !/^[a-zA-Z0-9_]+$/.test(rest)) return null;
  return {
    serverToolName: name,
    piToolName: `remnic_${rest}`,
  };
}

/** Breaker lookup tolerant of both catalog shapes (`remnic_recall` <-> `remnic.recall`). */
function isRecallProducingToolName(serverToolName: string): boolean {
  return (
    RECALL_PRODUCING_TOOL_NAMES[serverToolName] === true ||
    RECALL_PRODUCING_TOOL_NAMES[serverToolName.replace(/^remnic_/, "remnic.")] === true
  );
}

type PiSessionState = {
  observedHashes: Set<string>;
  liveObservedReplayKeys: Map<string, number>;
  /** Cached recall context — populated from the first context event's user prompt,
   *  reused byte-identically across subsequent turns for KV cache prefix stability. */
  cachedContext: string | null;
  /** True once recall has been attempted (success or failure) for this session. */
  recallCompleted: boolean;
  /**
   * In-flight startup probe chain, kicked off in the background by
   * `session_start` (#3273 phase 1); first-turn hooks await it (bounded) for
   * the freshest reachability verdict.
   */
  startupProbe: Promise<DaemonProbeResult> | null;
  /** Set once a first-turn hook has joined the startup probe, so the bounded verdict wait runs once per session. */
  startupProbeJoined: boolean;
  startupEpoch: number; // bumped each session_start; a startup chain is current only while its epoch matches
  /** True while the last status label this session wrote is the offline one; the next successful daemon call clears it. */
  statusOffline: boolean;
};

type NotifyLevel = "info" | "success" | "warning" | "error";
type NotifyFn = (message: string, level: NotifyLevel) => void;

export type PiContextSnapshot = {
  sessionKey: string;
  cwd: string;
  entries: any[];
  branch: any[];
  notify: NotifyFn;
  setStatus: (key: string, value: string) => void;
  compact?: () => unknown;
};
type PiContextSnapshotOptions = {
  includeSessionHistory?: boolean;
};

function recallTimeoutBreakerCacheKey(
  config: Pick<RemnicPiConfig, "remnicDaemonUrl" | "namespace" | "authToken" | "recallTimeoutThreshold" | "recallTimeoutWindow">,
): string {
  return JSON.stringify([
    config.remnicDaemonUrl,
    config.namespace ?? "",
    createHash("sha256").update(config.authToken ?? "").digest("hex"),
    config.recallTimeoutThreshold,
    config.recallTimeoutWindow,
  ]);
}

export function resetProcessRecallBreakerForTest(
  config: Pick<RemnicPiConfig, "remnicDaemonUrl" | "namespace" | "authToken" | "recallTimeoutThreshold" | "recallTimeoutWindow">,
): void {
  PROCESS_SCOPED_RECALL_BREAKERS.delete(recallTimeoutBreakerCacheKey(config));
}

export function createRemnicPiExtension(options: RemnicPiExtensionOptions = {}) {
  const config: RemnicPiConfig = { ...DEFAULT_CONFIG, ...(options.config ?? loadConfig(options)) };
  const client = new RemnicClient(config);
  // One durable outbox per extension instance (shared across sessions in this
  // process — the file is process-global, and a single ObserveOutbox instance
  // serializes its writes). Entries carry their own sessionKey, so a drain
  // started by any session's successful contact replays every session's
  // queued captures in queue order.
  const observeOutbox = config.observeEnabled
    ? new ObserveOutbox(
      config.observeOutboxPath?.trim() || path.join(resolvePiAgentHome(process.env), "remnic", "observe-outbox.jsonl"),
    )
    : null;
  const sessionStates = new Map<string, PiSessionState>();
  const breakerKey = recallTimeoutBreakerCacheKey(config);
  let recallTimeoutBreaker = PROCESS_SCOPED_RECALL_BREAKERS.get(breakerKey);
  if (!recallTimeoutBreaker) {
    recallTimeoutBreaker = new RecallTimeoutBreaker({
      threshold: config.recallTimeoutThreshold,
      window: config.recallTimeoutWindow,
    });
    PROCESS_SCOPED_RECALL_BREAKERS.set(breakerKey, recallTimeoutBreaker);
  }

  return async function remnicPiExtension(pi: PiApi): Promise<void> {
    // omp (>= 18.x) throws ExtensionRuntimeNotInitializedError from action
    // methods such as appendEntry while the extension factory is still
    // loading, which fails the whole extension load. Queue state entries
    // written during load and flush them once the runtime is live (the first
    // session_start). COS-487.
    const loadPhase = createLoadPhaseEntryQueue(pi);
    const ensureMcpTools = createMcpRegistration((registered) =>
      config.mcpToolsEnabled && config.authToken
        ? registerMcpTools(pi, client, config, recallTimeoutBreaker, sessionStates, registered, loadPhase.append)
        : Promise.resolve(true),
    );
    pi.on("session_start", async (_event, ctx) => {
      loadPhase.flush();
      const session = snapshotPiContext(ctx, { includeSessionHistory: true });
      if (!session) return;
      const { state } = getSessionState(session.sessionKey, sessionStates);
      restoreObservedState(session, state.observedHashes);
      state.cachedContext = null;
      state.recallCompleted = false;
      state.startupProbeJoined = false;
      state.startupEpoch += 1;
      state.statusOffline = false;

      // Drain captures queued by a previous process/crash while the daemon
      // refused work. Runs before the background startup chain so the replay
      // lands before the first turn's own observe.
      if (observeOutbox) {
        // One cheap attempt: a dead daemon must not hold session start behind retry and
        // backoff ladders; whatever stays queued replays on the next successful contact.
        await drainObserveOutboxAtStartup(session, client, config, observeOutbox, state.observedHashes, state.liveObservedReplayKeys);
      }

      // Probe health + update the circuit breaker UNCONDITIONALLY so an offline
      // daemon is marked unreachable even when the status UI is off; otherwise
      // the namespace preflight and every later hook each burn a full request
      // budget on a doomed call. The status LABEL stays gated on statusEnabled.
      // The chain runs in the background (#3273 phase 1); the promise is kept on
      // session state so first-turn hooks can await it.
      state.startupProbe = runStartupProbeChain(
        {
          probeHealth: probeDaemonHealth,
          statusLabel: remnicStatusLabel,
          recallDisabledStatus: RECALL_DISABLED_STATUS,
          appendStateEntry: (data) => pi.appendEntry(STATE_CUSTOM_TYPE, data),
          errorText: errorMessage,
        },
        { pi, session, client, config, recallTimeoutBreaker, state, epoch: state.startupEpoch, isLive: () => sessionStates.get(session.sessionKey) === state },
      );
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const session = snapshotPiContext(ctx);
      if (!session) return;
      const { state } = getSessionState(session.sessionKey, sessionStates);

      // On the first before_agent_start, populate the cache using the user's
      // prompt text so semantic recall produces relevant results.  Once
      // populated, the cached context is appended to the system prompt on
      // every turn for KV cache prefix stability (PR #2208).
      // Join the in-flight startup probe (bounded) so an unreachable daemon is skipped, not recalled.
      if (!state.recallCompleted && config.recallEnabled && config.authToken) {
        await joinStartupProbe(state, config);
      }
      if (!state.recallCompleted && config.recallEnabled && config.authToken && client.isReachable()) {
        const promptText = typeof event.prompt === "string" && event.prompt.trim().length > 0 ? event.prompt : "";
        if (promptText) {
          state.recallCompleted = true;
          try {
            const recalled = await executeRecallWithBreaker(
              (signal) =>
                client.recall(promptText, session.sessionKey, session.cwd, {
                  timeoutMs: config.turnRequestTimeoutMs,
                  signal,
                }),
              recallTimeoutBreaker,
              pi,
              session,
              config,
              state,
            );
            client.markReachable();
            refreshOfflineStatusLabel(session, state, config, recallTimeoutBreaker.isTripped());
            const context = trimContext(recalled.context ?? "", config.recallBudgetChars);
            if (context) {
              state.cachedContext = context;
            }
          } catch (err) {
            if (recallTimeoutBreaker.isTripped()) return;
            if (isDaemonUnreachableError(err)) client.markUnreachable(config.daemonCooldownMs);
            session.notify(`Remnic recall unavailable: ${errorMessage(err)}`, "warning");
          }
        }
      }

      // Inject cached context into the system prompt — byte-identical across
      // turns so the KV cache prefix is preserved.  This avoids the
      // system-role message issue: Pi's AgentMessage union does not include
      // "system", so injecting via the context hook produced an invalid
      // provider payload that Pi drops (codex review).
      if (!state.cachedContext) return;
      const basePrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      return {
        systemPrompt: `${basePrompt}\n\n${state.cachedContext}`,
      };
    });

    pi.on("message_end", async (event, ctx) => {
      const session = snapshotPiContext(ctx);
      if (!session) return;
      if (!config.observeEnabled || !isUserMessage(event.message)) return;
      const { state } = getSessionState(session.sessionKey, sessionStates);
      // Observe is a first-turn daemon call gated on isReachable(): join the in-flight probe first.
      await joinStartupProbe(state, config);
      await observeMessagesForSession(session, client, [event.message], state.observedHashes, state.liveObservedReplayKeys, config, false, observeOutbox, state, recallTimeoutBreaker);
    });

    pi.on("turn_end", async (event, ctx) => {
      const session = snapshotPiContext(ctx);
      if (!session) return;
      if (!config.observeEnabled) return;
      const messages = [event.message, ...(Array.isArray(event.toolResults) ? event.toolResults : [])];
      const { state } = getSessionState(session.sessionKey, sessionStates);
      await joinStartupProbe(state, config);
      await observeMessagesForSession(session, client, messages, state.observedHashes, state.liveObservedReplayKeys, config, false, observeOutbox, state, recallTimeoutBreaker);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const session = snapshotPiContext(ctx, { includeSessionHistory: true });
      if (!session) return;
      const { sessionKey, state } = getSessionState(session.sessionKey, sessionStates);
      if (config.observeEnabled) {
        const branchMessages = branchMessagesWithEntryIdentity(session.branch);
        const unobservedBranchMessages = skipLiveObservedReplayMessages(session.sessionKey, branchMessages, state.liveObservedReplayKeys);
        if (unobservedBranchMessages.length > 0) {
          await observeMessagesForSession(session, client, unobservedBranchMessages, state.observedHashes, undefined, config, true, observeOutbox, state, recallTimeoutBreaker);
        }
      }
      persistObservedState(pi, state.observedHashes);
      sessionStates.delete(sessionKey);
    });

    pi.on("session_before_compact", async (event, ctx) => {
      const session = snapshotPiContext(ctx);
      if (!session) return;
      if (!config.compactionEnabled || !config.authToken) return;
      const preparation = event.preparation ?? {};
      try {
        await client.lcmCompactionFlush(session.sessionKey);
      } catch (err) {
        session.notify(`Remnic LCM flush failed: ${errorMessage(err)}`, "warning");
        return;
      }

      const tokensBefore = finiteTokenCount(preparation.tokensBefore);
      const tokensAfter = finiteTokenCount(preparation.tokensAfter);
      if (tokensBefore !== null && tokensAfter !== null) {
        try {
          await client.lcmCompactionRecord(session.sessionKey, tokensBefore, tokensAfter);
        } catch (err) {
          session.notify(`Remnic LCM compaction token record failed: ${errorMessage(err)}`, "warning");
        }
      }

      const summary = buildCompactionSummary(preparation);
      if (!summary.trim()) return;
      try {
        await client.contextCheckpoint(session.sessionKey, summary);
      } catch (err) {
        session.notify(`Remnic context checkpoint failed: ${errorMessage(err)}`, "warning");
      }
      const details = fileDetailsFromPreparation(preparation);
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            ...details,
            remnic: { version: 1, source: "pi" },
          },
        },
      };
    });

    registerCommands(pi, client, config, recallTimeoutBreaker, sessionStates, ensureMcpTools);
    await ensureMcpTools();
    loadPhase.markLoaded();
  };
}

/**
 * Diagnostic state entry (level + code + message). Covers every diagnostic
 * code the extension emits so the load-phase queue can carry any of them;
 * the observed-hash checkpoint entry is written only after load and goes
 * straight to pi.appendEntry.
 */
export interface StateEntryData {
  level: "info" | "warning" | "error";
  code: "MCP_TOOLS_LIST_FAILED" | "MCP_TOOLS_REGISTER_FAILED" | "MCP_TOOLS_FILTERED" | "NAMESPACE_NOT_WRITABLE" | "NAMESPACE_OK" | "RECALL_TIMEOUT_TRIP";
  /** Omitted only by the silent NAMESPACE_OK heartbeat. */
  message?: string;
  error?: string;
  observedToolNames?: string[];
  namespace?: string;
  reason?: string;
  persistent?: boolean;
  recordedAt?: string;
  threshold?: number;
  window?: number;
  disabledAt?: string;
}
type AppendEntryFn = (customType: string, data: StateEntryData) => void;

/** Load-phase buffer for state entries; see createLoadPhaseEntryQueue. */
export interface LoadPhaseEntryQueue {
  append: AppendEntryFn;
  markLoaded: () => void;
  flush: () => void;
}

/**
 * Buffers appendEntry calls made while the extension factory is loading.
 * omp forbids action methods during load; entries are replayed on the first
 * session_start, and calls made after load go straight through.
 */
export function createLoadPhaseEntryQueue(pi: PiApi): LoadPhaseEntryQueue {
  let loading = true;
  const pending: Array<[string, StateEntryData]> = [];
  return {
    append(customType, data) {
      if (loading) {
        pending.push([customType, data]);
        return;
      }
      pi.appendEntry(customType, data);
    },
    markLoaded() {
      loading = false;
    },
    flush() {
      loading = false;
      while (pending.length > 0) {
        const [customType, data] = pending.shift()!;
        try {
          pi.appendEntry(customType, data);
        } catch (err) {
          console.warn(`[remnic] deferred state entry dropped: ${errorMessage(err)}`);
        }
      }
    },
  };
}

export default async function remnicPiExtension(pi: PiApi): Promise<void> {
  await createRemnicPiExtension()(pi);
}

function registerCommands(
  pi: PiApi,
  client: RemnicClient,
  config: RemnicPiConfig,
  recallTimeoutBreaker: RecallTimeoutBreaker,
  sessionStates: Map<string, PiSessionState>,
  ensureMcpTools: () => Promise<void>,
): void {
  pi.registerCommand("remnic-status", {
    description: "Check Remnic daemon status",
    handler: commandHandler(async (_args, _ctx, session) => {
      if (recallTimeoutBreaker.isTripped()) notifyRecallDisabled(session);
      const health = await client.health();
      // The daemon responded (any HTTP result), so clear any stale cooldown a
      // prior timeout left on the shared client (cursor review).
      client.markReachable();
      if (health.ok) await ensureMcpTools();
      session.notify(`Remnic ${health.ok ? "healthy" : "unhealthy"} at ${config.remnicDaemonUrl}`, health.ok ? "success" : "warning");
    }),
  });

  pi.registerCommand("remnic-recall", {
    description: "Recall Remnic context for a query",
    handler: commandHandler(async (args, _ctx, session) => {
      const query = args.trim();
      if (!query) {
        session.notify("Usage: /remnic-recall <query>", "warning");
        return;
      }
      if (recallTimeoutBreaker.isTripped()) {
        notifyRecallDisabled(session);
        return;
      }
      const { state } = getSessionState(session.sessionKey, sessionStates);
      const result = await executeRecallWithBreaker(
        (signal) =>
          client.recall(query, session.sessionKey, session.cwd, {
            timeoutMs: config.requestTimeoutMs,
            signal,
          }),
        recallTimeoutBreaker,
        pi,
        session,
        config,
        state,
      );
      client.markReachable();
      refreshOfflineStatusLabel(session, state, config, recallTimeoutBreaker.isTripped());
      session.notify(trimContext(result.context ?? "(no Remnic context)", MAX_CONTEXT_CHARS), "info");
    }),
  });

  pi.registerCommand("remnic-remember", {
    description: "Store a Remnic memory",
    handler: commandHandler(async (args, _ctx, session) => {
      const content = args.trim();
      if (!content) {
        session.notify("Usage: /remnic-remember <memory>", "warning");
        return;
      }
      await client.storeMemory(content, session.sessionKey);
      session.notify("Stored Remnic memory", "success");
    }),
  });

  pi.registerCommand("remnic-lcm-search", {
    description: "Search Remnic LCM archived Pi context",
    handler: commandHandler(async (args, _ctx, session) => {
      const query = args.trim();
      if (!query) {
        session.notify("Usage: /remnic-lcm-search <query>", "warning");
        return;
      }
      const result = await client.lcmSearch(query, session.sessionKey);
      session.notify(JSON.stringify(result, null, 2), "info");
    }),
  });

  pi.registerCommand("remnic-why", {
    description: "Explain the last Remnic recall",
    handler: commandHandler(async (_args, _ctx, session) => {
      const result = await client.recallExplain(session.sessionKey);
      session.notify(JSON.stringify(result, null, 2), "info");
    }),
  });

  pi.registerCommand("remnic-compact", {
    description: "Trigger Pi compaction with Remnic LCM coordination",
    handler: commandHandler(async (_args, _ctx, session) => {
      session.compact?.();
      session.notify("Compaction requested", "info");
    }),
  });
}

function commandHandler(
  handler: (args: string, ctx: any, session: PiContextSnapshot) => Promise<void>,
): (args: string, ctx: any) => Promise<void> {
  return async (args, ctx) => {
    const session = snapshotPiContext(ctx);
    if (!session) return;
    try {
      await handler(args, ctx, session);
    } catch (err) {
      session.notify(`Remnic command failed: ${errorMessage(err)}`, "warning");
    }
  };
}

async function registerMcpTools(
  pi: PiApi,
  client: RemnicClient,
  config: RemnicPiConfig,
  recallTimeoutBreaker: RecallTimeoutBreaker,
  sessionStates: Map<string, PiSessionState>,
  registered: Set<string>,
  appendEntry: AppendEntryFn = (customType, data) => pi.appendEntry(customType, data),
): Promise<boolean> {
  let tools: McpTool[] = [];
  // A transient failure at session start used to silently register zero
  // tools for the whole session (recall kept working, so the session looked
  // healthy). Retry once inside the remaining startup budget, and record a
  // warning state entry when the catalog still cannot be listed.
  const budgetStartedAt = Date.now();
  let listed = false;
  let lastError: unknown;
  for (let attempt = 0; attempt <= 1 && !listed; attempt += 1) {
    const remaining = config.startupRequestTimeoutMs - (Date.now() - budgetStartedAt);
    if (remaining <= 0) break;
    if (attempt > 0 && remaining < MCP_TOOLS_LIST_RETRY_FLOOR_MS) break;
    try {
      // Honor the configured budget exactly: the floor only decides whether
      // a retry may start, never how long a request may take.
      tools = await client.mcpListTools({ timeoutMs: remaining });
      listed = true;
    } catch (err) {
      lastError = err;
    }
  }
  if (!listed) {
    // Warn on every terminal failure — including when the first attempt
    // exhausted the budget and the retry never started.
    const reason = lastError === undefined ? "no attempt completed" : errorMessage(lastError);
    const message =
      `Remnic MCP tools/list failed (${reason}). ` +
      "Resolve the reported error, then run /remnic-status to retry missing tool registrations.";
    console.warn(`[remnic] ${message}`);
    appendEntry(STATE_CUSTOM_TYPE, {
      level: "warning",
      code: "MCP_TOOLS_LIST_FAILED",
      message,
      error: reason,
    });
    return false;
  }
  let allRegistered = true;
  const seenPiToolNames = new Set<string>();
  for (const tool of tools) {
    const match = matchRemnicMcpToolName(tool.name);
    if (!match) continue;
    // A catalog that mixes shapes could map two names onto one Pi-safe name;
    // register the first occurrence only.
    if (seenPiToolNames.has(match.piToolName)) continue;
    seenPiToolNames.add(match.piToolName);
    if (registered.has(match.piToolName)) continue;
    const definition = {
      name: match.piToolName,
      label: match.serverToolName,
      description: tool.description ?? `Call ${tool.name}`,
      parameters: toPiToolParametersSchema(tool.inputSchema),
      async execute(_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
        const session = snapshotPiContext(ctx);
        if (!session) {
          return {
            content: [{ type: "text", text: "Remnic tool skipped because the Pi context is no longer active." }],
            details: { skipped: true, reason: "stale_context" },
          };
        }
        if (recallTimeoutBreaker.isTripped() && isRecallProducingToolName(tool.name)) {
          const message = notifyRecallDisabled(session);
          return {
            content: [{ type: "text", text: message }],
            details: { skipped: true, reason: "recall_timeout_breaker" },
          };
        }
        const safeParams = stripSessionOwnedRuntimeFields(params ?? {}) as Record<string, unknown>;
        const toolArguments = {
          ...safeParams,
          sessionKey: session.sessionKey,
          namespace: config.namespace,
          cwd: session.cwd,
        };
        const result = isRecallProducingToolName(tool.name)
          ? await executeRecallWithBreaker(
              (breakerSignal) =>
                client.mcpTool(match.serverToolName, toolArguments, {
                  signal: signal ? AbortSignal.any([signal, breakerSignal]) : breakerSignal,
                }),
              recallTimeoutBreaker,
              pi,
              session,
              config,
              getSessionState(session.sessionKey, sessionStates).state,
            )
          : await client.mcpTool(match.serverToolName, toolArguments, { signal });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    };
    try {
      pi.registerTool(definition);
      registered.add(match.piToolName);
    } catch (err) {
      allRegistered = false;
      const message = `Remnic MCP tool ${match.piToolName} registration failed: ${errorMessage(err)}. Run /remnic-status to retry.`;
      console.warn(`[remnic] ${message}`);
      appendEntry(STATE_CUSTOM_TYPE, { level: "warning", code: "MCP_TOOLS_REGISTER_FAILED", message });
    }
  }
  if (tools.length > 0 && seenPiToolNames.size === 0) {
    const observedNames = tools.map((tool) => tool.name).filter(isString);
    const observed = observedNames.slice(0, 10).join(", ");
    const message =
      `Remnic MCP tools/list returned ${tools.length} tool(s) but none matched the Remnic namespace` +
      ` ("remnic." or "remnic_" prefix); no Remnic MCP tools were registered. Observed: ${observed}` +
      `${observedNames.length > 10 ? ", …" : ""}. Check Remnic server/plugin version compatibility.`;
    console.warn(`[remnic] ${message}`);
    appendEntry(STATE_CUSTOM_TYPE, {
      level: "warning",
      code: "MCP_TOOLS_FILTERED",
      message,
      observedToolNames: observedNames,
    });
  }
  return allRegistered && seenPiToolNames.size > 0;
}

/** Plain JSON Schema: Pi validates tool parameters as plain JSON Schema. */
export type PiToolParametersSchema = Record<string, unknown>;

export function toPiToolParametersSchema(inputSchema: unknown): PiToolParametersSchema {
  return stripSessionOwnedSchemaFields(inputSchema);
}

export function stripSessionOwnedSchemaFields(inputSchema: unknown): Record<string, unknown> {
  if (!isRecord(inputSchema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return stripSessionOwnedSchemaNode(inputSchema) as Record<string, unknown>;
}

function stripSessionOwnedSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSessionOwnedSchemaNode(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const schema: Record<string, unknown> = { ...value };
  if (isRecord(value.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(value.properties)) {
      if (SESSION_OWNED_FIELDS.has(key)) continue;
      properties[key] = stripSessionOwnedSchemaNode(property);
    }
    schema.properties = properties;
  }
  if (Array.isArray(value.required)) {
    schema.required = value.required.filter(
      (field) => typeof field !== "string" || !SESSION_OWNED_FIELDS.has(field),
    );
  }
  for (const key of ["items", "additionalProperties", "not"] as const) {
    if (isRecord(value[key])) {
      schema[key] = stripSessionOwnedSchemaNode(value[key]);
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(value[key])) {
      schema[key] = value[key].map((entry) => stripSessionOwnedSchemaNode(entry));
    }
  }
  return schema;
}

export function stripSessionOwnedRuntimeFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSessionOwnedRuntimeFields(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SESSION_OWNED_FIELDS.has(key)) continue;
    sanitized[key] = stripSessionOwnedRuntimeFields(child);
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUserMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "user";
}

function getSessionState(sessionKey: string, states: Map<string, PiSessionState>): { sessionKey: string; state: PiSessionState } {
  let state = states.get(sessionKey);
  if (!state) {
    state = {
      observedHashes: new Set<string>(),
      liveObservedReplayKeys: new Map<string, number>(),
      cachedContext: null,
      recallCompleted: false,
      startupProbe: null,
      startupProbeJoined: false,
      startupEpoch: 0,
      statusOffline: false,
    };
    states.set(sessionKey, state);
    pruneSessionStates(states);
  }
  return { sessionKey, state };
}

function pruneSessionStates(states: Map<string, PiSessionState>): void {
  while (states.size > MAX_SESSION_STATES) {
    const oldest = states.keys().next().value;
    if (typeof oldest !== "string") return;
    states.delete(oldest);
  }
}

export async function observeMessages(
  ctx: any,
  client: RemnicClient,
  rawMessages: unknown[],
  observedHashes: Set<string>,
  liveObservedReplayKeys?: Map<string, number>,
  config?: RemnicPiConfig,
  outbox?: ObserveOutbox | null,
): Promise<void> {
  const session = snapshotPiContext(ctx);
  if (!session) return;
  await observeMessagesForSession(session, client, rawMessages, observedHashes, liveObservedReplayKeys, config, false, outbox);
}

async function observeMessagesForSession(
  session: PiContextSnapshot,
  client: RemnicClient,
  rawMessages: unknown[],
  observedHashes: Set<string>,
  liveObservedReplayKeys?: Map<string, number>,
  config?: RemnicPiConfig,
  forceAttempt = false,
  outbox?: ObserveOutbox | null,
  state?: PiSessionState,
  recallTimeoutBreaker?: RecallTimeoutBreaker,
): Promise<void> {
  const messages: ObserveMessage[] = [];
  const messageHashes: Array<string | null> = [];
  const pendingHashes = new Set<string>();
  const outboxPending = outbox ? await outbox.pendingHashes() : null;
  for (const raw of rawMessages) {
    const message = toObserveMessage(raw);
    if (!message) continue;
    const hash = observedMessageDedupeKey(message, session.sessionKey);
    if (hash && (observedHashes.has(hash) || pendingHashes.has(hash))) continue;
    // Already durably queued for replay — never re-send it live under a fresh
    // (different) request identity, or the daemon would ingest it twice.
    if (outboxPending?.has(hash ?? "")) continue;
    if (hash) pendingHashes.add(hash);
    messages.push(message);
    messageHashes.push(hash);
  }
  if (messages.length === 0) return;
  // Circuit breaker: when config is wired (the live Pi handlers always pass
  // it), skip observe fast while the daemon is known-down so a dead host
  // doesn't burn the full per-turn budget on every turn (#1626). Shutdown is
  // the exception — it is the last chance to observe the branch before the
  // session tears down, so force the attempt even mid-cooldown; a failure
  // still trips the breaker normally (codex review).
  if (config && !forceAttempt && !client.isReachable()) return;
  // Live turn hooks are bounded by the per-turn budget to protect the host's
  // ~30s handler window (#1626). Shutdown is teardown with no such constraint,
  // so the forced replay uses the general request budget — otherwise a large
  // unobserved branch would time out exactly when forceAttempt tried to save it
  // (cursor review).
  // One replay identity per logical observe: the live attempt, any retry of it and a
  // later outbox replay all send the same key, so the daemon can dedupe a lost response.
  const replayNonce = randomUUID();
  const observeOptions: ObserveOptions = { replayNonce };
  if (config) observeOptions.timeoutMs = forceAttempt ? config.requestTimeoutMs : config.turnRequestTimeoutMs;
  try {
    await client.observe(session.sessionKey, session.cwd, messages, observeOptions);
    if (config) client.markReachable();
    if (state && config) refreshOfflineStatusLabel(session, state, config, recallTimeoutBreaker?.isTripped() ?? false);
    for (const hash of pendingHashes) rememberObservedHash(observedHashes, hash);
    if (liveObservedReplayKeys) {
      for (const message of messages) {
        rememberLiveObservedReplayKey(liveObservedReplayKeys, liveReplayKey(message, session.sessionKey));
      }
    }
    // Successful contact is the drain trigger: replay anything queued while the
    // daemon was refusing work. It runs in the background with its own error
    // handling, so it can neither delay this hook nor turn a delivered live turn
    // into a failed (and re-queued) one.
    if (outbox && config) {
      const drain = startObserveOutboxDrain(session, client, config, outbox, observedHashes, liveObservedReplayKeys, forceAttempt === true);
      // Shutdown is the last chance before teardown: wait for one bounded pass (it never rejects).
      if (forceAttempt) await drain;
    }
  } catch (err) {
    if (config && isDaemonUnreachableError(err)) client.markUnreachable(config.daemonCooldownMs);
    const failureClass = outbox && config && err instanceof Error ? classifyObserveFailure(err) : "permanent";
    if (failureClass === "permanent") {
      session.notify(`Remnic observe failed: ${errorMessage(err)}`, "warning");
      return;
    }
    // Capacity backpressure or ambiguous failure: the turns are not lost —
    // queue them durably for replay on the next successful contact.
    try {
      await outbox?.enqueue(
        { sessionKey: session.sessionKey, cwd: session.cwd, messages, messageHashes, replayNonce },
        (message, level) => session.notify(message, level),
      );
    } catch (enqueueErr) {
      // A lock timeout or write failure must not lose the turn silently.
      session.notify(
        `Remnic observe failed and could not be queued: ${errorMessage(enqueueErr)} (original error: ${errorMessage(err)})`,
        "error",
      );
      return;
    }
    session.notify(
      `Remnic observe deferred (daemon refused or unreachable): ${messages.length} message(s) queued durably for retry — ${errorMessage(err)}`,
      "warning",
    );
  }
}

export function buildCompactionSummary(preparation: any): string {
  const previousSummary = typeof preparation.previousSummary === "string"
    ? preparation.previousSummary.trim()
    : "";
  const messages = [
    ...(Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : []),
    ...(Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
  ];
  const transcript = summarizeMessages(messages, 24000);
  const details = fileDetailsFromPreparation(preparation);

  if (
    !previousSummary &&
    !transcript &&
    details.readFiles.length === 0 &&
    details.modifiedFiles.length === 0
  ) {
    return "";
  }

  const sections: string[] = [
    "## Remnic Pi Context Checkpoint",
    "",
    "This checkpoint was created by Remnic during Pi context compaction.",
  ];
  if (previousSummary) sections.push("", "## Previous Summary", previousSummary);
  if (transcript) sections.push("", "## Conversation Excerpt", transcript);
  if (details.readFiles.length > 0) sections.push("", "<read-files>", ...details.readFiles, "</read-files>");
  if (details.modifiedFiles.length > 0) sections.push("", "<modified-files>", ...details.modifiedFiles, "</modified-files>");
  return sections.join("\n");
}

function fileDetailsFromPreparation(preparation: any): { readFiles: string[]; modifiedFiles: string[] } {
  const fileOps = preparation?.fileOps;
  const read = fileOps?.read instanceof Set ? Array.from(fileOps.read).filter(isString) : [];
  const edited = fileOps?.edited instanceof Set ? Array.from(fileOps.edited).filter(isString) : [];
  const written = fileOps?.written instanceof Set ? Array.from(fileOps.written).filter(isString) : [];
  const modified = new Set([...edited, ...written]);
  return {
    readFiles: read.filter((file) => !modified.has(file)).sort(),
    modifiedFiles: Array.from(modified).sort(),
  };
}

function restoreObservedState(session: PiContextSnapshot, observedHashes: Set<string>): void {
  for (const entry of session.entries) {
    if (entry?.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
    const hashes = entry.data?.observedHashes;
    if (Array.isArray(hashes)) {
      for (const hash of hashes) {
        if (typeof hash === "string") rememberObservedHash(observedHashes, hash);
      }
    }
  }
}

function persistObservedState(pi: PiApi, observedHashes: Set<string>): void {
  const observed = Array.from(observedHashes).slice(-MAX_OBSERVED_HASHES);
  pi.appendEntry(STATE_CUSTOM_TYPE, {
    observedHashes: observed,
    recordedAt: new Date().toISOString(),
  });
}


/**
 * Probe the daemon and return the verdict plus the shared-breaker action the
 * startup chain must apply (under its own currency guard). This runs at
 * session_start regardless of `statusEnabled`: the breaker update is a
 * data-path concern (a down daemon must be marked unreachable so the namespace
 * preflight and every later hook fast-skip instead of each burning a full
 * request budget), independent of whether the status UI is shown.
 *
 * A 503 `not_ready` answer is NOT offline (issue #2215): the daemon responded — it is up and
 * serving recall via fallback retrieval while startup search warm-up is still
 * running — so it counts as reachable and renders as "starting" instead of
 * tripping the breaker or claiming the service is down.
 */
async function probeDaemonHealth(
  client: RemnicClient,
  config: RemnicPiConfig,
): Promise<DaemonHealthVerdict> {
  try {
    await client.live({ timeoutMs: config.startupRequestTimeoutMs });
    return { result: "ready", breaker: "reachable" };
  } catch (err) {
    if (err instanceof RemnicHttpError && err.status === 503 && err.code === "not_ready") {
      return { result: "starting", breaker: "reachable" };
    }
    // Startup just proved the daemon is unreachable, so trip the fast-skip
    // breaker — otherwise the first live hook spends the full turn budget on a
    // doomed request before the breaker would trip on its own.
    return { result: "unreachable", breaker: isDaemonUnreachableError(err) ? "unreachable" : "none" };
  }
}


function snapshotPiContext(ctx: any, options: PiContextSnapshotOptions = {}): PiContextSnapshot | null {
  const sessionKey = safeSessionKeyFromContext(ctx);
  if (!sessionKey) return null;
  const cwd = safeStringRead(() => ctx?.cwd, "");
  const hasUI = safeRead(() => ctx?.hasUI, undefined) === false;
  const ui = hasUI ? undefined : safeRead(() => ctx?.ui, undefined);
  const compact = safeRead(() => ctx?.compact, undefined);
  const includeSessionHistory = options.includeSessionHistory === true;
  return {
    sessionKey,
    cwd,
    entries: includeSessionHistory ? safeEntries(ctx) : [],
    branch: includeSessionHistory ? safeBranch(ctx) : [],
    notify: makeNotifier(ui, hasUI),
    setStatus: makeStatusSetter(ui, hasUI),
    compact: typeof compact === "function" ? () => compact.call(ctx) : undefined,
  };
}

function safeSessionKeyFromContext(ctx: any): string | null {
  try {
    return sessionKeyFromContext(ctx);
  } catch {
    return null;
  }
}

function makeNotifier(ui: unknown, hasUI: boolean): NotifyFn {
  if (hasUI || !isRecord(ui) || typeof ui.notify !== "function") {
    return () => undefined;
  }
  const notifyFn = ui.notify;
  return (message, level) => {
    try {
      notifyFn.call(ui, message, level);
    } catch {
      // Pi invalidates session-bound UI objects during reload/replacement. A
      // notification failure must not tear down Remnic's hooks.
    }
  };
}

function makeStatusSetter(ui: unknown, hasUI: boolean): PiContextSnapshot["setStatus"] {
  if (hasUI || !isRecord(ui) || typeof ui.setStatus !== "function") {
    return () => undefined;
  }
  const setStatusFn = ui.setStatus;
  return (key, value) => {
    try {
      setStatusFn.call(ui, key, value);
    } catch {
      // See makeNotifier: stale UI should not make extension startup fail.
    }
  };
}

function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function safeStringRead(read: () => unknown, fallback: string): string {
  const value = safeRead(read, fallback);
  return typeof value === "string" ? value : fallback;
}

function safeEntries(ctx: any): any[] {
  try {
    const entries = ctx.sessionManager?.getEntries?.();
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function safeBranch(ctx: any): any[] {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

function branchMessagesWithEntryIdentity(branch: any[]): unknown[] {
  const messages: unknown[] = [];
  for (const entry of branch) {
    const message = messageWithEntryIdentity(entry);
    if (message) messages.push(message);
  }
  return messages;
}

function messageWithEntryIdentity(entry: any): unknown | null {
  const message = entry?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return message ?? null;

  const source = isRecord(entry) ? entry : {};
  const enriched: Record<string, unknown> = { ...(message as Record<string, unknown>) };
  assignMissingIdentity(enriched, "entryId", source.id ?? source.entryId ?? source.entry_id);
  assignMissingIdentity(enriched, "timestamp", source.timestamp);
  assignMissingIdentity(enriched, "createdAt", source.createdAt ?? source.created_at);
  return enriched;
}

function assignMissingIdentity(target: Record<string, unknown>, field: string, value: unknown): void {
  if (target[field] !== undefined) return;
  if (typeof value === "string" && value.length > 0) {
    target[field] = value;
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    target[field] = value;
  }
}

function trimContext(value: string, budget: number): string {
  if (value.length <= budget) return value;
  if (budget <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, budget);
  return `${value.slice(0, budget - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}


export function isDaemonUnreachableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/Remnic request timed out/.test(err.message)) return true;
  // Retry-budget exhaustion means transient failures ate the whole per-turn
  // deadline inside requestWithRetry — the daemon is effectively unreachable
  // for this turn, so trip the breaker and cool down instead of burning another
  // full budget on the next hook (codex review). This error only arises from
  // transient connection failures, never from a semantic HTTP response.
  if (/Remnic request exceeded the \d+ms budget before retry/.test(err.message)) return true;
  // Multi-chunk observe throws its own budget-exceeded message when the shared
  // per-turn deadline is exhausted across chunks; that is also an effectively-
  // unreachable condition for the turn, so trip the breaker and fast-skip
  // subsequent turns instead of piling on more doomed chunked observes (cursor).
  if (/Remnic observe exceeded the per-turn budget of \d+ms/.test(err.message)) return true;
  return isTransientNetworkError(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notifyRecallDisabled(session: PiContextSnapshot): string {
  const message =
    "Remnic recall is paused for this process because timeouts delayed operations; " +
    "recall retries automatically after a 5 minute cooldown.";
  session.notify(message, "warning");
  return message;
}


async function executeRecallWithBreaker<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  breaker: RecallTimeoutBreaker,
  pi: PiApi,
  session: PiContextSnapshot,
  config: RemnicPiConfig,
  state: PiSessionState,
): Promise<T> {
  if (breaker.isTripped()) throw new RemnicRequestAbortedError();
  try {
    const result = await operation(breaker.signal);
    breaker.recordSuccess();
    return result;
  } catch (err) {
    if (!(breaker.isTripped() && err instanceof RemnicRequestAbortedError)) {
      const tripped = breaker.record(isRecallTimeoutError(err) ? "timeout" : "failure");
      if (tripped) {
        emitRecallTimeoutTrip(session, config, state, errorMessage(err), (data) => pi.appendEntry(STATE_CUSTOM_TYPE, data));
      }
    }
    throw err;
  }
}


function finiteTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export { textFromMessage };
