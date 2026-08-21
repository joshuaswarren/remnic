// ---------------------------------------------------------------------------
// ChatGPT data-export parser (issue #568 slice 2)
// ---------------------------------------------------------------------------
//
// OpenAI publishes each account's export as a ZIP. Inside are several JSON
// files; this parser understands the two that carry durable user-level
// content:
//
//   1. Saved memories ("memories" in OpenAI parlance). Location varies by
//      export vintage — we accept any of:
//         - a top-level `memory` array (current 2026 shape)
//         - a top-level `memories` array (earlier 2024/2025 shapes)
//         - a `"memory"` section inside `user.json` (some exports embed it)
//      Each record is a single first-person fact the user confirmed.
//   2. `conversations.json` — array of `Conversation` objects, each holding
//      a graph of messages keyed by id with parent links. Bulk messages are
//      NOT imported by default; a `--include-conversations` opt-in produces
//      one memory per conversation summarizing the user-side turns.
//
// The parser accepts either the raw JSON text of a specific file OR a bundle
// object (already-parsed envelope) that contains the known keys. This lets
// the CLI pass either the plain `conversations.json` contents or a combined
// manifest when a future bundle-auto-detect (PR 7) lands.
//
// We do not read ZIP archives directly here — the CLI parses the JSON
// contents of whichever file the user points at with `--file`. A follow-up
// may add a ZIP-aware reader; until then, users unzip manually.

// ---------------------------------------------------------------------------
// Raw export shapes (subset we care about)
// ---------------------------------------------------------------------------

/**
 * A single saved memory entry. OpenAI has changed the shape several times;
 * we accept the union of fields observed across 2024-2026 exports.
 */
export interface ChatGPTSavedMemory {
  /** Stable identifier — uuid in recent exports, numeric string in older ones. */
  id?: string;
  /** The memory body. Required. */
  content: string;
  /** ISO 8601 or epoch create timestamp. */
  created_at?: string | number;
  /** ISO 8601 or epoch last-update timestamp, if different from created_at. */
  updated_at?: string | number;
  /** Soft-delete flag seen in 2025+ exports. When true, we skip the record. */
  deleted?: boolean;
  /** Whether the memory is pinned / manually curated. */
  pinned?: boolean;
  /** Tags the user applied to the memory. */
  tags?: string[];
}

export interface ChatGPTConversationMessage {
  /** Message id. */
  id?: string;
  /** Author role: user / assistant / system / tool. */
  author?: { role?: string; name?: string | null };
  /** Content envelope — we read `parts[]` for text content. */
  content?: { parts?: unknown[]; content_type?: string } | null;
  create_time?: number | string | null;
  update_time?: number | string | null;
  parent?: string | null;
}

export interface ChatGPTConversationNode {
  id: string;
  message?: ChatGPTConversationMessage | null;
  parent?: string | null;
  children?: string[];
}

export interface ChatGPTConversation {
  id?: string;
  title?: string;
  create_time?: number | string | null;
  update_time?: number | string | null;
  /** Messages by id. Present in 2023+ conversation exports. */
  mapping?: Record<string, ChatGPTConversationNode> | null;
  /** Some older exports inline messages as an array instead. */
  messages?: ChatGPTConversationMessage[];
  /** Root message id (for graph traversal). */
  current_node?: string | null;
}

/**
 * Unified parsed shape we pass into `transform()`. Holds both saved memories
 * and (optionally) conversations; either may be empty.
 */
