// ---------------------------------------------------------------------------
// Claude parsed → ImportedMemory transform (issue #568 slice 3)
// ---------------------------------------------------------------------------
//
// Claude exports contain two distinct memory-worthy surfaces:
//
//   1. Project docs + `prompt_template` — durable personal context the user
//      explicitly pinned to a project. These are imported 1:1 by default;
//      each doc becomes one memory, and each project's prompt_template (if
//      non-empty) becomes one memory.
//   2. Conversations — per-conversation summaries, only emitted when the
//      caller opts in via `includeConversations: true`. The summary
//      concatenates human-side turns (user messages) so downstream
//      extraction has coherent content to score. One memory per conversation
//      keeps the footprint bounded.

import type { ImportedMemory } from "@remnic/core";

import type {
  ClaudeConversation,
  ClaudeProject,
  ClaudeProjectDoc,
  ParsedClaudeExport,
} from "./parser.js";
import { collectHumanTurnsFromConversation } from "./parser.js";

export const CLAUDE_SOURCE_LABEL = "claude";

export interface ClaudeTransformOptions {
  /** When true, emit conversation-summary memories. */
  includeConversations?: boolean;
  /** Optional cap on total memories emitted — primarily for tests. */
  maxMemories?: number;
  /** Max characters for a conversation summary. */
  maxConversationSummaryChars?: number;
}

const DEFAULT_CONVERSATION_SUMMARY_CHARS = 2000;

/**
 * Transform a parsed Claude export into `ImportedMemory[]`. Project docs are
 * emitted first (in parse order), then project prompt templates, then
 * conversation summaries when opted in.
 */
export function transformClaudeExport(
  parsed: ParsedClaudeExport,
  options: ClaudeTransformOptions = {},
): ImportedMemory[] {
  const out: ImportedMemory[] = [];
  const cap = options.maxMemories;

  for (const project of parsed.projects) {
    if (cap !== undefined && out.length >= cap) return out;
    const docs = Array.isArray(project.docs) ? project.docs : [];
    for (const doc of docs) {
      if (cap !== undefined && out.length >= cap) return out;
      const memory = docToImported(project, doc, parsed.filePath);
      if (memory) out.push(memory);
    }
    if (cap !== undefined && out.length >= cap) return out;
    const templateMemory = projectTemplateToImported(project, parsed.filePath);
    if (templateMemory) out.push(templateMemory);
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

function docToImported(
  project: ClaudeProject,
  doc: ClaudeProjectDoc,
  filePath: string | undefined,
): ImportedMemory | undefined {
  const content = typeof doc.content === "string" ? doc.content.trim() : "";
  if (content.length === 0) return undefined;
  const sourceTimestamp = doc.updated_at ?? doc.created_at;
  const metadata: Record<string, unknown> = { kind: "project_doc" };
  if (typeof doc.filename === "string" && doc.filename.length > 0) {
    metadata.filename = doc.filename;
  }
  if (typeof project.name === "string" && project.name.length > 0) {
    metadata.projectName = project.name;
  }
  if (typeof project.uuid === "string") {
    metadata.projectUuid = project.uuid;
  }
  return {
    content,
    sourceLabel: CLAUDE_SOURCE_LABEL,
    ...(doc.uuid !== undefined ? { sourceId: doc.uuid } : {}),
    ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    ...(filePath !== undefined ? { importedFromPath: filePath } : {}),
    metadata,
  };
}

function projectTemplateToImported(
  project: ClaudeProject,
  filePath: string | undefined,
): ImportedMemory | undefined {
  const template =
    typeof project.prompt_template === "string"
      ? project.prompt_template.trim()
      : "";
  if (template.length === 0) return undefined;
  const sourceTimestamp = project.updated_at ?? project.created_at;
  const metadata: Record<string, unknown> = { kind: "project_prompt_template" };
  if (typeof project.name === "string" && project.name.length > 0) {
    metadata.projectName = project.name;
  }
  if (typeof project.uuid === "string") {
    metadata.projectUuid = project.uuid;
  }
  return {
    content: template,
    sourceLabel: CLAUDE_SOURCE_LABEL,
    ...(project.uuid !== undefined ? { sourceId: project.uuid } : {}),
    ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    ...(filePath !== undefined ? { importedFromPath: filePath } : {}),
    metadata,
  };
}

function conversationToSummary(
  conversation: ClaudeConversation,
  filePath: string | undefined,
  maxChars: number,
): ImportedMemory | undefined {
  const turns = collectHumanTurnsFromConversation(conversation);
  if (turns.length === 0) return undefined;

  const title =
    typeof conversation.name === "string" ? conversation.name.trim() : "";
  const titleLine = title.length > 0 ? `Conversation: ${title}\n\n` : "";
  const body = turns.map((t) => `- ${t.content}`).join("\n");
  let content = titleLine + body;
  if (content.length > maxChars) {
    // Reserve up to 3 chars for the "..." suffix, but truncate the suffix
    // itself when `maxChars` is below 3 so the final content.length is
    // strictly ≤ maxChars. Cursor reviews on PR #598 flagged both the
    // long-title case (titleLine alone exceeds maxChars) and the
    // pathologically small cap (maxChars < suffix.length).
    const effectiveSuffix = maxChars >= 3 ? "..." : "";
    if (titleLine.length + effectiveSuffix.length >= maxChars) {
      content =
        titleLine.slice(0, Math.max(0, maxChars - effectiveSuffix.length)) +
        effectiveSuffix;
    } else {
      const remaining = maxChars - titleLine.length - effectiveSuffix.length;
      const bodyTruncated = body.slice(0, Math.max(0, remaining));
      content = titleLine + bodyTruncated + effectiveSuffix;
    }
  }
  // Codex review on PR #598 — when per-turn timestamps are absent, fall
  // back to the conversation-level `updated_at`/`created_at`. Without
  // this fallback, exports that omit message-level timestamps lose their
  // original time metadata entirely, which makes old conversations look
  // newly imported and skews recency-based retrieval.
  const sourceTimestamp =
    firstTimestamp(turns) ?? conversation.updated_at ?? conversation.created_at;
  const metadata: Record<string, unknown> = {
    kind: "conversation_summary",
    humanTurns: turns.length,
  };
  if (title.length > 0) metadata.title = title;
  return {
    content,
    sourceLabel: CLAUDE_SOURCE_LABEL,
    ...(typeof conversation.uuid === "string"
      ? { sourceId: conversation.uuid }
      : {}),
    ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    ...(filePath !== undefined ? { importedFromPath: filePath } : {}),
    metadata,
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
