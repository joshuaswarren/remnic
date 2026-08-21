import { createHash } from "node:crypto";
import type { BehaviorSignalEvent, MemoryCategory } from "./types.js";

function normalizeSignalText(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

export function buildBehaviorSignalHash(category: MemoryCategory, content: string): string {
  const normalized = `${category}:${normalizeSignalText(content)}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function buildBehaviorSignalsForMemory(input: {
  memoryId: string;
  category: MemoryCategory;
  content: string;
  namespace: string;
  confidence: number;
  timestamp?: string;
  source?: "extraction" | "correction";
}): BehaviorSignalEvent[] {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const signalHash = buildBehaviorSignalHash(input.category, input.content);
  const source = input.source ?? "extraction";

  if (input.category === "correction") {
    return [
      {
        timestamp,
        namespace: input.namespace,
        memoryId: input.memoryId,
        category: "correction",
        signalType: "correction_override",
        direction: "negative",
        confidence: input.confidence,
        signalHash,
        source,
      },
    ];
  }

  if (input.category === "preference") {
    return [
      {
        timestamp,
        namespace: input.namespace,
        memoryId: input.memoryId,
        category: "preference",
        signalType: "preference_affinity",
        direction: "positive",
        confidence: input.confidence,
        signalHash,
        source,
      },
    ];
  }

  return [];
}

export function dedupeBehaviorSignalsByMemoryAndHash(
  signals: BehaviorSignalEvent[],
): BehaviorSignalEvent[] {
  const seen = new Set<string>();
  const out: BehaviorSignalEvent[] = [];
  for (const signal of signals) {
    const key = `${signal.namespace}:${signal.memoryId}:${signal.signalHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out;
}
