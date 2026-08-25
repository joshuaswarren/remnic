/**
 * Shared markdown renderer for recall navigation (issue #1956).
 *
 * Rule 22: CLI text output, MCP `rendered`, and HTTP human output all
 * render through this one module — never forked per surface.
 * Deterministic: items in result order, budget and disclosure spend last.
 */

import type { RecallNavigationResult } from "./recall-navigation.js";

type NavigationRenderInput = RecallNavigationResult extends infer Result
  ? Result extends { rendered: string }
    ? Omit<Result, "rendered">
    : never
  : never;

export function renderNavigationResult(result: NavigationRenderInput): string {
  if (!result.ok) {
    return ["# Memory navigation", "", `- error: ${result.error}`, `- ${result.message}`, ""].join("\n");
  }
  const lines = ["# Memory navigation", ""];
  lines.push(`- action: ${result.action}`);
  lines.push(`- memory: ${result.memoryId}`);
  lines.push(`- namespace: ${result.namespace}`);
  if (result.items.length === 0) {
    lines.push("- neighbors: (none)");
  } else {
    lines.push("");
    for (const [index, item] of result.items.entries()) {
      const via = item.linkType !== undefined ? ` via ${item.linkType}` : "";
      lines.push(`${index + 1}. **${item.memoryId}** (${item.disclosure}${via})`);
      if (item.content !== undefined) {
        lines.push(item.content);
      } else {
        lines.push(`   ${item.preview.replace(/\s+/g, " ").trim()}`);
      }
    }
  }
  lines.push("");
  lines.push(
    `- budget: ${result.budget.used}/${result.budget.chars} chars${result.truncated ? " (truncated)" : ""}`,
  );
  const spend = result.disclosureSpend;
  lines.push(
    `- disclosure spend: chunk=${spend.chunk.estimatedTokens}t, section=${spend.section.estimatedTokens}t, raw=${spend.raw.estimatedTokens}t`,
  );
  lines.push("");
  return lines.join("\n");
}
