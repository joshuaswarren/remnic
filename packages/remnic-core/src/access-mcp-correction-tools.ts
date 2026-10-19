/**
 * Correction MCP tool descriptors.
 *
 * Extracted from access-mcp.ts (over its fileSizeGrandfather ceiling) so
 * `duplicateOf` can land without growing that file. Aliases are applied by
 * the caller via withToolAliases.
 */
import type { McpTool } from "./access-mcp.js";

export const correctionMcpTools: McpTool[] = [
  {
    name: "engram.memory_correct_plan",
    description:
      "Plan a memory correction from a plain-language statement. Returns a CorrectionPlan with a diff preview; apply via memory_correct_apply. Pass duplicateOf plus one targetIds entry to supersede that duplicate without calling the classifier.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: 'The natural-language correction (e.g. "we migrated to MySQL in March").',
        },
        targetIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional explicit target memory ids. When omitted, the planner searches. With duplicateOf, pass exactly the duplicate id.",
        },
        duplicateOf: {
          type: "string",
          description:
            "Optional winner memory id. Requires targetIds to be exactly the duplicate. Skips classification and drafts one recoverable supersede (no hard delete) linking the duplicate to this id.",
        },
        sessionKey: { type: "string", description: "Session identifier for namespace resolution." },
        namespace: { type: "string", description: "Optional explicit namespace (validated by policy)." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.memory_correct_apply",
    description:
      "Apply a planned memory correction by planId. Requires confirm: true when correction.applyRequiresConfirm is on (default).",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "The plan id returned by memory_correct_plan." },
        confirm: { type: "boolean", description: "Must be true to apply (safety guard)." },
        sessionKey: { type: "string", description: "Session identifier for namespace resolution." },
        namespace: { type: "string", description: "Optional explicit namespace (validated by policy)." },
      },
      required: ["planId"],
      additionalProperties: false,
    },
  },
];
