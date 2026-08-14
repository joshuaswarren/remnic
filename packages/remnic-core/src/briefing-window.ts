import { log } from "./logger.js";
import type { MemoryFile } from "./types.js";
type BriefingMemoryReader = {
  readMemoriesWindow?: (options: { updatedAfter?: Date }) => Promise<{ memories: MemoryFile[] }>;
  readAllMemories: () => Promise<MemoryFile[]>;
};
import type { ParsedBriefingWindow } from "./briefing.js";

/** Read only the memories needed by a briefing, with compatibility fallback. */
export async function safeReadMemories(
  storage: BriefingMemoryReader,
  window: ParsedBriefingWindow
): Promise<MemoryFile[]> {
  try {
    // A briefing only needs memories inside its lookback window. Avoid parsing
    // the full corpus on cache misses; keep the full-read fallback for custom
    // StorageManager-compatible callers that predate readMemoriesWindow().
    if (typeof storage.readMemoriesWindow === "function") {
      const result = await storage.readMemoriesWindow({ updatedAfter: window.from });
      return result.memories;
    }
    return await storage.readAllMemories();
  } catch (err) {
    log.warn(`briefing: read memories failed: ${err}`);
    return [];
  }
}
