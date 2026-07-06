/**
 * Chat tools — the ONLY tools available to the chat engine (issue #1583).
 *
 * Each tool is a thin adapter over an existing access-service method (rule 22
 * — zero new business logic here).  Mutating tools (correction_apply,
 * memory_promote) are marked and go through the confirmation protocol in the
 * engine before reaching the executor.
 */

import type { ChatToolSchema } from "./chat-types.js";

// ---------------------------------------------------------------------------
// Tool identifiers
// ---------------------------------------------------------------------------

export type ChatToolName =
  | "memory_search"
  | "memory_get"
  | "memory_timeline"
  | "recall_explain"
  | "entity_get"
  | "stats"
  | "correction_plan"
  | "correction_apply"
  | "memory_promote"
  | "review_list"
  | "scope_inspect";

/** Tools that mutate memory — require confirmation before execution. */
export const MUTATING_TOOLS: ReadonlySet<ChatToolName> = new Set([
  "correction_apply",
  "memory_promote",
]);

// ---------------------------------------------------------------------------
// Tool schema definitions (sent to the LLM as the function-calling schema)
// ---------------------------------------------------------------------------

const MEMORY_SEARCH_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "memory_search",
    description:
      "Semantic search across stored memories. Returns matching memory paths, scores, and snippets. Use this to find what Remnic remembers about a topic.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        maxResults: { type: "number", description: "Maximum results (default 8)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const MEMORY_GET_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "memory_get",
    description:
      "Fetch a single memory by its id. Returns the full memory content, category, tags, and source attribution.",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "The memory id to fetch." },
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
  },
};

const MEMORY_TIMELINE_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "memory_timeline",
    description:
      "Read the lifecycle timeline of a single memory — creation, updates, consolidations, and tier transitions.",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "The memory id." },
        limit: { type: "number", description: "Maximum rows (default 200)." },
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
  },
};

const RECALL_EXPLAIN_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "recall_explain",
    description:
      "Explain why Remnic would recall certain memories for a given query. Returns tier scoring and matching details. Use this to answer 'why did you remember this?'",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional query to explain recall for. When omitted, explains the most recent recall." },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const ENTITY_GET_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "entity_get",
    description:
      "Fetch the compiled entity record for a named entity (person, project, tool, etc.). Returns traits, timeline, and associated memories.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Entity name." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
};

const STATS_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "stats",
    description:
      "Return aggregate memory statistics — memory count, entity count, profile summary, and open questions. Use this for high-level 'what do you know?' questions.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

const CORRECTION_PLAN_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "correction_plan",
    description:
      "Generate a correction plan (diff preview) for a requested memory change. This does NOT apply the change — it previews what would happen. The user must confirm before correction_apply runs.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "Natural-language description of the correction, e.g. 'we finished the MySQL migration in March' or 'forget the outdated database credentials'.",
        },
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
};

const CORRECTION_APPLY_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "correction_apply",
    description:
      "Apply a previously generated correction plan. The engine intercepts this call and requires explicit user confirmation before it executes.",
    parameters: {
      type: "object",
      properties: {
        planId: { type: "string", description: "The plan id from correction_plan." },
      },
      required: ["planId"],
      additionalProperties: false,
    },
  },
};

const MEMORY_PROMOTE_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "memory_promote",
    description:
      "Promote a memory's tier (e.g. from cold to hot). The engine requires user confirmation before executing.",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "The memory id to promote." },
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
  },
};

const REVIEW_LIST_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "review_list",
    description:
      "List items in the contradiction/quality review queue. Returns pairs of potentially conflicting memories awaiting resolution.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Optional governance run id." },
      },
      additionalProperties: false,
    },
  },
};

const SCOPE_INSPECT_SCHEMA: ChatToolSchema = {
  type: "function",
  function: {
    name: "scope_inspect",
    description:
      "Inspect the current scope/namespace resolution — which namespace the chat session operates in and how it was resolved.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

/**
 * All read-only tool schemas, always available when chat is enabled.
 */
const READONLY_SCHEMAS: ChatToolSchema[] = [
  MEMORY_SEARCH_SCHEMA,
  MEMORY_GET_SCHEMA,
  MEMORY_TIMELINE_SCHEMA,
  RECALL_EXPLAIN_SCHEMA,
  ENTITY_GET_SCHEMA,
  STATS_SCHEMA,
  REVIEW_LIST_SCHEMA,
];

/**
 * Build the tool schema list for the LLM.  The correction tools are only
 * included when the Correction Contract (#1580) is available; scope_inspect
 * is only included when the scope resolver (#1494) is available.
 */
export function buildChatToolSchemas(opts: {
  correctionAvailable: boolean;
  scopeInspectAvailable: boolean;
}): ChatToolSchema[] {
  const tools = [...READONLY_SCHEMAS];
  if (opts.correctionAvailable) {
    tools.push(CORRECTION_PLAN_SCHEMA, CORRECTION_APPLY_SCHEMA, MEMORY_PROMOTE_SCHEMA);
  }
  if (opts.scopeInspectAvailable) {
    tools.push(SCOPE_INSPECT_SCHEMA);
  }
  return tools;
}
