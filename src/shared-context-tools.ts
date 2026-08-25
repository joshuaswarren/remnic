/**
 * OpenClaw shared-context tool registrations (issue #2920).
 *
 * Extracted from src/tools.ts (at its fileSizeGrandfather ceiling) so the
 * write-output tool could gain the governed envelope controls
 * (`authority`/`expiresAt`/`supersedes`) without growing the god file.
 *
 * The controls parse through the ONE canonical surface module shared with
 * the Access MCP operation (`@remnic/core/shared-context/write-output-controls`),
 * and semantics (authority allow-list, binding gate, strict ISO instant,
 * future/TTL expiry policy, id shape) stay in `composeWriteEnvelope` — the
 * single write-side gate. There is no in-process path with looser rules.
 */
import { Type } from "@sinclair/typebox";
import type { Orchestrator } from "@remnic/core/orchestrator";
import { parseSharedWriteOutputControls } from "@remnic/core/shared-context/write-output-controls";
import { openClawToolWriteOrigin } from "./tool-write-origin.js";
import type { ToolApi } from "./tools.js";

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export function registerSharedContextTools(
  api: ToolApi,
  orchestrator: Orchestrator,
  hostRuntimeAgentId?: string,
): void {
  api.registerTool(
    {
      name: "shared_context_write_output",
      label: "Write Shared Agent Output",
      description:
        "Write an agent work product into the shared-context directory (v4.0). Other agents can read these files to coordinate without explicit message passing.",
      parameters: Type.Object({
        // Provenance is server-derived from the host runtime agent; a
        // mismatching value here is rejected, never used as the origin.
        agentId: Type.String({ description: "Agent ID producing this output; must match this host's runtime agent id when the host exposes one." }),
        title: Type.String({ description: "Short title for the output." }),
        content: Type.String({ description: "Markdown content to write." }),
        authority: Type.Optional(Type.String({
          enum: ["informational", "advisory", "binding"],
          description: "Envelope authority class. `binding` additionally requires the operator config `sharedContextAllowBindingAuthority: true`.",
        })),
        expiresAt: Type.Optional(Type.String({
          description: "ISO-8601 instant strictly after the write time and at most 10 years out. Past, invalid, or over-bound values are rejected.",
        })),
        supersedes: Type.Optional(Type.String({
          description: "Id of the shared item this output supersedes (non-empty, single line).",
        })),
      }),
      async execute(_toolCallId, params) {
        const { agentId, title, content } = params as { agentId: string; title: string; content: string };
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to use shared-context tools.",
          );
        }
        try {
          const controls = parseSharedWriteOutputControls(params);
          const fp = await orchestrator.sharedContext.writeAgentOutput({
            title,
            content,
            ...openClawToolWriteOrigin(hostRuntimeAgentId, agentId),
            ...controls,
          });
          return toolResult(`Wrote shared agent output: ${fp}`);
        } catch (err) {
          return toolResult(`shared_context_write_output error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    { name: "shared_context_write_output" },
  );

  api.registerTool(
    {
      name: "shared_feedback_record",
      label: "Record Shared Feedback",
      description:
        "Append an approval/rejection decision into shared-context feedback inbox (v4.0/v5.0). Intended to power compounding learning.",
      parameters: Type.Object({
        agent: Type.String({ description: "Agent name that produced the recommendation/output." }),
        decision: Type.String({
          enum: ["approved", "approved_with_feedback", "rejected"],
          description: "Decision outcome.",
        }),
        reason: Type.String({ description: "Why the decision was made (short but specific)." }),
        date: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
        learning: Type.Optional(Type.String({ description: "Optional distilled learning/pattern." })),
        outcome: Type.Optional(Type.String({ description: "Optional downstream outcome (day-one supported; may be empty initially)." })),
        severity: Type.Optional(Type.String({
          enum: ["low", "medium", "high"],
          description: "Optional severity rating for the mistake/outcome.",
        })),
        confidence: Type.Optional(Type.Number({ description: "Optional confidence score from 0 to 1." })),
        workflow: Type.Optional(Type.String({ description: "Optional workflow or playbook name associated with the feedback." })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for rubric grouping and recall matching." })),
        evidenceWindowStart: Type.Optional(Type.String({ description: "Optional start timestamp for the evidence window." })),
        evidenceWindowEnd: Type.Optional(Type.String({ description: "Optional end timestamp for the evidence window." })),
        refs: Type.Optional(Type.Array(Type.String(), { description: "Optional references (URLs, IDs, filenames)." })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to record shared feedback.",
          );
        }
        const p = params as Record<string, unknown>;
        const isDecision = (v: unknown): v is "approved" | "approved_with_feedback" | "rejected" =>
          v === "approved" || v === "approved_with_feedback" || v === "rejected";
        if (!isDecision(p.decision)) {
          return toolResult(
            "shared_feedback_record error: decision must be one of approved, approved_with_feedback, rejected",
          );
        }
        const isSeverity = (v: unknown): v is "low" | "medium" | "high" =>
          v === "low" || v === "medium" || v === "high";
        const entry = {
          agent: typeof p.agent === "string" ? p.agent : "",
          decision: p.decision,
          reason: typeof p.reason === "string" ? p.reason : "",
          date: typeof p.date === "string" && p.date.length > 0 ? p.date : new Date().toISOString(),
          learning: typeof p.learning === "string" ? p.learning : undefined,
          outcome: typeof p.outcome === "string" ? p.outcome : undefined,
          severity: isSeverity(p.severity) ? p.severity : undefined,
          confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence) ? p.confidence : undefined,
          workflow: typeof p.workflow === "string" ? p.workflow : undefined,
          tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
          evidenceWindowStart: typeof p.evidenceWindowStart === "string" ? p.evidenceWindowStart : undefined,
          evidenceWindowEnd: typeof p.evidenceWindowEnd === "string" ? p.evidenceWindowEnd : undefined,
          refs: Array.isArray(p.refs) ? p.refs.map(String) : undefined,
        };
        await orchestrator.sharedContext.appendFeedback(entry);
        return toolResult("OK");
      },
    },
    { name: "shared_feedback_record" },
  );

  api.registerTool(
    {
      name: "shared_priorities_append",
      label: "Append Priorities Inbox",
      description:
        "Append text into shared-context priorities inbox. A curator run should merge this into priorities.md.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID appending priorities." }),
        text: Type.String({ description: "Priority notes to append (markdown)." }),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to write priorities inbox.",
          );
        }
        const { agentId, text } = params as { agentId: string; text: string };
        await orchestrator.sharedContext.appendPrioritiesInbox({ agentId, text });
        return toolResult("OK");
      },
    },
    { name: "shared_priorities_append" },
  );

  api.registerTool(
    {
      name: "shared_context_cross_signals_run",
      label: "Run Cross-Signal Synthesis",
      description:
        "Generate today's shared-context cross-signal markdown + JSON artifacts on demand, without requiring a full roundtable curation pass.",
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "YYYY-MM-DD. Defaults to today." })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to synthesize cross-signals.",
          );
        }
        const { date } = params as { date?: string };
        const result = await orchestrator.sharedContext.synthesizeCrossSignals({ date });
        return toolResult(
          [
            `Cross-signals markdown: ${result.crossSignalsMarkdownPath}`,
            `Cross-signals JSON: ${result.crossSignalsPath}`,
            `Source outputs analyzed: ${result.report.sourceCount}`,
            `Feedback entries analyzed: ${result.report.feedbackCount}`,
            `Overlap count: ${result.overlapCount}`,
          ].join("\n"),
        );
      },
    },
    { name: "shared_context_cross_signals_run" },
  );

  api.registerTool(
    {
      name: "shared_context_curate_daily",
      label: "Curate Daily Roundtable",
      description:
        "Curator tool: generate today's roundtable summary in shared-context/roundtable (deterministic baseline).",
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "YYYY-MM-DD. Defaults to today." })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to curate roundtables.",
          );
        }
        const { date } = params as { date?: string };
        const result = await orchestrator.sharedContext.curateDaily({ date });
        return toolResult(
          [
            `Roundtable: ${result.roundtablePath}`,
            `Cross-signals markdown: ${result.crossSignalsMarkdownPath}`,
            `Cross-signals JSON: ${result.crossSignalsPath}`,
            `Overlap count: ${result.overlapCount}`,
          ].join("\n"),
        );
      },
    },
    { name: "shared_context_curate_daily" },
  );
}
