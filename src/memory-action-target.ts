import { isSupportPassportPrivateMemory } from "@remnic/core";

import type {
  MemoryActionEligibilityContext,
  MemoryActionEligibilitySource,
  MemoryActionType,
  MemoryFile,
} from "./types.js";

function clampUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeEligibilitySource(value: unknown): MemoryActionEligibilitySource {
  switch (value) {
    case "extraction":
    case "consolidation":
    case "replay":
    case "manual":
      return value;
    default:
      return "unknown";
  }
}

export function deriveMemoryActionPolicyEligibility(
  memory: Pick<MemoryFile, "frontmatter"> | null | undefined,
): MemoryActionEligibilityContext | undefined {
  if (!memory) return undefined;
  const frontmatter = memory.frontmatter;
  return {
    confidence: clampUnitInterval(frontmatter.confidence, 0),
    lifecycleState:
      frontmatter.status === "archived" ? "archived" : frontmatter.lifecycleState ?? "candidate",
    importance: clampUnitInterval(frontmatter.importance?.score, 0),
    source: normalizeEligibilitySource(frontmatter.source),
  };
}

export async function readReferencedMemoryForPolicyEligibility(
  storage: {
    getMemoryById?: (id: string) => Promise<MemoryFile | null>;
    readAllMemories?: () => Promise<MemoryFile[]>;
    readArchivedMemories?: () => Promise<MemoryFile[]>;
  },
  memoryId: string | undefined,
): Promise<MemoryFile | null | undefined> {
  if (!memoryId) return undefined;
  const direct = await storage.getMemoryById?.(memoryId);
  if (direct) return direct;
  const active = (await storage.readAllMemories?.())?.find((memory) => memory.frontmatter.id === memoryId);
  if (active) return active;
  return (await storage.readArchivedMemories?.())?.find((memory) => memory.frontmatter.id === memoryId);
}

export function blocksSupportPassportMutation(
  action: MemoryActionType,
  memory: Pick<MemoryFile, "frontmatter"> | null | undefined,
): boolean {
  return (
    (action === "update_note" || action === "discard" || action === "link_graph") &&
    Boolean(memory && isSupportPassportPrivateMemory(memory))
  );
}
