// ---------------------------------------------------------------------------
// Off-thread archive scoring for the cold-fallback recall path (issue #1674).
//
// `searchLongTermArchiveFallback` (orchestrator.ts) falls back to scanning
// EVERY archived memory file when hybrid/vector search returns zero hits.
// The scoring loop — for each memory × for each token, `haystack.includes(token)`
// — is fully synchronous, unbounded, and CPU-bound. Under concurrent recall
// load this monopolized the JS main thread: N concurrent recalls serialized
// on one core and each blew past the client-side timeout even though total
// CPU work would have finished comfortably if parallelized.
//
// This module extracts the scoring loop into a pure function and provides two
// strategies:
//
//   1. `SyncArchiveScoring`   — runs the pure function on the calling thread
//                               (the OLD behavior; preserved for prove-fail
//                               tests and as the graceful fallback).
//   2. `OffThreadArchiveScoring` — dispatches the pure function to a
//                               `worker_threads` pool so concurrent recalls
//                               run on separate cores instead of serializing
//                               on the main thread. Falls back to sync if
//                               workers cannot be created.
//
// Both strategies share the identical `scoreArchiveMemories` pure function,
// so the scoring semantics are byte-identical regardless of which path runs.
// ---------------------------------------------------------------------------

import os from "node:os";
import { Worker } from "node:worker_threads";
import { log } from "../logger.js";
import type { MemoryFile } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Wire types — plain-serializable shapes that cross the worker boundary via
// structured clone. Only the fields the scoring loop reads are included.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal serializable projection of {@link MemoryFile} for scoring. */
export interface ArchiveScoreItem {
  id: string;
  path: string;
  content: string;
  category: string;
  tags: string[];
}

/** Scoring output — maps 1:1 to the relevant {@link QmdSearchResultLike} fields. */
export interface ArchiveScoreResult {
  docid: string;
  path: string;
  score: number;
  snippet: string;
}

/** Worker request envelope. */
interface ScoreTask {
  items: ArchiveScoreItem[];
  tokens: string[];
}

/** Worker reply envelope. */
type ScoreReply = { ok: true; results: ArchiveScoreResult[] } | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Pure scoring function — shared by both strategies and by the worker entry.
// Extracted verbatim from the original inline loop in
// `searchLongTermArchiveFallback` so behavior is identical.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score archived memories against query tokens using substring overlap.
 *
 * For each memory, builds a lowercase haystack from `[content, category, ...tags]`,
 * counts how many distinct tokens appear in it, and scores by `hits / tokens.length`.
 * Memories with zero hits are dropped. Snippets are the first 400 chars of content
 * with newlines collapsed to spaces — matching the original orchestrator behavior.
 *
 * This function is intentionally synchronous and CPU-bound; that is precisely
 * why the off-thread strategy exists.
 */
export function scoreArchiveMemories(
  items: ReadonlyArray<ArchiveScoreItem>,
  tokens: ReadonlyArray<string>
): ArchiveScoreResult[] {
  if (items.length === 0 || tokens.length === 0) return [];

  const scored: ArchiveScoreResult[] = [];
  for (const item of items) {
    const haystack = [item.content, item.category, ...item.tags].join(" ").toLowerCase();
    let hits = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) hits += 1;
    }
    if (hits === 0) continue;
    scored.push({
      docid: item.id,
      path: item.path,
      score: hits / tokens.length,
      snippet: item.content.slice(0, 400).replace(/\n/g, " "),
    });
  }
  return scored;
}

/**
 * Project a {@link MemoryFile} into the minimal serializable shape the scoring
 * function consumes. Called on the main thread BEFORE dispatching to a worker
 * so the heavy `MemoryFrontmatter` (dozens of optional fields, nested objects)
 * never crosses the worker boundary.
 */
