/**
 * Shared renderer for the recall-miss diagnosis (issue #3033).
 *
 * CLI, HTTP, and MCP all render the same {@link RecallWhyReport} through
 * this module — never their own formatting (AGENTS.md rule 22, the same
 * contract `recall-xray-renderer.ts` and `recall-explain-renderer.ts`
 * hold).
 */

import type { RecallWhyReport } from "./recall-why.js";

export type RecallWhyFormat = "json" | "markdown";

export const RECALL_WHY_FORMATS: readonly RecallWhyFormat[] = ["json", "markdown"] as const;

/**
 * Validate and coerce a user-provided `--format` / `format` argument.
 * Unknown values throw an error listing the valid options rather than
 * silently defaulting (Review Prevention Checklist #1 / #39).
 * `undefined` / `null` defaults to `"markdown"`.
 */
export function parseRecallWhyFormat(value: unknown): RecallWhyFormat {
  if (value === undefined || value === null) return "markdown";
  if (typeof value !== "string") {
    throw new Error(`--format expects one of ${RECALL_WHY_FORMATS.join(", ")}; got ${typeof value}`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "json" || normalized === "markdown") return normalized;
  throw new Error(`--format expects one of ${RECALL_WHY_FORMATS.join(", ")}; got ${JSON.stringify(value)}`);
}

export function renderRecallWhy(report: RecallWhyReport, format: RecallWhyFormat): string {
  return format === "json" ? renderRecallWhyJson(report) : renderRecallWhyMarkdown(report);
}

/** Deterministic JSON encoding of the report. */
export function renderRecallWhyJson(report: RecallWhyReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderRecallWhyMarkdown(report: RecallWhyReport): string {
  const lines: string[] = ["# Recall diagnosis", ""];
  lines.push(`- query: \`${report.query}\``);
  lines.push(`- planner mode: \`${report.plannerMode}\``);
  if (report.namespace !== undefined) lines.push(`- namespace: \`${report.namespace}\``);
  lines.push(
    `- recall namespaces: ${
      report.recallNamespaces.length > 0 ? report.recallNamespaces.map((ns) => `\`${ns}\``).join(", ") : "_none_"
    }`
  );
  lines.push(`- applied result limit: ${report.appliedResultLimit}`);
  lines.push(
    `- recalled: ${
      report.recalledMemoryIds.length > 0 ? report.recalledMemoryIds.map((id) => `\`${id}\``).join(", ") : "_nothing_"
    }`
  );
  lines.push("");

  if (report.failure !== undefined) {
    // An outage is never rendered as an empty pipeline (checklist #22).
    lines.push("## Backend unavailable", "");
    lines.push(`The diagnosis could not run: \`${report.failure.reason}\` — ${report.failure.detail}`);
    lines.push("");
    lines.push("This is a backend outage, not a zero-candidate recall.");
    lines.push("");
  }

  lines.push("## Stages", "");
  lines.push("| stage | considered | admitted | detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const stage of report.stages) {
    lines.push(`| ${stage.stage} | ${stage.considered} | ${stage.admitted} | ${escapeCell(stage.reason)} |`);
  }
  lines.push("");

  const dropped = report.stages.filter((stage) => stage.drops.length > 0);
  if (dropped.length > 0) {
    lines.push("## Drops", "");
    for (const stage of dropped) {
      lines.push(`### ${stage.stage}`, "");
      for (const drop of stage.drops) {
        lines.push(`- \`${drop.memoryId}\` (${drop.path}) — ${drop.reason}: ${drop.detail}`);
      }
      lines.push("");
    }
  }

  const expectation = report.expectation;
  if (expectation !== undefined) {
    lines.push("## Expected memory", "");
    lines.push(`- expect: \`${expectation.expect}\``);
    if (!expectation.matched) {
      lines.push("- matched: **no stored memory matches**");
    } else {
      lines.push(`- memory id: \`${expectation.memoryId ?? "unknown"}\``);
      lines.push(`- path: \`${expectation.path ?? "unknown"}\``);
    }
    lines.push("");
    if (expectation.recalled) {
      lines.push("**Recalled.** This memory survived every stage and was injected.");
    } else {
      lines.push(
        `**Dropped at ${expectation.stage ?? "unknown"}: ${expectation.reason ?? "unknown"}** — ${
          expectation.detail ?? "no detail recorded"
        }`
      );
      if (expectation.remediation !== undefined) {
        lines.push("");
        lines.push(`Remediation: ${expectation.remediation}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** One-line summary suited to a terminal or a chat reply. */
export function summarizeRecallWhy(report: RecallWhyReport): string {
  if (report.failure !== undefined) {
    return `backend_unavailable: ${report.failure.detail}`;
  }
  const expectation = report.expectation;
  if (expectation === undefined) {
    return `recalled ${report.recalledMemoryIds.length} memories (planner mode ${report.plannerMode})`;
  }
  if (!expectation.matched) {
    return `no stored memory matches ${JSON.stringify(expectation.expect)}`;
  }
  if (expectation.recalled) {
    return `${expectation.memoryId ?? expectation.expect} was recalled`;
  }
  return `dropped at ${expectation.stage ?? "unknown"}: ${expectation.reason ?? "unknown"}${
    expectation.detail !== undefined ? ` (${expectation.detail})` : ""
  }`;
}

function escapeCell(value: string | undefined): string {
  // A pipe inside a markdown table cell breaks the row; the filter ladder
  // joins with "; " and can legitimately contain one.
  return value === undefined ? "" : value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
