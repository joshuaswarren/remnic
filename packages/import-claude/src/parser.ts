// ---------------------------------------------------------------------------
// Claude.ai data-export parser (issue #568 slice 3)
// ---------------------------------------------------------------------------
//
// Claude.ai's "Export data" feature produces a ZIP containing several JSON
// files. The two relevant to memory import are:
//
//   1. `conversations.json` — array of Conversation objects. Each has a
//      `chat_messages` array with `sender` (human/assistant) and `text` (plus
//      `content` blocks in newer exports). Text content is plain, not the
//      graph shape ChatGPT uses.
//   2. `projects.json` — array of Project objects, each with an optional
//      `prompt_template` and a list of `docs` (the durable context documents
//      the user attached to the project). These are high-signal personal
//      artifacts and are imported as one memory per doc / project.
//
// The parser accepts either file individually (JSON text or object) or a
// combined bundle object (`{ conversations: [...], projects: [...] }`) used
// by the future bundle-auto-detect flow (PR 7).
//
// We do NOT read ZIP archives here — the CLI reads the file contents and
// passes them in. Synthetic fixtures in `fixtures/` mirror the real shapes.

// ---------------------------------------------------------------------------
// Raw export shapes (subset we care about)
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

/**
 * Unified parsed shape passed into `transform()`.
 */
export interface ParsedClaudeExport {
  conversations: ClaudeConversation[];
  projects: ClaudeProject[];
  /** Source path the export came from (for provenance). */
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Public parse API
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
  // Codex review on PR #598 — missing input (undefined / null) must NEVER
  // succeed as an empty import. The CLI passes `undefined` when `--file`
  // is omitted; silently returning a zero-memory success would make
  // `remnic import --adapter claude` without --file look healthy in
  // automation logs while the user's export was never read.
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

  // Shape 1: a top-level array.
  //   - `conversations.json` is an array of conversations.
  //   - `projects.json` is an array of projects.
  // We branch on the first element's shape.
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

  // Shape 2: an object. Look for the known keys.
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
    // Strict mode: if the object has neither `conversations` nor `projects`,
    // bail rather than silently returning an empty struct. Non-strict mode
    // keeps the lenient behavior to survive future-shape changes.
    if (!sawKnownSection && options.strict) {
      throw new Error(
        "Unknown Claude export object shape: expected 'conversations' or 'projects' keys.",
      );
    }
    return result;
  }

  // Codex review on PR #598 — primitive payloads (numbers, booleans,
  // strings, etc.) must always throw regardless of strict mode. A silent
  // empty result on garbage input would let automation mistake a broken
  // import for a healthy zero-memory run.
  throw new Error(
    "Claude export must be a JSON array or object; received " + typeof raw,
  );
}

// ---------------------------------------------------------------------------
// Helpers
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
  // Every conversation has either chat_messages or messages.
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
  // Projects are recognised by the presence of `prompt_template` OR `docs`
  // — unambiguous structural signals unique to project exports.
  if (typeof v.prompt_template === "string") return true;
  if (Array.isArray(v.docs)) return true;
  // Codex review on PR #598 — the `name`-only fallback is too loose for
  // strict mode. An arbitrary array like `[{"name": "foo"}]` would slip
  // past strict validation and produce empty imports. In strict mode we
  // require an unambiguous project signal (prompt_template or docs) and
  // reject name-only entries. Non-strict mode keeps the lenient fallback
  // for future-shape safety.
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
  // Prefer chat_messages when it has entries; fall back to the legacy
  // `messages` field. `??` alone is insufficient because an empty
  // `chat_messages` array is non-null but has no content — without the
  // length check, we would miss turns that only live in the legacy
  // `messages` array. Cursor review on PR #598.
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
  // Prefer structured content blocks (newer exports).
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
