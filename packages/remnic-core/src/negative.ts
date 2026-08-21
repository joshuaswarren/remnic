import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

export interface NegativeExampleEntry {
  notUseful: number;
  lastUpdatedAt: string;
  notes?: string[];
}

type NegativeState = Record<string, NegativeExampleEntry>;

const POISONOUS_NEGATIVE_MEMORY_IDS = new Set(["__proto__", "prototype", "constructor"]);

function createNegativeState(): NegativeState {
  return Object.create(null) as NegativeState;
}

function isSafeNegativeMemoryId(memoryId: unknown): memoryId is string {
  return (
    typeof memoryId === "string" &&
    memoryId.length > 0 &&
    !POISONOUS_NEGATIVE_MEMORY_IDS.has(memoryId)
  );
}

function sanitizeNegativeState(value: unknown): NegativeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return createNegativeState();

  const state = createNegativeState();
  for (const [memoryId, rawEntry] of Object.entries(value)) {
    if (!isSafeNegativeMemoryId(memoryId)) continue;
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Partial<NegativeExampleEntry>;
    if (
      typeof entry.notUseful !== "number" ||
      !Number.isFinite(entry.notUseful) ||
      entry.notUseful < 0
    ) {
      continue;
    }
    if (typeof entry.lastUpdatedAt !== "string") continue;
    const notes = Array.isArray(entry.notes)
      ? entry.notes.filter((note): note is string => typeof note === "string")
      : undefined;
    state[memoryId] = {
      notUseful: Math.floor(entry.notUseful),
      lastUpdatedAt: entry.lastUpdatedAt,
      notes: notes && notes.length > 0 ? notes : undefined,
    };
  }
  return state;
}

export class NegativeExampleStore {
  private readonly statePath: string;
  private state: NegativeState = createNegativeState();

  constructor(memoryDir: string) {
    this.statePath = path.join(memoryDir, "state", "negative_examples.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      this.state = sanitizeNegativeState(JSON.parse(raw));
    } catch {
      this.state = createNegativeState();
    }
  }

  /**
   * Record that a memory was retrieved but not useful for the user.
   * This should be lightweight and never block agent execution.
   */
  async recordNotUseful(memoryIds: string[], note?: string): Promise<void> {
    const now = new Date().toISOString();

    for (const memoryId of memoryIds) {
      if (!isSafeNegativeMemoryId(memoryId)) continue;
      const existing = this.state[memoryId] ?? { notUseful: 0, lastUpdatedAt: now };
      const next: NegativeExampleEntry = {
        notUseful: existing.notUseful + 1,
        lastUpdatedAt: now,
        notes: note
          ? [...(existing.notes ?? []).slice(-19), note]
          : existing.notes,
      };
      this.state[memoryId] = next;
    }

    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      log.debug(`negative example store write failed: ${err}`);
    }
  }

  /**
   * Convert negative examples into a small score penalty.
   * Intended as a soft bias, not a hard filter.
   */
  penalty(memoryId: string, opts: { perHit: number; cap: number }): number {
    if (!isSafeNegativeMemoryId(memoryId)) return 0;
    const entry = this.state[memoryId];
    if (!entry) return 0;
    if (!Number.isFinite(entry.notUseful) || entry.notUseful < 0) return 0;
    if (!Number.isFinite(opts.perHit) || opts.perHit < 0) return 0;
    if (!Number.isFinite(opts.cap) || opts.cap < 0) return 0;

    // Cap effect to avoid runaway ranking distortion.
    const hits = Math.min(10, entry.notUseful);
    const raw = hits * opts.perHit;
    return Math.min(opts.cap, raw);
  }
}
