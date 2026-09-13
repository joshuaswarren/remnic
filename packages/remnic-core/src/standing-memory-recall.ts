import {
  DEFAULT_UNTRUSTED_ORIGINS,
  isUntrustedOrigin,
  parseOriginClass,
} from "./security/origin-authority.js";
import type { PluginConfig } from "./types.js";
import {
  buildStandingMemoryBlock,
  lintStandingBlockVolatility,
  type StandingMemoryEntry,
} from "./standing-memory-block.js";

export interface StandingMemorySource {
  id?: string;
  path?: string;
  content: string;
  frontmatter: {
    id?: unknown;
    pinned?: unknown;
    updated?: unknown;
    origin?: unknown;
    status?: unknown;
  };
}

export function memoriesToStandingEntries(memories: readonly StandingMemorySource[]): StandingMemoryEntry[] {
  const entries: StandingMemoryEntry[] = [];
  for (const memory of memories) {
    const id = String(memory.frontmatter.id ?? memory.id ?? memory.path ?? "");
    if (!id) continue;
    if (isUntrustedOrigin(parseOriginClass(memory.frontmatter.origin), DEFAULT_UNTRUSTED_ORIGINS)) {
      continue;
    }
    if (typeof memory.frontmatter.status === "string" && memory.frontmatter.status !== "active") {
      continue;
    }
    const description =
      memory.content
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---")) ?? "";
    if (description.length < 8) continue;
    if (lintStandingBlockVolatility(description).length > 0) continue;
    const pinned = memory.frontmatter.pinned === true;
    const lastChangedAt =
      typeof memory.frontmatter.updated === "string" ? memory.frontmatter.updated : undefined;
    entries.push({ id, description: description.slice(0, 200), pinned, lastChangedAt });
  }
  return entries;
}

export function renderStandingMemoryBlock(config: PluginConfig, entries: StandingMemoryEntry[]): string {
  if (!config.recallStandingBlock || entries.length === 0) return "";
  try {
    return buildStandingMemoryBlock({
      entries,
      nowMs: Date.now(),
      maxChars: config.standingBlockMaxChars,
      freshDays: config.standingBlockFreshDays,
    }).text;
  } catch {
    return "";
  }
}

export function prefixStandingMemoryBlock(
  recallResult: string,
  standingText: string,
  budgetChars?: number,
): string {
  if (standingText.length === 0) return recallResult;
  if (budgetChars === 0) return recallResult;
  const combined = `${standingText}\n\n${recallResult}`;
  if (!budgetChars || combined.length <= budgetChars) return combined;
  return combined.slice(0, budgetChars);
}