export function memoryFileToScoreItem(memory: MemoryFile): ArchiveScoreItem {
  return {
    id: memory.frontmatter.id,
    path: memory.path,
    content: memory.content,
    category: memory.frontmatter.category,
    tags: memory.frontmatter.tags ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pluggable scoring backend. The orchestrator holds one instance and calls
 * `score()` from the cold-fallback path. The default is off-thread; tests and
 * restricted environments can swap in the sync strategy.
 */
export interface ArchiveScoringStrategy {
  score(
    items: ReadonlyArray<ArchiveScoreItem>,
    tokens: ReadonlyArray<string>,
    abortSignal?: AbortSignal
  ): Promise<ArchiveScoreResult[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SyncArchiveScoring — the OLD serialized behavior, preserved for fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the scoring loop synchronously on the calling thread.
 *
 * This is the exact behavior that caused issue #1674: the synchronous loop
 * blocks the event loop for its entire duration, so concurrent recall
 * requests serialize behind each other. It is retained as the graceful
 * fallback when worker_threads are unavailable, and as the prove-fail
 * baseline in regression tests.
 */
export class SyncArchiveScoring implements ArchiveScoringStrategy {
  async score(
    items: ReadonlyArray<ArchiveScoreItem>,
    tokens: ReadonlyArray<string>,
    abortSignal?: AbortSignal
  ): Promise<ArchiveScoreResult[]> {
    if (abortSignal?.aborted) return [];
    return scoreArchiveMemories(items, tokens);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. OffThreadArchiveScoring — worker pool for genuine multi-core parallelism
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default worker pool size. Uses `availableParallelism()` (Node 19.4+) minus
 * one so the main thread always has a dedicated core for I/O dispatch. Capped
 * at 8 to bound memory overhead (each worker has its own V8 heap).
 */
function defaultPoolSize(): number {
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(Math.max(1, cpus - 1), 8));
}

/** Lazy worker pool. Workers are created on first use and recycled. */
class ArchiveScoringWorkerPool {
  private readonly targetSize: number;
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private waiters: Array<(worker: Worker) => void> = [];
  private terminated = false;

  constructor(size: number = defaultPoolSize()) {
    this.targetSize = Math.max(1, size);
  }

  async run(task: ScoreTask, abortSignal?: AbortSignal): Promise<ArchiveScoreResult[]> {
    if (this.terminated) throw new Error("archive-scoring pool terminated");
    const worker = await this.acquire();
    try {
      return await this.dispatch(worker, task, abortSignal);
    } finally {
      this.release(worker);
    }
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    const all = [...this.workers];
    this.workers = [];
    this.idle = [];
    await Promise.allSettled(all.map((w) => w.terminate()));
  }

  private async acquire(): Promise<Worker> {
    const idle = this.idle.pop();
    if (idle) return idle;
    if (this.workers.length < this.targetSize) return this.spawn();
    return new Promise<Worker>((resolve) => this.waiters.push(resolve));
  }

  private release(worker: Worker): void {
    const next = this.waiters.shift();
    if (next) {
      next(worker);
    } else if (!this.terminated) {
      this.idle.push(worker);
    } else {
      void worker.terminate();
    }
  }

  private spawn(): Worker {
    // Resolve `.ts` under tsx/source, `.js` under compiled dist. Both
    // `import.meta.url` and the worker URL are file:// URLs; the suffix
    // check reliably distinguishes the two execution modes.
    const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const workerUrl = new URL(`./archive-scoring-worker${ext}`, import.meta.url);
    const worker = new Worker(workerUrl);
    this.workers.push(worker);
    return worker;
  }

  private dispatch(worker: Worker, task: ScoreTask, abortSignal?: AbortSignal): Promise<ArchiveScoreResult[]> {
    return new Promise<ArchiveScoreResult[]>((resolve, reject) => {
      if (abortSignal?.aborted) {
        resolve([]);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("archive-scoring dispatch timed out after 10s"));
        }
      }, 10_000);

      const onMessage = (reply: ScoreReply) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (reply.ok) {
          resolve(reply.results);
        } else {
          reject(new Error(reply.error));
        }
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve([]);
      };

      const cleanup = () => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        abortSignal?.removeEventListener("abort", onAbort);
      };

      worker.on("message", onMessage);
      worker.on("error", onError);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage(task);
    });
  }
}

/**
 * Off-thread scoring via a `worker_threads` pool.
 *
 * Concurrent `score()` calls are dispatched to separate workers, giving
 * genuine multi-core parallelism: K concurrent recalls run on K cores
 * instead of serializing on the main JS thread. If the pool cannot be
 * created (e.g. restricted runtime), it transparently falls back to
 * {@link SyncArchiveScoring} so recall never breaks.
 */
export class OffThreadArchiveScoring implements ArchiveScoringStrategy {
  private pool: ArchiveScoringWorkerPool | null = null;
  private poolFailed = false;
  private readonly syncFallback = new SyncArchiveScoring();

  constructor(poolSize?: number) {
    if (poolSize !== undefined) {
      this.pool = new ArchiveScoringWorkerPool(poolSize);
    }
  }

  async score(
    items: ReadonlyArray<ArchiveScoreItem>,
    tokens: ReadonlyArray<string>,
    abortSignal?: AbortSignal
  ): Promise<ArchiveScoreResult[]> {
    if (items.length === 0 || tokens.length === 0) return [];
    if (abortSignal?.aborted) return [];

    // Lazy pool init — workers are only created when the cold-fallback path
    // is first hit, so hot-path recall pays zero overhead.
    if (this.pool === null && !this.poolFailed) {
      try {
        this.pool = new ArchiveScoringWorkerPool();
      } catch (err) {
        this.poolFailed = true;
        log.debug(`archive-scoring: worker pool unavailable, using sync fallback — ${(err as Error).message}`);
      }
    }

    if (this.pool !== null) {
      try {
        const task: ScoreTask = {
          items: items as ArchiveScoreItem[],
          tokens: tokens as string[],
        };
        const results = await this.pool.run(task, abortSignal);
        if (abortSignal?.aborted) return [];
        return results;
      } catch (err) {
        log.debug(`archive-scoring: worker dispatch failed, using sync fallback — ${(err as Error).message}`);
      }
    }

    return this.syncFallback.score(items, tokens, abortSignal);
  }

  /** @internal — terminate the underlying pool (tests / shutdown). */
  async terminate(): Promise<void> {
    if (this.pool !== null) {
      await this.pool.terminate();
      this.pool = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory + process-wide default
// ─────────────────────────────────────────────────────────────────────────────

let defaultStrategy: ArchiveScoringStrategy | null = null;

/**
 * Process-wide default archive-scoring strategy. Lazily creates an
 * {@link OffThreadArchiveScoring} on first use. All orchestrator instances
 * share one pool — a single daemon serves all concurrent sessions, so one
 * shared pool is the correct sizing unit.
 */
export function getDefaultArchiveScoring(): ArchiveScoringStrategy {
  if (defaultStrategy === null) {
    defaultStrategy = new OffThreadArchiveScoring();
  }
  return defaultStrategy;
}

/**
 * Create a fresh strategy instance (for tests that need isolation or
 * explicit control over pool size / sync vs off-thread).
 */
export function createArchiveScoring(opts?: {
  poolSize?: number;
  sync?: boolean;
}): ArchiveScoringStrategy {
  if (opts?.sync) return new SyncArchiveScoring();
  return new OffThreadArchiveScoring(opts?.poolSize);
}
