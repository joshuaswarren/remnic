/**
 * Generates a markdown decision-tree document (RESOLVER.md) from a
 * taxonomy definition.
 *
 * The document walks a user through filing a new piece of knowledge
 * by checking each category in priority order (lowest number first).
 */

import type { Taxonomy } from "./types.js";

/**
 * Produce a markdown decision tree for the given taxonomy.
 *
 * Categories are listed in priority order (lowest number = checked first).
 * Each step asks whether the knowledge fits the category and, if so,
 * instructs the reader to file it there.
 */
export function generateResolverDocument(taxonomy: Taxonomy): string {
  const sorted = [...taxonomy.categories].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id.localeCompare(b.id);
  });

  const lines: string[] = [
    "# Memory Filing Resolver",
    "",
    "Given a new piece of knowledge, follow this tree to determine where it belongs.",
    "",
  ];

  let step = 1;
  for (const cat of sorted) {
    lines.push(`## Step ${step}: ${cat.description}?`);
    lines.push("");
    for (const rule of cat.filingRules) {
      lines.push(`- ${rule}`);
    }
    lines.push("");
    lines.push(
      `> YES: File under **${cat.id}/** (priority ${cat.priority})`,
    );
    lines.push("");
    step++;
  }

  lines.push("## Tie-breaking");
  lines.push("");
  lines.push(
    "If a fact could go in multiple categories, file under the one with the **lowest priority number**.",
  );
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated from taxonomy v${taxonomy.version}*`);
  lines.push("");

  return lines.join("\n");
}
