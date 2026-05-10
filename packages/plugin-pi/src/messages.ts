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
    if (message?.role === "user") {
      const text = textFromMessage(message);
      if (text.length > 0) return text;
    }
  }
  return "";
}

export function toObserveMessage(message: unknown): ObserveMessage | null {
  if (!message || typeof message !== "object") return null;
  const obj = message as PiMessage;
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

export function hashObservedMessage(message: ObserveMessage): string {
  return `${message.role}:${message.content}`;
}

export function summarizeMessages(messages: unknown[], maxChars: number): string {
  const chunks: string[] = [];
  let used = 0;
  for (const message of messages) {
    const text = textFromMessage(message);
    if (!text) continue;
    const role = typeof (message as PiMessage)?.role === "string" ? (message as PiMessage).role : "message";
    const line = `[${role}] ${text}`;
    const clipped = line.length + used > maxChars ? line.slice(0, Math.max(0, maxChars - used)) : line;
    if (clipped.length > 0) chunks.push(clipped);
    used += clipped.length;
    if (used >= maxChars) break;
  }
  return chunks.join("\n\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
  const parts: ObserveMessagePart[] = [];
  const content = message.content;
  if (Array.isArray(content)) {
    content.forEach((block, index) => {
      if (!block || typeof block !== "object") return;
      const obj = block as PiMessage;
      if (obj.type === "text" && typeof obj.text === "string") {
        parts.push({ ordinal: index, kind: "text", payload: { text: obj.text }, filePath: firstFilePath(obj.text) });
      }
      if (obj.type === "toolCall" && typeof obj.name === "string") {
        const filePath = filePathFromArgs(obj.arguments);
        parts.push({
          ordinal: index,
          kind: classifyToolCall(obj.name),
          payload: { name: obj.name, arguments: obj.arguments ?? {} },
          toolName: obj.name,
          filePath,
        });
      }
    });
  }
  if (parts.length === 0) {
    parts.push({ ordinal: 0, kind: "text", payload: { text: renderedContent }, filePath: firstFilePath(renderedContent) });
  }
  return parts;
}

function classifyToolCall(name: string): ObserveMessagePart["kind"] {
  if (name === "read") return "file_read";
  if (name === "write" || name === "edit") return "file_write";
  return "tool_call";
}

function filePathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as { path?: unknown; filePath?: unknown; file_path?: unknown }).path ??
    (args as { filePath?: unknown }).filePath ??
    (args as { file_path?: unknown }).file_path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstFilePath(text: string): string | null {
  const match = text.match(/(?:^|\s)([./~]?[\w.-]+(?:\/[\w .@()[\]-]+)+)/);
  return match?.[1] ?? null;
}