export interface ParsedChatGPTExport {
  savedMemories: ChatGPTSavedMemory[];
  conversations: ChatGPTConversation[];
  /** Source path the export came from (for provenance). */
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Public parse API
// ---------------------------------------------------------------------------

export interface ChatGPTParseOptions {
  /** When true, throw on any validation failure instead of skipping. */
  strict?: boolean;
  /** File path of the source — preserved for provenance in transformed memories. */
  filePath?: string;
}

/**
 * Parse a raw export payload. Accepts either:
 *   - A JSON string (common CLI path — the CLI reads the file contents).
 *   - An already-parsed object or array (`JSON.parse` result).
 *
 * Returns the unified `ParsedChatGPTExport`. Non-export payloads throw a
 * descriptive error; silently ignoring them would mask user errors
 * (CLAUDE.md rule 51).
 */
export function parseChatGPTExport(
  input: unknown,
  options: ChatGPTParseOptions = {},
): ParsedChatGPTExport {
  // File-backed adapter contract: `runImportCommand` passes `undefined`
  // when `--file` is omitted. ChatGPT is a file-only importer — a
  // missing payload MUST surface as a user-facing error rather than
  // silently succeeding with 0 memories. Codex review on PR #595.
  if (input === undefined || input === null) {
    throw new Error(
      "The 'chatgpt' importer requires a file. Pass `--file <path>` pointing at " +
        "your ChatGPT data-export `memory.json` or `conversations.json`.",
    );
  }
  const raw = coerceJson(input);
  const result: ParsedChatGPTExport = {
    savedMemories: [],
    conversations: [],
    ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
  };

  // Shape 1: a top-level array. ChatGPT's `conversations.json` is literally
  // an array of conversations. Older memory exports are also arrays (each
  // entry a ChatGPTSavedMemory). A leading tombstone / malformed element
  // (null, {}, etc.) would defeat a `raw[0]`-only classifier and cause us
  // to silently drop every later valid entry. Scan the full array for the
  // first recognized shape instead. Codex review on PR #595.
  if (Array.isArray(raw)) {
    if (raw.length === 0) return result;
    let classification: "conversation" | "memory" | undefined;
    for (const entry of raw) {
      if (looksLikeConversation(entry)) {
        classification = "conversation";
        break;
      }
      if (looksLikeSavedMemory(entry)) {
        classification = "memory";
        break;
      }
    }
    if (classification === "conversation") {
      for (const entry of raw) {
        if (looksLikeConversation(entry)) {
          result.conversations.push(entry as ChatGPTConversation);
        } else if (options.strict) {
          throw new Error("Non-conversation entry in conversations array");
        }
      }
      return result;
    }
    if (classification === "memory") {
      for (const entry of raw) {
        const mem = normalizeSavedMemory(entry, options.strict);
        if (mem) result.savedMemories.push(mem);
      }
      return result;
    }
    if (options.strict) {
      throw new Error(
        "Unknown ChatGPT export array shape (neither memories nor conversations).",
      );
    }
    return result;
  }

  // Shape 2: an object. We look for the known keys.
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    let sawKnownSection = false;
    // Saved memories — accept `memory`, `memories`, or nested `user.memory`.
    for (const key of ["memory", "memories"] as const) {
      const v = obj[key];
      if (Array.isArray(v)) {
        sawKnownSection = true;
        for (const entry of v) {
          const mem = normalizeSavedMemory(entry, options.strict);
          if (mem) result.savedMemories.push(mem);
        }
      }
    }
    if (obj.user && typeof obj.user === "object") {
      const userMem = (obj.user as Record<string, unknown>).memory;
      if (Array.isArray(userMem)) {
        sawKnownSection = true;
        for (const entry of userMem) {
          const mem = normalizeSavedMemory(entry, options.strict);
          if (mem) result.savedMemories.push(mem);
        }
      }
    }
    // Conversations — top-level `conversations` array is the canonical shape.
    const convs = obj.conversations;
    if (Array.isArray(convs)) {
      sawKnownSection = true;
      for (const entry of convs) {
        if (looksLikeConversation(entry)) {
          result.conversations.push(entry as ChatGPTConversation);
        } else if (options.strict) {
          throw new Error("Non-conversation entry in conversations array");
        }
      }
    }
    // Strict mode: if the object has none of the recognized sections, bail
    // rather than silently returning an empty result. Non-strict mode keeps
    // the lenient "returns empty struct" behavior for future-shape safety.
    if (!sawKnownSection && options.strict) {
      throw new Error(
        "Unknown ChatGPT export object shape: expected one of 'memory', " +
          "'memories', 'user.memory', or 'conversations' keys.",
      );
    }
    return result;
  }

