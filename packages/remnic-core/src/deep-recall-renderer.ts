/**
 * Shared markdown renderer for deep recall (issue #2332).
 *
 * Rule 22 (AGENTS.md): never fork formatting — CLI text output, MCP text
 * output, and any later surface all render through this one module.
 * Deterministic: entries in result order, trace in step order.
 */

import type { DeepRecallResult } from "./deep-recall.js";

export function renderDeepRecallResult(result: DeepRecallResult): string {
  if (!result.ok) {
    return [`# Deep recall`, ``, `- error: ${result.error ?? "unknown"}`, ``].join("\n");
  }
  const lines: string[] = ["# Deep recall", ""];
  if (result.entries.length === 0) {
    lines.push("No memories retrieved.", "");
  } else {
    lines.push("## Memories", "");
    for (const [index, entry] of result.entries.entries()) {
      const via = entry.viaAnchor ? ` via anchor "${entry.viaAnchor}"` : "";
      lines.push(
        `${index + 1}. **${entry.memoryId}** (score ${entry.score.toFixed(3)}, origin ${entry.origin}${via})`,
      );
      lines.push(`   ${entry.content.replace(/\s+/g, " ").trim().slice(0, 400)}`);
    }
    lines.push("");
  }
  lines.push("## Trace", "");
  if (result.trace.length === 0) {
    lines.push("(empty)");
  } else {
    for (const step of result.trace) {
      lines.push(
        `- step ${step.step}: ${step.action} — ${step.detail} (workingSet=${step.workingSetSize}, frontier=${step.frontierSize}, ${step.durationMs}ms)`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
