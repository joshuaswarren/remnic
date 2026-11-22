//
//
//
//

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Message inside a Claude conversation. `sender` is either "human" or
 * "assistant"; older exports used `role` instead.
 */
export interface ClaudeConversationMessage {
  uuid?: string;
  sender?: "human" | "assistant" | string;
  role?: "human" | "assistant" | string;
  /** Plain-text transcript of this message. */
  text?: string;
  /** Newer exports expose structured content blocks. */
  content?: Array<{ type?: string; text?: string }>;
  created_at?: string;
  updated_at?: string;
}

export interface ClaudeConversation {
  uuid?: string;
  name?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeConversationMessage[];
  /** Some exports also expose `messages` alongside chat_messages. */
  messages?: ClaudeConversationMessage[];
  /** Associated project id, when the conversation lives inside a Project. */
  project_uuid?: string;
}

export interface ClaudeProjectDoc {
  uuid?: string;
  filename?: string;
  content?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ClaudeProject {
  uuid?: string;
  name?: string;
  description?: string;
  /** User-authored free-form instructions for the project. */
  prompt_template?: string;
  docs?: ClaudeProjectDoc[];
  created_at?: string;
  updated_at?: string;
}

export interface ParsedClaudeExport {
  conversations: ClaudeConversation[];
  projects: ClaudeProject[];
  /** Source path the export came from (for provenance). */
  filePath?: string;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface ClaudeParseOptions {
  strict?: boolean;
  filePath?: string;
}

/**
 * Parse a raw Claude export payload. Accepts:
 *   - a JSON string (`conversations.json`, `projects.json`, or a combined
 *     bundle like `{conversations, projects}`)
 *   - an already-parsed object or array.
 *
 * Returns the unified `ParsedClaudeExport`. Non-export payloads throw in
 * strict mode; otherwise the returned struct holds empty arrays so the
 * transform layer can no-op.
 */
export function parseClaudeExport(
  input: unknown,
  options: ClaudeParseOptions = {},
): ParsedClaudeExport {
  if (input === undefined || input === null) {
    throw new Error(
      "Claude import requires a --file argument pointing at conversations.json, " +
        "projects.json, or the exported bundle.",
    );
  }
  const raw = coerceJson(input);
  const result: ParsedClaudeExport = {
    conversations: [],
    projects: [],
    ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
  };

  if (Array.isArray(raw)) {
    if (raw.length === 0) return result;
    const first = raw[0];
    if (looksLikeConversation(first)) {
      for (const entry of raw) {
        if (looksLikeConversation(entry)) {
          result.conversations.push(entry as ClaudeConversation);
        } else if (options.strict) {
          throw new Error("Non-conversation entry in conversations array");
        }
      }
      return result;
    }
    if (looksLikeProject(first, { strict: options.strict })) {
      for (const entry of raw) {
        if (looksLikeProject(entry, { strict: options.strict })) {
          result.projects.push(entry as ClaudeProject);
        } else if (options.strict) {
          throw new Error("Non-project entry in projects array");
        }
      }
      return result;
    }
    if (options.strict) {
      throw new Error(
        "Unknown Claude export array shape (neither conversations nor projects).",
      );
    }
    return result;
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    let sawKnownSection = false;
    const hasConversationsSection = Object.prototype.hasOwnProperty.call(
      obj,
      "conversations",
    );
    const convs = obj.conversations;
    if (Array.isArray(convs)) {
      sawKnownSection = true;
      for (const entry of convs) {
        if (looksLikeConversation(entry)) {
          result.conversations.push(entry as ClaudeConversation);
        } else if (options.strict) {
          throw new Error("Non-conversation entry in conversations array");
        }
      }
    } else if (hasConversationsSection && options.strict) {
      throw new Error("Claude export conversations section must be an array.");
    }
    const hasProjectsSection = Object.prototype.hasOwnProperty.call(
      obj,
      "projects",
    );
    const projects = obj.projects;
    if (Array.isArray(projects)) {
      sawKnownSection = true;
      for (const entry of projects) {
        if (looksLikeProject(entry, { strict: options.strict })) {
          result.projects.push(entry as ClaudeProject);
        } else if (options.strict) {
          throw new Error("Non-project entry in projects array");
        }
      }
    } else if (hasProjectsSection && options.strict) {
      throw new Error("Claude export projects section must be an array.");
    }
    if (!sawKnownSection && options.strict) {
      throw new Error(
        "Unknown Claude export object shape: expected 'conversations' or 'projects' keys.",
      );
    }
    return result;
  }

  throw new Error(
    "Claude export must be a JSON array or object; received " + typeof raw,
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function coerceJson(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch (err) {
      throw new Error(
        `Claude export is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return input;
}

function looksLikeConversation(value: unknown): value is ClaudeConversation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.chat_messages)) return true;
  if (Array.isArray(v.messages)) return true;
  return false;
}

function looksLikeProject(
  value: unknown,
  opts: { strict?: boolean } = {},
): value is ClaudeProject {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.prompt_template === "string") return true;
  if (Array.isArray(v.docs)) return true;
  if (opts.strict) return false;
  if (
    typeof v.name === "string" &&
    !Array.isArray(v.chat_messages) &&
    !Array.isArray(v.messages)
  ) {
    return true;
  }
  return false;
}

/**
 * Walk a conversation and return only human-authored user turns in
 * chronological order. Exported so the transform layer can build conversation
 * summaries from the same source of truth.
 */
export function collectHumanTurnsFromConversation(
  conversation: ClaudeConversation,
): Array<{ content: string; createdAt?: string }> {
  const collected: Array<{ content: string; createdAt?: string }> = [];
  let messages: ClaudeConversationMessage[] = [];
  if (Array.isArray(conversation.chat_messages) && conversation.chat_messages.length > 0) {
    messages = conversation.chat_messages;
  } else if (Array.isArray(conversation.messages) && conversation.messages.length > 0) {
    messages = conversation.messages;
  }
  for (const msg of messages) {
    if (!isHumanSender(msg)) continue;
    const text = extractMessageText(msg);
    if (text) {
      collected.push({
        content: text,
        ...(typeof msg.created_at === "string" && msg.created_at.length > 0
          ? { createdAt: msg.created_at }
          : {}),
      });
    }
  }
  return collected;
}

function isHumanSender(msg: ClaudeConversationMessage): boolean {
  const sender = msg.sender ?? msg.role;
  return sender === "human" || sender === "user";
}

function extractMessageText(
  msg: ClaudeConversationMessage,
): string | undefined {
  if (Array.isArray(msg.content)) {
    const joined = msg.content
      .filter((b) => !b.type || b.type === "text")
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .filter((s) => s.length > 0)
      .join("\n")
      .trim();
    if (joined.length > 0) return joined;
  }
  if (typeof msg.text === "string") {
    const trimmed = msg.text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}
