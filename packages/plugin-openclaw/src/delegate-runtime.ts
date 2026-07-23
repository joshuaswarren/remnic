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
  recallTimeoutMs: number;
  observeTimeoutMs: number;
  flushTimeoutMs: number;
}

interface MinimalHookApi {
  on(hook: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown): void;
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
  if (typeof event.prompt === "string" && event.prompt.trim().length > 0) {
    return event.prompt;
  }
  if (Array.isArray(event.messages)) {
    const turn = extractLastTurn(event.messages as Array<Record<string, unknown>>);
    for (const message of turn) {
      if (message.role === "user") {
        const text = extractTextContent(message);
        if (text.trim().length > 0) return text;
      }
    }
  }
  return "";
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
  api: MinimalHookApi,
  options: DelegateRuntimeOptions,
): void {
  const { target, namespace } = options;
  if (options.passive) {
    log.info(
      `[${options.serviceId}] bridge mode delegate: memory slot not owned — passive, no hooks registered`,
    );
    return;
  }

  if (options.allowPromptInjection) {
    const recallHandler = async (
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> => {
      const query = recallQueryFrom(event);
      if (query.trim().length < 5) return undefined;
      const sessionKey = sessionKeyFrom(event, ctx);
      try {
        const response = await postJson(
          target,
          "/engram/v1/recall",
          withNamespace(namespace, { query, sessionKey, mode: "auto" }),
          options.recallTimeoutMs,
        );
        const context = response?.context;
        if (typeof context !== "string" || context.trim().length === 0) {
          return undefined;
        }
        const prompt = `${MEMORY_CONTEXT_HEADER}\n\n${context}`;
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
    api.on("before_prompt_build", recallHandler);
    api.on("before_agent_start", recallHandler);
  } else {
    log.info(
      `[${options.serviceId}] bridge mode delegate: prompt injection disabled by hooks policy`,
    );
  }

  api.on("agent_end", async (event, ctx) => {
    if (event.success !== true || !Array.isArray(event.messages)) return;
    if (event.messages.length === 0) return;
    const sessionKey = sessionKeyFrom(event, ctx);
    const turn = extractLastTurn(event.messages as Array<Record<string, unknown>>)
      .map((message) => ({
        role: message.role,
        content: extractTextContent(message),
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
        withNamespace(namespace, { sessionKey, messages: turn }),
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
  api.on("before_reset", flushHandler);
  api.on("session_end", flushHandler);

  log.info(
    `[${options.serviceId}] bridge mode delegate: memory loop backed by daemon at ` +
      `${target.host}:${target.port} (embedded orchestrator skipped; tools/CLI/surfaces stay daemon-side)`,
  );
}
