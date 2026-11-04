/**
 * Conversation Threading (Phase 3B)
 *
 * Groups related memories into conversation threads with auto-generated titles.
 * Thread boundary detection: new session key OR time gap > threshold.
 */

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { log } from "./logger.js";
import type { BufferTurn, ConversationThread } from "./types.js";
import {
  encodeStoragePathSegment,
  encodeStoragePathSegmentWithHash,
  isSafeLegacyPathSegment,
  resolveSafeStoragePath,
} from "./storage-paths.js";

/** Stop words for title extraction */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
  "she", "it", "they", "them", "their", "what", "which", "who", "how",
  "when", "where", "why", "and", "but", "or", "if", "because", "so",
  "just", "about", "like", "also", "very", "really", "here", "there",
]);

/**
 * Extract top keywords from content for thread title.
 * Simple TF approach (no IDF needed for single thread).
 */
function extractKeywords(content: string, maxKeywords: number = 3): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

  // Count frequencies
  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  // Sort by frequency, take top N
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

/**
 * Generate a thread title from keywords.
 */
function generateTitle(keywords: string[]): string {
  if (keywords.length === 0) return "Untitled Thread";
  // Capitalize and join
  return keywords
    .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
    .join(", ");
}

function isConversationThread(value: unknown): value is ConversationThread {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ConversationThread>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    Array.isArray(candidate.episodeIds) &&
    Array.isArray(candidate.linkedThreadIds)
  );
}

