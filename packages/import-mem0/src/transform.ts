// ---------------------------------------------------------------------------
// mem0 parsed → ImportedMemory transform (issue #568 slice 5)
// ---------------------------------------------------------------------------

import type { ImportedMemory } from "@remnic/core";

import type { Mem0Memory } from "./client.js";
import type { ParsedMem0Export } from "./parser.js";
import { extractMemoryBody } from "./parser.js";

export const MEM0_SOURCE_LABEL = "mem0";

export interface Mem0TransformOptions {
  /** Optional cap on total memories emitted — primarily for tests. */
  maxMemories?: number;
}

export function transformMem0Export(
  parsed: ParsedMem0Export,
  options: Mem0TransformOptions = {},
): ImportedMemory[] {
  const out: ImportedMemory[] = [];
  const cap = options.maxMemories;
  for (const entry of parsed.memories) {
    if (cap !== undefined && out.length >= cap) return out;
    const memory = mem0ToImported(entry, parsed.importedFromPath);
    if (memory) out.push(memory);
  }
  return out;
}

function mem0ToImported(
  entry: Mem0Memory,
  importedFromPath: string | undefined,
): ImportedMemory | undefined {
  const content = extractMemoryBody(entry);
  if (!content) return undefined;
  const sourceTimestamp = entry.updated_at ?? entry.created_at;
  const metadata: Record<string, unknown> = { kind: "mem0_memory" };
  if (entry.user_id) metadata.userId = entry.user_id;
  if (entry.agent_id) metadata.agentId = entry.agent_id;
  if (Array.isArray(entry.categories) && entry.categories.length > 0) {
    metadata.categories = [...entry.categories];
  }
  if (entry.metadata && typeof entry.metadata === "object") {
    metadata.sourceMetadata = entry.metadata;
  }
  return {
    content,
    sourceLabel: MEM0_SOURCE_LABEL,
    sourceId: entry.id,
    ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    ...(importedFromPath !== undefined ? { importedFromPath } : {}),
    metadata,
  };
}
