import type { McpTool } from "./access-mcp.js";

export const EXTERNAL_WIKI_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.external_wiki_search",
    description:
      "Search configured external compiled-wiki roots on demand. Returns ranked snippets with root-relative citations and never changes default recall.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Required topical query." },
        limit: { type: "number", description: "Maximum hits (default 6, maximum 20)." },
        wikiId: { type: "string", description: "Optional configured wiki id to search exclusively." },
        maxCharsPerHit: {
          type: "number",
          description: "Maximum characters in each snippet (default 1000, maximum 8000).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];
