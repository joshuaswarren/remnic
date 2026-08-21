/**
 * memory-extension-host/render-extensions-block.ts — Render discovered extensions
 * into a markdown block for injection into consolidation prompts.
 *
 * Respects the global token budget (REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT) and
 * truncates with a footer listing omitted extensions when over budget.
 */

import { estimateTokenCount } from "../token-estimate.js";
import { REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT } from "./host-discovery.js";
import type { DiscoveredExtension } from "./types.js";

/**
 * Render a markdown block containing extension instructions for injection
 * into consolidation prompts.
 *
 * If the list is empty, returns "".
 * Inlines extensions in name order until the token budget is exhausted.
 * If the budget is exceeded, appends a truncation footer listing omitted extensions.
 */
export function renderExtensionsBlock(extensions: DiscoveredExtension[]): string {
  if (extensions.length === 0) return "";

  const header = `## Active memory extensions

You are running with the following third-party memory extensions. Each
extension's \`instructions.md\` tells you how to interpret memories that
extension produces or curates.

`;

  let budget = REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT;
  budget -= estimateTokenCount(header);

  const inlined: string[] = [];
  const omitted: string[] = [];

  for (const ext of extensions) {
    const block = `### remnic-extension/${ext.name}\n\`\`\`\n${ext.instructions}\n\`\`\`\n\n`;
    const cost = estimateTokenCount(block);
    if (cost <= budget) {
      inlined.push(block);
      budget -= cost;
    } else {
      omitted.push(ext.name);
    }
  }

  let result = header;
  result += inlined.join("");

  if (omitted.length > 0) {
    result += `> **Note:** ${omitted.length} extension(s) omitted due to token budget: ${omitted.join(", ")}\n`;
  }

  return result;
}

/**
 * Render a compact one-line footer listing active extension names.
 * Used by day-summary and summary-snapshot where full instructions are not needed.
 */
export function renderExtensionsFooter(extensions: DiscoveredExtension[]): string {
  if (extensions.length === 0) return "";
  const names = extensions.map((ext) => ext.name).join(", ");
  return `Active extensions: ${names}`;
}
