// ---------------------------------------------------------------------------
// ChatGPT parsed → ImportedMemory transform (issue #568 slice 2)
// ---------------------------------------------------------------------------
//
// Two shapes of memory come out of a ChatGPT export:
//
//   1. Saved memories — first-person facts the user confirmed. 1:1 mapping:
//      every entry becomes one `ImportedMemory`. This is the default.
//   2. Conversation summaries — only produced when the caller opts in via
//      `includeConversations: true`. Each conversation is reduced to a
//      single "user said X, Y, Z" summary (user-side turns concatenated),
//      not uploaded verbatim. The rationale is that the conversation
//      bodies mix transient and durable content, and the extraction
//      pipeline downstream will score them — but we need SOMETHING
//      coherent to hand it. One memory per conversation keeps the import
//      footprint bounded when users have thousands of chats.
//
// The adapter runs `parse()` first, then `transform()` produces the final
// `ImportedMemory[]`. Provenance (sourceLabel, importedFromPath, metadata)
// is attached here; `runImporter` stamps `importedAt`.

import type { ImportedMemory } from "@remnic/core";

import type {
  ChatGPTConversation,
  ChatGPTSavedMemory,
  ParsedChatGPTExport,
} from "./parser.js";
import {
  collectUserTurnsFromConversation,
  normalizeChatGPTTimestamp,
} from "./parser.js";

export const CHATGPT_SOURCE_LABEL = "chatgpt";

export interface ChatGPTTransformOptions {
  /** When true, produce conversation-summary memories in addition to saved memories. */
  includeConversations?: boolean;
  /** Optional cap on total memories emitted — primarily for tests. */
  maxMemories?: number;
  /** Maximum characters for a conversation summary memory. */
  maxConversationSummaryChars?: number;
}

const DEFAULT_CONVERSATION_SUMMARY_CHARS = 2000;

/**
 * Transform a parsed ChatGPT export into `ImportedMemory[]`.
 * Saved memories are emitted first (in parse order), then conversation
 * summaries when opted in.
 */
export function transformChatGPTExport(
  parsed: ParsedChatGPTExport,
  options: ChatGPTTransformOptions = {},
): ImportedMemory[] {
  const out: ImportedMemory[] = [];
  const cap = options.maxMemories;

  for (const entry of parsed.savedMemories) {
    if (cap !== undefined && out.length >= cap) return out;
    const memory = savedMemoryToImported(entry, parsed.filePath);
    if (memory) out.push(memory);
  }

  if (options.includeConversations) {
    const maxSummaryChars =
      options.maxConversationSummaryChars ?? DEFAULT_CONVERSATION_SUMMARY_CHARS;
    for (const conversation of parsed.conversations) {
      if (cap !== undefined && out.length >= cap) return out;
      const summary = conversationToSummary(
        conversation,
        parsed.filePath,
        maxSummaryChars,
      );
      if (summary) out.push(summary);
    }
  }
  return out;
}

function savedMemoryToImported(
  entry: ChatGPTSavedMemory,
  filePath: string | undefined,
): ImportedMemory | undefined {
  const content = entry.content.trim();
  if (content.length === 0) return undefined;
  const sourceTimestamp =
    normalizeChatGPTTimestamp(entry.updated_at) ??
    normalizeChatGPTTimestamp(entry.created_at);
  return {
    content,
    sourceLabel: CHATGPT_SOURCE_LABEL,
    ...(entry.id !== undefined ? { sourceId: entry.id } : {}),
    ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    ...(filePath !== undefined ? { importedFromPath: filePath } : {}),
    metadata: buildMetadata(entry),
  };
}

function buildMetadata(entry: ChatGPTSavedMemory): Record<string, unknown> {
  const meta: Record<string, unknown> = { kind: "saved_memory" };
  if (entry.pinned === true) meta.pinned = true;
  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    meta.tags = [...entry.tags];
  }
  return meta;
}

function conversationToSummary(
  conversation: ChatGPTConversation,
  filePath: string | undefined,
  maxChars: number,
): ImportedMemory | undefined {
  const userTurns = collectUserTurnsFromConversation(conversation);
  if (userTurns.length === 0) return undefined;

  const title = typeof conversation.title === "string" ? conversation.title.trim() : "";
  const titleLine = title.length > 0 ? `Conversation: ${title}\n\n` : "";
  const body = userTurns.map((t) => `- ${t.content}`).join("\n");
  let content = titleLine + body;
  if (content.length > maxChars) {
    const effectiveMaxChars = Math.max(0, Math.floor(maxChars));
    const suffix = effectiveMaxChars >= 3 ? "..." : "";
    const available = effectiveMaxChars - suffix.length;
    if (titleLine.length + suffix.length >= effectiveMaxChars) {
      content = titleLine.slice(0, Math.max(0, available)) + suffix;
    } else {
      const remaining = available - titleLine.length;
      const bodyTruncated = body.slice(0, Math.max(0, remaining));
      content = titleLine + bodyTruncated + suffix;
    }
  }

  const sourceTimestamp = firstTimestamp(userTurns)
    ?? normalizeChatGPTTimestamp(conversation.update_time)
    ?? normalizeChatGPTTimestamp(conversation.create_time);
  return {
    content,
    sourceLabel: CHATGPT_SOURCE_LABEL,
    ...(typeof conversation.id === "string" ? { sourceId: conversation.id } : {}),
    ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    ...(filePath !== undefined ? { importedFromPath: filePath } : {}),
    metadata: {
      kind: "conversation_summary",
      ...(title.length > 0 ? { title } : {}),
      userTurns: userTurns.length,
    },
  };
}

function firstTimestamp(
  turns: Array<{ content: string; createdAt?: string }>,
): string | undefined {
  for (const turn of turns) {
    if (typeof turn.createdAt === "string" && turn.createdAt.length > 0) {
      return turn.createdAt;
    }
  }
  return undefined;
}
