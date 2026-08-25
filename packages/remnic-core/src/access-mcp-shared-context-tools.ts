/**
 * Shared-context MCP tool descriptors (issue #2920).
 *
 * Extracted from access-mcp.ts (at its fileSizeGrandfather ceiling) so the
 * write-output tool could gain the governed envelope controls without
 * growing the god file. Content is identical to the previously inline
 * entries except for the new `authority`/`expiresAt`/`supersedes` properties
 * on `engram.shared_context_write_output`, which mirror the canonical
 * validation in shared-context/write-output-controls.ts and
 * composeWriteEnvelope.
 */
import type { McpTool } from "./access-mcp.js";

export const sharedContextMcpTools: McpTool[] = [
  {
    name: "engram.shared_context_write_output",
    description: "Write agent work product into shared-context directory for cross-agent coordination.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID producing this output." },
        title: { type: "string", description: "Short title for the output." },
        content: { type: "string", description: "Markdown content to write." },
        authority: {
          type: "string",
          enum: ["informational", "advisory", "binding"],
          description:
            "Envelope authority class. `binding` additionally requires the operator config `sharedContextAllowBindingAuthority: true`.",
        },
        expiresAt: {
          type: "string",
          description:
            "ISO-8601 instant strictly after the write time and at most 10 years out. Past, invalid, or over-bound values are rejected.",
        },
        supersedes: {
          type: "string",
          description: "Id of the shared item this output supersedes (non-empty, single line).",
        },
      },
      required: ["agentId", "title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.shared_feedback_record",
    description: "Append approval/rejection decision into shared-context feedback inbox for compounding learning.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name that produced the output." },
        decision: { type: "string", enum: ["approved", "approved_with_feedback", "rejected"] },
        reason: { type: "string" },
        date: { type: "string", description: "ISO timestamp. Defaults to now." },
        learning: { type: "string" },
        outcome: { type: "string" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        confidence: { type: "number", description: "Confidence 0-1." },
        workflow: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        evidenceWindowStart: { type: "string" },
        evidenceWindowEnd: { type: "string" },
        refs: { type: "array", items: { type: "string" } },
      },
      required: ["agent", "decision", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.shared_priorities_append",
    description: "Append priorities text into shared-context inbox for curator merge.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        text: { type: "string", description: "Priority notes (markdown)." },
      },
      required: ["agentId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.shared_context_cross_signals_run",
    description: "Generate cross-signal markdown + JSON artifacts from agent outputs and feedback.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "engram.shared_context_curate_daily",
    description: "Generate daily roundtable summary (deterministic baseline aggregation).",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
  },
];
