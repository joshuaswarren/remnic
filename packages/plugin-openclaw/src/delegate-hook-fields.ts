/**
 * Reading the untyped hook payloads OpenClaw hands the delegate runtime.
 *
 * Every function here is pure: it takes an `event` / `ctx` pair (or a daemon
 * response) and answers one question about it. They live beside the runtime so
 * the runtime file stays about the memory loop itself.
 */

import type {
  RecallContextComposition,
  RecallContextDegradation,
} from "@remnic/core";

import { extractTextContent } from "./transcript-turns.js";

/**
 * The daemon caps request bodies (128 KiB by default), and a host may hand the
 * hook its whole assembled prompt. The current turn is at the END of such a
 * prompt, so the query keeps the tail.
 */
const MAX_RECALL_QUERY_CHARS = 1_500;

export function sessionKeyFrom(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string {
  const fromCtx = ctx?.sessionKey;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const fromEvent = event?.sessionKey;
  if (typeof fromEvent === "string" && fromEvent.length > 0) return fromEvent;
  return "default";
}

export function lifecycleSessionKeyFrom(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | undefined {
  const fromEvent = event?.sessionKey;
  if (fromEvent !== undefined) {
    return typeof fromEvent === "string" && fromEvent.length > 0 ? fromEvent : undefined;
  }
  return sessionKeyFrom(event, ctx);
}

export function recallQueryFrom(
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
export function cwdFrom(
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

export function readRecallDegradation(candidate: object): RecallContextDegradation | undefined {
  if (!("degradation" in candidate)) return undefined;
  const value = candidate.degradation;
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.state !== "string" || typeof rec.reason !== "string") return undefined;
  return value as RecallContextDegradation;
}

export function readContextComposition(
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
