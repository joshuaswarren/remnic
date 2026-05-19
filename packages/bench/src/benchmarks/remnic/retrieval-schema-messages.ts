import type { Message } from "../../adapters/types.js";
import type { SchemaTierPage } from "../../fixtures/schema-tiers/index.js";

export function buildSchemaTierMessages(pages: SchemaTierPage[]): Message[] {
  return pages.map((page) => ({
    role: "user",
    timestamp: page.createdAt,
    content: [
      `page_id: ${page.id}`,
      `owner: ${page.owner}`,
      `namespace: ${page.namespace}`,
      `title: ${page.title}`,
      `canonical_title: ${page.canonicalTitle}`,
      `type: ${page.type}`,
      `created_at: ${page.createdAt}`,
      `aliases: ${page.aliases.join(", ")}`,
      `timeline: ${page.timeline.join(" | ")}`,
      `see_also: ${page.seeAlso.join(", ")}`,
      `body: ${page.body}`,
      page.dirtySignals.length > 0
        ? `dirty_signals: ${page.dirtySignals.join(" | ")}`
        : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n"),
  }));
}
