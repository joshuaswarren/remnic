import type { ImportedMemory } from "@remnic/core";
import type { ParsedSupermemoryExport, SupermemoryRecord } from "./parser.js";

export const SUPERMEMORY_SOURCE_LABEL = "supermemory";

export function transformSupermemoryExport(parsed: ParsedSupermemoryExport): ImportedMemory[] {
  const out: ImportedMemory[] = [];
  for (const row of parsed.memories) {
    const m = toImported(row, parsed.importedFromPath);
    if (m) out.push(m);
  }
  return out;
}

function toImported(row: SupermemoryRecord, importedFromPath?: string): ImportedMemory | undefined {
  const content = pickContent(row);
  if (!content) return undefined;
  const sourceId = typeof row.id === "string" && row.id.length > 0 ? row.id : content.slice(0, 64);
  const sourceTimestamp =
    typeof row.updatedAt === "string"
      ? row.updatedAt
      : typeof row.createdAt === "string"
        ? row.createdAt
        : undefined;
  return {
    content,
    sourceLabel: SUPERMEMORY_SOURCE_LABEL,
    sourceId,
    ...(sourceTimestamp ? { sourceTimestamp } : {}),
    ...(importedFromPath ? { importedFromPath } : {}),
    metadata: {
      kind: "supermemory_memory",
      ...(Array.isArray(row.containerTags) && row.containerTags.length > 0
        ? { containerTags: [...row.containerTags] }
        : {}),
      ...(row.metadata && typeof row.metadata === "object" ? { sourceMetadata: row.metadata } : {}),
    },
  };
}

function pickContent(row: SupermemoryRecord): string | undefined {
  for (const c of [row.content, row.summary, row.title]) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return undefined;
}
