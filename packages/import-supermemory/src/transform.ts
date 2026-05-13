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
  const sourceId = pickSourceId(row.id) ?? content.slice(0, 64);
  const sourceTimestamp = pickTimestamp(row);
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

function pickTimestamp(row: SupermemoryRecord): string | undefined {
  for (const timestamp of [row.updatedAt, row.createdAt]) {
    if (typeof timestamp === "string" && timestamp.trim().length > 0) {
      return timestamp.trim();
    }
  }
  return undefined;
}

function pickSourceId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function pickContent(row: SupermemoryRecord): string | undefined {
  for (const c of [row.content, row.memory, row.summary, row.title]) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return undefined;
}
