import { log } from "../logger.js";
import type { SearchBackend } from "../search/port.js";
import type { FaissConversationIndexAdapter } from "./faiss-adapter.js";

export interface ConversationSearchResult {
  path: string;
  snippet: string;
  score: number;
}

export async function searchConversationIndex(
  qmd: SearchBackend,
  query: string,
  maxResults: number,
): Promise<ConversationSearchResult[]> {
  try {
    const results = await qmd.search(query, undefined, maxResults);
    return results.map((r) => ({ path: r.path, snippet: r.snippet, score: r.score }));
  } catch (err) {
    log.debug(`conversation index search failed: ${err}`);
    return [];
  }
}

export async function searchConversationIndexFaissFailOpen(
  adapter: FaissConversationIndexAdapter | undefined,
  query: string,
  maxResults: number,
): Promise<ConversationSearchResult[]> {
  if (!adapter) return [];
  try {
    return await adapter.searchChunks(query, maxResults);
  } catch (err) {
    log.debug(`conversation index FAISS search failed (fail-open): ${err}`);
    return [];
  }
}
