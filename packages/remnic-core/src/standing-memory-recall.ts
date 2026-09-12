import type { PluginConfig } from "./types.js";
import { buildStandingMemoryBlock, type StandingMemoryEntry } from "./standing-memory-block.js";

export function prefixStandingMemoryBlock(recallResult: string, config: PluginConfig): string {
  if (!config.recallStandingBlock) return recallResult;
  const entries: StandingMemoryEntry[] = [];
  for (const line of recallResult.split("\n")) {
    let description = line.trim();
    if (description.startsWith("- ")) description = description.slice(2).trim();
    if (description.startsWith("#") || description.length < 8) continue;
    if (/\d{4}-\d{2}-\d{2}/.test(description) || /\d{1,2}:\d{2}/.test(description)) continue;
    entries.push({ id: `standing-${entries.length}`, description: description.slice(0, 200) });
  }
  if (entries.length === 0) return recallResult;
  try {
    const block = buildStandingMemoryBlock({
      entries,
      nowMs: Date.now(),
      maxChars: config.standingBlockMaxChars,
      freshDays: config.standingBlockFreshDays,
    });
    if (block.text.length === 0) return recallResult;
    return `${block.text}\n\n${recallResult}`;
  } catch {
    return recallResult;
  }
}
