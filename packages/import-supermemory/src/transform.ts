import type { ImportedMemory } from "@remnic/core";
import type { ParsedSupermemoryExport, SupermemoryRecord } from "./parser.js";

export const SUPERMEMORY_SOURCE_LABEL = "supermemory";

export interface SupermemoryTransformOptions {
  /** Optional cap on total memories emitted — primarily for tests. */
  maxMemories?: number;
}

export function transformSupermemoryExport(
  parsed: ParsedSupermemoryExport,
  options: SupermemoryTransformOptions = {},
): ImportedMemory[] {
  const out: ImportedMemory[] = [];
  const cap = options.maxMemories;
  for (const row of parsed.memories) {
    if (cap !== undefined && out.length >= cap) return out;
    const m = toImported(row, parsed.importedFromPath);
    if (m) out.push(m);
  }
  return out;
}

function toImported(row: SupermemoryRecord, importedFromPath?: string): ImportedMemory | undefined {
  const content = pickContent(row);
  if (!content) return undefined;
  const sourceId = pickSourceId(row.id);
  const sourceTimestamp = pickTimestamp(row);
  return {
    content,
    sourceLabel: SUPERMEMORY_SOURCE_LABEL,
    ...(sourceId ? { sourceId } : {}),
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
    const parsed = pickValidTimestamp(timestamp);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function pickValidTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(trimmed);
  if (!match) return undefined;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const date = new Date(parsed);
  const [, year, month, day] = match;
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    return undefined;
  }
  return trimmed;
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
