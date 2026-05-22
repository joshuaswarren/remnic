import { createHash } from "node:crypto";

import { parsePiMessageParts, type LcmMessagePartInput } from "@remnic/core";

import type { ObserveMessage, ObserveMessagePart } from "./client.js";

type PiMessage = Record<string, unknown>;

export function sessionKeyFromContext(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  const id = ctx.sessionManager?.getSessionId?.();
  return id && id.trim().length > 0 ? `pi:${id}` : "pi:default";
}

export function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const obj = message as PiMessage;
  const role = typeof obj.role === "string" ? obj.role : "message";
  if (role === "bashExecution") {
    const command = typeof obj.command === "string" ? obj.command : "";
    const output = typeof obj.output === "string" ? obj.output : "";
    return [`Ran ${command}`, output].filter(Boolean).join("\n");
  }
  return textFromContent(obj.content).trim();
}

export function latestUserQuery(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as PiMessage;
    if (isExcludedFromContext(message) || isRemnicInjected(message)) continue;
    if (message?.role === "user") {
      const text = textFromMessage(message);
      if (text.length > 0) return text;
    }
  }
  return "";
}

export function latestUserRecallTarget(
  messages: unknown[],
): { query: string; dedupeKey: string } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as PiMessage;
    if (isExcludedFromContext(message) || isRemnicInjected(message)) continue;
    if (message?.role !== "user") continue;
    const query = textFromMessage(message);
    if (query.length === 0) continue;
    const identity = stableObservedMessageIdentity(message);
    return {
      query,
      dedupeKey: identity ? `message:${identity}:${query}` : `query:${query}`,
    };
  }
  return null;
}

export function toObserveMessage(message: unknown): ObserveMessage | null {
  if (!message || typeof message !== "object") return null;
  const obj = message as PiMessage;
  if (isExcludedFromContext(obj) || isRemnicInjected(obj)) return null;
  const role = obj.role === "user" || obj.role === "bashExecution" ? "user" : "assistant";
  const content = textFromMessage(obj);
  if (content.length === 0) return null;
  return {
    role,
    content,
    sourceFormat: "pi",
    rawContent: obj,
    parts: partsFromMessage(obj, content),
  };
}

export function hashObservedMessage(message: ObserveMessage, sessionKey = "", identity = "content"): string {
  return createHash("sha256")
    .update(sessionKey)
    .update("\0")
    .update(message.role)
    .update("\0")
    .update(identity)
    .update("\0")
    .update(message.content)
    .digest("hex");
}

export function observedMessageDedupeKey(
  message: ObserveMessage,
  sessionKey = "",
): string | null {
  const identity = stableObservedMessageIdentity(message.rawContent);
  return identity ? hashObservedMessage(message, sessionKey, identity) : null;
}

export function summarizeMessages(messages: unknown[], maxChars: number): string {
  const chunks: string[] = [];
  let used = 0;
  for (const message of messages) {
    if (isExcludedFromContext(message) || isRemnicInjected(message)) continue;
    const text = textFromMessage(message);
    if (!text) continue;
    const role = typeof (message as PiMessage)?.role === "string" ? (message as PiMessage).role : "message";
    const line = `[${role}] ${text}`;
    const separatorLength = chunks.length > 0 ? 2 : 0;
    const remaining = maxChars - used - separatorLength;
    if (remaining <= 0) break;
    const clipped = line.length > remaining ? line.slice(0, remaining) : line;
    if (clipped.length > 0) chunks.push(clipped);
    used += separatorLength + clipped.length;
    if (used >= maxChars) break;
  }
  return chunks.join("\n\n");
}

export function isExcludedFromContext(message: unknown): boolean {
  return !!message && typeof message === "object" && (message as PiMessage).excludeFromContext === true;
}

export function isRemnicInjected(message: unknown): boolean {
  return !!message && typeof message === "object" && (message as PiMessage).remnicInjected === true;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const obj = block as PiMessage;
    if (obj.type === "text" && typeof obj.text === "string") chunks.push(obj.text);
    if (obj.type === "toolCall" && typeof obj.name === "string") {
      chunks.push(`Tool ${obj.name} called with ${JSON.stringify(obj.arguments ?? {})}`);
    }
  }
  return chunks.join("\n");
}

function partsFromMessage(message: PiMessage, renderedContent: string): ObserveMessagePart[] {
  return parsePiMessageParts(message, {
    renderedContent,
    allowRenderedFallback: true,
  }).map(toObserveMessagePart);
}

function toObserveMessagePart(part: LcmMessagePartInput): ObserveMessagePart {
  return {
    ordinal: part.ordinal ?? undefined,
    kind: part.kind,
    payload: part.payload,
    toolName: part.toolName ?? part.tool_name ?? undefined,
    filePath: part.filePath ?? part.file_path ?? undefined,
    createdAt: part.createdAt ?? part.created_at ?? undefined,
  };
}

function stableObservedMessageIdentity(rawContent: unknown): string | null {
  if (rawContent && typeof rawContent === "object") {
    const obj = rawContent as PiMessage;
    const fields = [
      "id",
      "entryId",
      "entry_id",
      "messageId",
      "message_id",
      "turnId",
      "turn_id",
      "timestamp",
      "createdAt",
      "created_at",
    ];
    for (const field of fields) {
      const value = obj[field];
      if (typeof value === "string" && value.length > 0) return `${field}:${value}`;
      if (typeof value === "number" && Number.isFinite(value)) return `${field}:${value}`;
    }
  }
  return null;
}