  // Primitive / unparseable payloads must NEVER return an empty success —
  // that would mask operator mistakes and allow automation to treat a
  // broken import as a clean "0 memories" import. Throw regardless of
  // strict mode. Codex review on PR #595.
  throw new Error(
    "ChatGPT export must be a JSON array or object; received " + typeof raw,
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
        `ChatGPT export is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return input;
}

function looksLikeSavedMemory(value: unknown): value is ChatGPTSavedMemory {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // At minimum a memory has a content string. Some exports use `text`
  // instead — we normalize in `normalizeSavedMemory`.
  if (typeof v.content === "string" && v.content.length > 0) return true;
  if (typeof v.text === "string" && v.text.length > 0) return true;
  return false;
}

function looksLikeConversation(value: unknown): value is ChatGPTConversation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // A conversation always has either `mapping` (new shape) or `messages`
  // (legacy shape). Title alone is insufficient because saved-memory
  // exports may also carry a `title` field in some vintages.
  if (v.mapping && typeof v.mapping === "object") return true;
  if (Array.isArray(v.messages)) return true;
  return false;
}

function normalizeSavedMemory(
  value: unknown,
  strict: boolean | undefined,
): ChatGPTSavedMemory | undefined {
  if (!value || typeof value !== "object") {
    if (strict) throw new Error("Saved memory entry must be an object");
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const content =
    typeof v.content === "string"
      ? v.content
      : typeof v.text === "string"
        ? v.text
        : undefined;
  if (!content || content.trim().length === 0) {
    if (strict) throw new Error("Saved memory entry missing content");
    return undefined;
  }
  if (v.deleted === true) {
    // Soft-deleted; skip even in strict mode (it's a valid shape, just not a
    // memory the user wants imported).
    return undefined;
  }
  const normalized: ChatGPTSavedMemory = {
    content: content.trim(),
    ...(typeof v.id === "string" ? { id: v.id } : {}),
    ...(isRawChatGPTTimestamp(v.created_at) ? { created_at: v.created_at } : {}),
    ...(isRawChatGPTTimestamp(v.updated_at) ? { updated_at: v.updated_at } : {}),
    ...(v.pinned === true ? { pinned: true } : {}),
    ...(Array.isArray(v.tags)
      ? { tags: v.tags.filter((t): t is string => typeof t === "string") }
      : {}),
  };
  return normalized;
}

function isRawChatGPTTimestamp(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/**
 * Walk a conversation's message graph and return only the user-authored text
 * turns in chronological order. Exported so the transform layer can build
 * conversation summaries from the same graph.
 */
export function collectUserTurnsFromConversation(
  conversation: ChatGPTConversation,
): Array<{ content: string; createdAt?: string }> {
  const collected: Array<{ content: string; createdAt?: string }> = [];

  if (Array.isArray(conversation.messages) && conversation.messages.length > 0) {
    for (const msg of conversation.messages) {
      const text = extractMessageText(msg);
      if (text) {
        collected.push({
          content: text,
          ...(normalizeChatGPTTimestamp(msg.create_time ?? msg.update_time) !== undefined
            ? { createdAt: normalizeChatGPTTimestamp(msg.create_time ?? msg.update_time) as string }
            : {}),
        });
      }
    }
    return collected;
  }

  if (conversation.mapping && typeof conversation.mapping === "object") {
    // Prefer walking the active chain from `current_node` up to the root via
    // `parent` links, then reverse so we visit in chronological order. This
    // mirrors how ChatGPT renders the conversation and excludes abandoned
    // branches the user backed out of. If `current_node` is missing, fall
    // back to a deterministic traversal of all nodes sorted by create_time
    // with node id as the stable secondary key.
    const mapping = conversation.mapping;
    const chainNodes = followCurrentNodeChain(mapping, conversation.current_node);
    const ordered =
      chainNodes.length > 0
        ? chainNodes
        : [...Object.values(mapping)].sort((a, b) => {
            const delta = toNumericTime(a.message?.create_time) -
              toNumericTime(b.message?.create_time);
            if (delta !== 0) return delta;
            // Stable secondary key: node id. Without this, nodes with equal
            // or missing timestamps order non-deterministically.
            const aid = typeof a.id === "string" ? a.id : "";
            const bid = typeof b.id === "string" ? b.id : "";
            if (aid < bid) return -1;
            if (aid > bid) return 1;
            return 0;
          });
    for (const node of ordered) {
      const msg = node.message;
      if (!msg) continue;
      if (msg.author?.role !== "user") continue;
      const text = extractMessageText(msg);
      if (text) {
        collected.push({
          content: text,
          ...(normalizeChatGPTTimestamp(msg.create_time ?? msg.update_time) !== undefined
            ? { createdAt: normalizeChatGPTTimestamp(msg.create_time ?? msg.update_time) as string }
            : {}),
        });
      }
    }
  }
  return collected;
}

/**
 * Walk the mapping graph from `current_node` back to the root via each
 * node's `parent` pointer, then reverse so the returned array is in
 * chronological order. Returns empty when `current_node` is missing or the
 * chain is broken so callers can fall back to timestamp sort.
 */
function followCurrentNodeChain(
  mapping: Record<string, ChatGPTConversationNode>,
  currentNode: string | null | undefined,
): ChatGPTConversationNode[] {
  if (typeof currentNode !== "string" || currentNode.length === 0) return [];
  const visited = new Set<string>();
  const chain: ChatGPTConversationNode[] = [];
  let cursor: string | null | undefined = currentNode;
  while (cursor) {
    if (visited.has(cursor)) {
      // Cycle — refuse to trust the chain. Fall back to timestamp sort.
      return [];
    }
    visited.add(cursor);
    const node: ChatGPTConversationNode | undefined = mapping[cursor];
    if (!node) {
      // Broken parent link (dangling reference). Don't return a partial
      // tail — it would silently omit the root and leave the caller with
      // an inconsistent view. Fall back to the timestamp-sorted walk.
      // Codex review on PR #595.
      return [];
    }
    chain.push(node);
    const messageParent: string | null | undefined = node.message?.parent;
    cursor =
      typeof node.parent === "string" && node.parent.length > 0
        ? node.parent
        : typeof messageParent === "string" && messageParent.length > 0
          ? messageParent
          : null;
  }
  return chain.reverse();
}

function extractMessageText(msg: ChatGPTConversationMessage): string | undefined {
  if (!msg) return undefined;
  if (msg.author?.role !== "user") {
    // Even in inline-messages shape, only return user-authored text.
    return undefined;
  }
  const parts = msg.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function toNumericTime(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed / 1000;
  }
  return 0;
}

export function normalizeChatGPTTimestamp(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    // Already ISO? Accept.
    if (/\d{4}-\d{2}-\d{2}T/.test(value)) return value;
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return epochToIso(asNum);
    return undefined;
  }
  if (Number.isFinite(value)) {
    return epochToIso(value);
  }
  return undefined;
}

/**
 * Convert an epoch value (seconds or ms) to an ISO string. Guards against
 * corrupted inputs that would crash `new Date(x).toISOString()` — the
 * `Date` constructor accepts arbitrarily large numbers but `toISOString`
 * throws RangeError for values beyond the platform's representable range
 * (±100,000,000 days from the epoch). Returns `undefined` for unusable
 * timestamps rather than propagating a crash.
 */
function epochToIso(value: number): string | undefined {
  // ChatGPT exports store epoch seconds. Detect ms by magnitude.
  const ms = Math.abs(value) > 1e12 ? value : value * 1000;
  // JS Date range: ±8,640,000,000,000,000 ms. Clamp well inside that.
  const MAX_SAFE_MS = 8640000000000000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_SAFE_MS) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return d.toISOString();
  } catch {
    return undefined;
  }
}
