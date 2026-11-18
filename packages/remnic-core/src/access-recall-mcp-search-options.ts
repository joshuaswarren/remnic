/** MCP `engram.recall` inputSchema fragment for `searchOptions` (HTTP parity). */
export const engramRecallSearchOptionsMcpProperty = {
  type: "object",
  description:
    "Per-recall QMD query options. Only rerank: false is honored on the wire (--no-rerank); rerank: true is a no-op when daemon rerank is on.",
  properties: {
    intent: { type: "string" },
    explain: { type: "boolean" },
    candidateLimit: { type: "number" },
    rerank: { type: "boolean" },
    chunkStrategy: { type: "string", enum: ["auto", "regex"] },
    structuredSearches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["lex", "vec", "hyde"] },
          query: { type: "string" },
        },
        required: ["type", "query"],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
