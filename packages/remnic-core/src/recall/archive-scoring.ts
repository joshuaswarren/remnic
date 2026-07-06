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

/** Scoring output — maps 1:1 to the relevant QmdSearchResult fields. */
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
// Pure scoring function — shared by both strategies and by the inline worker.
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
// Inline worker code (eval mode) — eliminates file-resolution / build-config
// issues entirely. The worker is self-contained CJS (no imports), so it runs
// identically under tsx, compiled dist, and published npm packages.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inline worker source. Runs via `new Worker(code, { eval: true })`.
 *
 * MUST stay byte-identical to {@link scoreArchiveMemories} above. The
 * regression test "worker scoring matches canonical scoreArchiveMemories"
 * asserts this equivalence at runtime.
 */
const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');

function scoreArchiveMemories(items, tokens) {
  if (items.length === 0 || tokens.length === 0) return [];
  var scored = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var haystack = [item.content, item.category].concat(item.tags || []).join(' ').toLowerCase();
    var hits = 0;
    for (var j = 0; j < tokens.length; j++) {
      if (haystack.indexOf(tokens[j]) !== -1) hits++;
    }
    if (hits === 0) continue;
    scored.push({
      docid: item.id,
      path: item.path,
      score: hits / tokens.length,
      snippet: item.content.slice(0, 400).replace(/\n/g, ' '),
    });
  }
  return scored;
}

if (parentPort) {
  parentPort.on('message', function(task) {
    try {
      var results = scoreArchiveMemories(task.items, task.tokens);
      parentPort.postMessage({ ok: true, results: results });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
}
`;

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

/**
 * Safety-net timeout for a single dispatch. The cold-fallback pipeline already
 * has its own deadline mechanism (runColdStepWithinDeadline); this is a
 * last-resort guard so a hung worker never blocks recall indefinitely.
 * Generously large to avoid interfering with large corpora (issue #1674
 * reported scans up to ~70s on large archives).
 */
const DISPATCH_TIMEOUT_MS = 120_000;

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
    // If the caller already aborted before we could dispatch, return the
    // freshly-acquired worker to the idle pool instead of retiring it — it was
    // never posted to, so terminating a healthy worker is wasteful (#1674).
    if (abortSignal?.aborted) {
      this.release(worker);
      return [];
    }
    let abandoned = false;
    try {
      return await this.dispatch(worker, task, abortSignal, () => {
        abandoned = true;
      });
    } finally {
      if (abandoned) {
        // The dispatch was abandoned (timeout/abort) while the worker may
        // still be processing. Terminate it to prevent cross-request
        // contamination (a stale reply arriving on a reused worker).
        // A fresh worker will be spawned on the next acquire.
        this.retireWorker(worker);
      } else {
        this.release(worker);
      }
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

  /** Terminate a worker that may still be busy, then spawn a replacement
   *  if a waiter is queued. */
  private retireWorker(worker: Worker): void {
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) this.workers.splice(idx, 1);
    void worker.terminate();
    // If a waiter is queued, give it a fresh worker.
    const next = this.waiters.shift();
    if (next) {
      next(this.spawn());
    }
  }

  private spawn(): Worker {
    // Inline eval mode — no file resolution needed. Works identically under
    // tsx (source), compiled dist (bundled chunks), and published npm packages.
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    // Unref so idle workers never keep the event loop alive — one-shot CLIs
    // exit naturally after recall completes. During an active dispatch the
    // DISPATCH_TIMEOUT_MS timer keeps the loop alive, so worker replies are
    // always received before the process would consider exiting (#1674).
    worker.unref();
    this.workers.push(worker);
    return worker;
  }

  private dispatch(
    worker: Worker,
    task: ScoreTask,
    abortSignal: AbortSignal | undefined,
    onAbandon: () => void
  ): Promise<ArchiveScoreResult[]> {
    return new Promise<ArchiveScoreResult[]>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        onAbandon();
        log.debug(`archive-scoring dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms — worker retired, falling back to sync scoring`);
        reject(new Error(`archive-scoring dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms`));
      }, DISPATCH_TIMEOUT_MS);

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
        onAbandon();
        reject(err);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        onAbandon();
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
        // Timeout or worker error — fall back to sync scoring so recall
        // quality is never silently dropped (a timed-out dispatch used to
        // resolve with []). An already-aborted signal short-circuits first.
        if (abortSignal?.aborted) return [];
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
 * Dispose the process-wide default archive-scoring strategy, terminating any
 * worker threads. Called from `Orchestrator.destroy()` so worker threads don't
 * outlive the orchestrator (#1674). The strategy is lazily recreated on the
 * next cold-fallback recall, so this is safe to call from tests that create
 * and destroy orchestrator instances.
 */
export async function disposeDefaultArchiveScoring(): Promise<void> {
  if (defaultStrategy !== null) {
    const strategy = defaultStrategy;
    defaultStrategy = null;
    if (strategy instanceof OffThreadArchiveScoring) {
      await strategy.terminate();
    }
  }
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
