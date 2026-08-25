/**
 * Memory-store browse MCP tool definitions (issue #2978) — extracted from
 * access-mcp.ts so the surface file stays at its structural ceiling (same
 * seam as recall-navigation-mcp-tools.ts). Spread back into `this.tools`
 * (`...MEMORY_BROWSE_MCP_TOOLS`); the migrated-operation mapping lives in
 * access-mcp.ts's MCP_MIGRATED_OPERATIONS. The `remnic.` canonical alias
 * is minted by withToolAliases at tools/list time.
 *
 * Always listed: browse is a pure read over the caller's resolved
 * namespace, so there is no gating flag (unlike recallNavigation).
 */

import type { McpTool } from "./access-mcp.js";

export const MEMORY_BROWSE_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.memory_ls",
    description:
      "List what exists at one store path in your namespace: category directories with memory counts, memory files with a one-line description. Answers \"is there anything here at all?\" without a search query. Derived stores (artifacts/, meetings records, wearables, state/) are invisible by design.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Store path to list, relative to the namespace root (\"\" or \"/\" = root). Default root." },
        namespace: { type: "string", description: "Caller namespace to scope this operation to." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "engram.memory_tree",
    description:
      "Depth-limited tree under one store path (depth 1 acts like ls). Deterministic sorted output, entry-capped so a large store cannot flood the response.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Store path to expand, relative to the namespace root (default root)." },
        depth: { type: "integer", minimum: 1, maximum: 4, description: "Expansion depth, 1-4. Default 1." },
        namespace: { type: "string", description: "Caller namespace to scope this operation to." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "engram.memory_find",
    description:
      "Deterministic name/path lookup over your namespace's store: `*` glob (e.g. \"facts/2026-08-*/*.md\") or substring. Use memory_search for semantic matching; use this when you know (part of) the name.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob with `*` wildcards or substring to match against path and filename. Required." },
        namespace: { type: "string", description: "Caller namespace to scope this operation to." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];