function parseConversationThread(raw: string): ConversationThread | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isConversationThread(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One session's thread-run state: its current thread and last turn time. */
interface ThreadingRunState {
  currentThreadId: string | null;
  lastTurnTimestamp: number | null;
}

export class ThreadingManager {
  /**
   * Per-session thread-run state. One global slot let two concurrent
   * extractions (bounded-parallel queue) interleave sessions and attach
   * turns to the wrong thread, so the run state is keyed by session.
   * Bounded: a long-lived daemon sees one entry per active session.
   */
  private readonly runStateBySession = new Map<string, ThreadingRunState>();
  /**
   * Run states with a processTurn awaiting inside them. A session parked on
   * `saveThread` can watch 512 other sessions insert and evict; dropping its
   * state mid-await loses its thread id and forks its thread, so eviction
   * never takes an in-flight state (the cap may be exceeded briefly by the
   * number of in-flight extractions, which is bounded by the queue).
   */
  private readonly inFlightRunStates = new Set<ThreadingRunState>();
  private static readonly RUN_STATE_MAX_SESSIONS = 512;

  private runStateFor(turn: BufferTurn): ThreadingRunState {
    const key = turn.sessionKey ?? "";
    let state = this.runStateBySession.get(key);
    if (state) {
      // Refresh recency: Map iteration is insertion-ordered, so re-putting a
      // touched session makes eviction true LRU instead of first-in-first-out —
      // an active session must not be the oldest entry just because it started
      // first.
      this.runStateBySession.delete(key);
      this.runStateBySession.set(key, state);
    } else {
      state = { currentThreadId: null, lastTurnTimestamp: null };
      this.runStateBySession.set(key, state);
      if (this.runStateBySession.size > ThreadingManager.RUN_STATE_MAX_SESSIONS) {
        for (const [oldestKey, oldest] of this.runStateBySession) {
          if (this.inFlightRunStates.has(oldest)) continue;
          this.runStateBySession.delete(oldestKey);
          if (this.runStateBySession.size <= ThreadingManager.RUN_STATE_MAX_SESSIONS) break;
        }
      }
    }
    return state;
  }

  constructor(
    private readonly threadsDir: string,
    private readonly gapMinutes: number = 30,
  ) {}

  async ensureDirectory(): Promise<void> {
    await mkdir(this.threadsDir, { recursive: true });
  }

  private encodedThreadFileName(threadId: string): string {
    return `${encodeStoragePathSegment(threadId)}.json`;
  }

  private collisionSafeThreadFileName(threadId: string): string {
    return `${encodeStoragePathSegmentWithHash(threadId)}.json`;
  }

  private legacyThreadFileName(threadId: string): string | undefined {
    if (!isSafeLegacyPathSegment(threadId)) return undefined;
    const legacyFile = `${threadId}.json`;
    return legacyFile === this.encodedThreadFileName(threadId) ? undefined : legacyFile;
  }

  private async threadCandidateStatus(
    filePath: string,
    threadId: string,
  ): Promise<"missing" | "matches" | "invalid" | "mismatches"> {
    try {
      if (!(await stat(filePath)).isFile()) return "mismatches";
      const thread = parseConversationThread(await readFile(filePath, "utf-8"));
      if (!thread) return "invalid";
      return thread.id === threadId ? "matches" : "mismatches";
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: string }).code
          : undefined;
      if (code === "ENOENT") return "missing";
      throw err;
    }
  }

  private async threadFilePathForWrite(threadId: string): Promise<string> {
    const encodedPath = await resolveSafeStoragePath(
      this.threadsDir,
      this.encodedThreadFileName(threadId),
    );
    const encodedStatus = await this.threadCandidateStatus(encodedPath, threadId);
    if (encodedStatus === "matches") return encodedPath;

    const legacyFile = this.legacyThreadFileName(threadId);
    if (legacyFile) {
      const legacyPath = await resolveSafeStoragePath(this.threadsDir, legacyFile);
      if ((await this.threadCandidateStatus(legacyPath, threadId)) === "matches") {
        return legacyPath;
      }
    }

    if (encodedStatus === "missing") return encodedPath;

    const collisionSafePath = await resolveSafeStoragePath(
      this.threadsDir,
      this.collisionSafeThreadFileName(threadId),
    );
    const collisionSafeStatus = await this.threadCandidateStatus(collisionSafePath, threadId);
    if (collisionSafeStatus === "mismatches") {
      throw new Error(`thread storage path collision for thread id: ${threadId}`);
    }

    return collisionSafePath;
  }

  /**
   * Check if we should start a new thread based on session key and time gap.
   * State is per session, so the cross-session check the shared slot needed
   * is gone: different sessions never share run state at all.
   */
  shouldStartNewThread(turn: BufferTurn): boolean {
    const turnTime = new Date(turn.timestamp).getTime();
    const state = this.runStateFor(turn);

    // Time gap > threshold = new thread
    if (state.lastTurnTimestamp) {
      const gapMs = turnTime - state.lastTurnTimestamp;
      const gapMinutes = gapMs / (1000 * 60);
      if (gapMinutes > this.gapMinutes) {
        return true;
      }
    }

    // No current thread = new thread
    if (!state.currentThreadId) {
      return true;
    }

    return false;
  }

  /**
   * Process a turn and return the thread ID it belongs to.
   * Creates a new thread if needed.
   */
  async processTurn(turn: BufferTurn, episodeIds: string[]): Promise<string> {
    await this.ensureDirectory();

    const turnTime = new Date(turn.timestamp).getTime();
    const state = this.runStateFor(turn);
    this.inFlightRunStates.add(state);
    try {
      if (this.shouldStartNewThread(turn)) {
        // Create new thread
        const threadId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const thread: ConversationThread = {
          id: threadId,
          title: "New Thread", // Will be updated later with keywords
          createdAt: turn.timestamp,
          updatedAt: turn.timestamp,
          sessionKey: turn.sessionKey,
          episodeIds: [...episodeIds],
          linkedThreadIds: [],
        };

        await this.saveThread(thread);
        state.currentThreadId = threadId;
        log.debug(`created new thread ${threadId}`);
      } else if (state.currentThreadId) {
        // Add episodes to current thread
        const thread = await this.loadThread(state.currentThreadId);
        if (thread) {
          for (const id of episodeIds) {
            if (!thread.episodeIds.includes(id)) {
              thread.episodeIds.push(id);
            }
          }
          thread.updatedAt = turn.timestamp;
          await this.saveThread(thread);
        }
      }

      state.lastTurnTimestamp = turnTime;

      return state.currentThreadId!;
    } finally {
      this.inFlightRunStates.delete(state);
    }
  }

  /**
   * Append persisted memory IDs to an existing thread.
   * Keeps IDs unique and updates the thread timestamp.
   */
  async appendEpisodeIds(threadId: string, episodeIds: string[]): Promise<void> {
    if (episodeIds.length === 0) return;
    const thread = await this.loadThread(threadId);
    if (!thread) return;

    let changed = false;
    for (const id of episodeIds) {
      if (!thread.episodeIds.includes(id)) {
        thread.episodeIds.push(id);
        changed = true;
      }
    }
    if (!changed) return;

    thread.updatedAt = new Date().toISOString();
    await this.saveThread(thread);
  }

  /**
   * Update thread title based on accumulated content.
   */
  async updateThreadTitle(threadId: string, content: string): Promise<void> {
    const thread = await this.loadThread(threadId);
    if (!thread) return;

    const keywords = extractKeywords(content);
    const title = generateTitle(keywords);

    if (title !== thread.title) {
      thread.title = title;
      thread.updatedAt = new Date().toISOString();
      await this.saveThread(thread);
      log.debug(`updated thread ${threadId} title: ${title}`);
    }
  }

  /**
   * Get all threads, sorted by updatedAt desc.
   */
  async getAllThreads(): Promise<ConversationThread[]> {
    try {
      const files = await readdir(this.threadsDir);
      const threadsById = new Map<
        string,
        { thread: ConversationThread; storagePriority: number }
      >();

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await readFile(
            await resolveSafeStoragePath(this.threadsDir, file),
            "utf-8",
          );
          const thread = parseConversationThread(raw);
          if (!thread) continue;

          const legacyFile = this.legacyThreadFileName(thread.id);
          const storagePriority =
            file === this.encodedThreadFileName(thread.id)
              ? 3
              : file === this.collisionSafeThreadFileName(thread.id)
                ? 2
                : legacyFile && file === legacyFile
                  ? 1
                  : 0;
          const current = threadsById.get(thread.id);
          if (!current || storagePriority > current.storagePriority) {
            threadsById.set(thread.id, { thread, storagePriority });
          }
        } catch {
          // skip unreadable or malformed thread files
        }
      }

      return [...threadsById.values()].map(({ thread }) => thread).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    } catch {
      return [];
    }
  }

  /**
   * Get a thread by ID.
   */
  async loadThread(threadId: string): Promise<ConversationThread | null> {
    const candidates = [
      this.encodedThreadFileName(threadId),
      this.legacyThreadFileName(threadId),
      this.collisionSafeThreadFileName(threadId),
    ];
    for (const file of candidates) {
      if (!file) continue;
      try {
        const filePath = await resolveSafeStoragePath(this.threadsDir, file);
        const raw = await readFile(filePath, "utf-8");
        const thread = parseConversationThread(raw);
        if (thread?.id === threadId) return thread;
      } catch {
        // try the next candidate
      }
    }
    return null;
  }

  /**
   * Save a thread.
   */
  async saveThread(thread: ConversationThread): Promise<void> {
    await this.ensureDirectory();
    const filePath = await this.threadFilePathForWrite(thread.id);
    await writeFile(filePath, JSON.stringify(thread, null, 2), "utf-8");
  }

  /**
   * Link two threads together.
   */
  async linkThreads(threadId1: string, threadId2: string): Promise<boolean> {
    const thread1 = await this.loadThread(threadId1);
    const thread2 = await this.loadThread(threadId2);

    if (!thread1 || !thread2) return false;

    // Add bidirectional links
    if (!thread1.linkedThreadIds.includes(threadId2)) {
      thread1.linkedThreadIds.push(threadId2);
      await this.saveThread(thread1);
    }

    if (!thread2.linkedThreadIds.includes(threadId1)) {
      thread2.linkedThreadIds.push(threadId1);
      await this.saveThread(thread2);
    }

    return true;
  }

  /**
   * Get the current thread ID (if any). With per-session run state there is
   * no single current thread; null unless exactly one session is tracked.
   */
  getCurrentThreadId(): string | null {
    if (this.runStateBySession.size === 1) {
      return this.runStateBySession.values().next().value?.currentThreadId ?? null;
    }
    return null;
  }

  /**
   * Reset threading state (e.g., on plugin restart).
   */
  reset(): void {
    this.runStateBySession.clear();
  }
}
