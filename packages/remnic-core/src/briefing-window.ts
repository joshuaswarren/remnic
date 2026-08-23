import { log } from "./logger.js";
import type { MemoryFile } from "./types.js";
type BriefingMemoryReader = {
  readMemoriesWindow?: (options: { updatedAfter?: Date }) => Promise<{ memories: MemoryFile[] }>;
  readAllMemories: () => Promise<MemoryFile[]>;
};
import type { ParsedBriefingWindow } from "./briefing.js";

/**
 * Deadline for the legacy full-read fallback (issue #2779). Storage doubles
 * that predate `readMemoriesWindow()` can only answer with a full-corpus
 * `readAllMemories()`, which is unbounded work; on a large corpus that read
 * alone can outlast the 60s MCP client timeout. Race it against this budget
 * (well under 60s, leaving room for entity reads and follow-ups) and fail
 * open with an empty read, the same shape as the existing error path.
 */
export const BRIEFING_FULL_READ_FALLBACK_MS = 30_000;

/** Options for {@link safeReadMemories}. */
export interface SafeReadMemoriesOptions {
  /** Test seam overriding {@link BRIEFING_FULL_READ_FALLBACK_MS}. */
  fallbackDeadlineMs?: number;
}

function logBriefingMemoryRead(mode: "windowed" | "full-read-fallback", durationMs: number, count: number): void {
  // Remote diagnostic (issue #2779): one line per briefing read makes the
  // three timeout causes distinguishable from the daemon log alone —
  //   mode=windowed durationMs=<big>  → windowed scan itself is slow;
  //   mode=full-read-fallback         → storage adapter lacks window support;
  //   no line at all                  → daemon runs pre-#2386 code (stale).
  log.info(`briefing: memory read mode=${mode} durationMs=${durationMs} count=${count}`);
}

/** Read only the memories needed by a briefing, with compatibility fallback. */
export async function safeReadMemories(
  storage: BriefingMemoryReader,
  window: ParsedBriefingWindow,
  options: SafeReadMemoriesOptions = {},
): Promise<MemoryFile[]> {
  const startedAt = Date.now();
  try {
    // A briefing only needs memories inside its lookback window. Avoid parsing
    // the full corpus on cache misses; keep the full-read fallback for custom
    // StorageManager-compatible callers that predate readMemoriesWindow().
    if (typeof storage.readMemoriesWindow === "function") {
      const result = await storage.readMemoriesWindow({ updatedAfter: window.from });
      logBriefingMemoryRead("windowed", Date.now() - startedAt, result.memories.length);
      return result.memories;
    }
    const deadlineMs = options.fallbackDeadlineMs ?? BRIEFING_FULL_READ_FALLBACK_MS;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<MemoryFile[]>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve([]);
      }, deadlineMs);
    });
    let memories: MemoryFile[];
    try {
      memories = await Promise.race([storage.readAllMemories(), deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      log.warn(
        `briefing: memory read mode=full-read-fallback timed out after ${deadlineMs}ms — ` +
          `returning no memories (storage adapter lacks readMemoriesWindow; upgrade it to windowed reads)`,
      );
      return [];
    }
    logBriefingMemoryRead("full-read-fallback", Date.now() - startedAt, memories.length);
    return memories;
  } catch (err) {
    log.warn(`briefing: read memories failed: ${err}`);
    return [];
  }
}
