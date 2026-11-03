/**
 * Corpus-scan worker host (main-thread starvation fix).
 *
 * The periodic corpus maintenance scans are pure, read-only filesystem work
 * whose volume scales with the corpus (hundreds of thousands of files on a
 * large deployment). Running them on the daemon's main thread starves observe,
 * recall and the extraction queue: every awaited syscall is a main-thread
 * continuation.
 *
 * This host runs the scans in ONE `worker_threads` worker so the main thread
 * stays free. The worker entry is plain JavaScript
 * (`corpus-scan-worker.entry.mjs`, generated from the TypeScript source), so
 * it loads on every runtime the package supports — no TypeScript loader is
 * needed inside a worker thread.
 *
 * Lifecycle:
 *   - lazy spawn on the first job; `unref()`ed, so it never keeps the process
 *     alive;
 *   - a cancelled job is rejected on the main thread immediately and the
 *     worker is told to stop the walk at its next checkpoint;
 *   - a worker that cannot start (or dies before answering) makes the host run
 *     the SAME implementation inline, so the scan still happens;
 *   - `close()` terminates the worker and rejects in-flight jobs.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { abortError } from "./abort-error.js";
import { log } from "./logger.js";
import {
  collectContainedMarkdownPaths,
  fingerprintEntityEntries,
  statMtimes,
} from "./corpus-scan.js";

/** The scans the worker can run. */
export type CorpusScanJobKind = "walk" | "entity-entries-fingerprint" | "stat-mtimes";

/** Job payloads, one per kind. */
export type CorpusScanPayload =
  | { kind: "walk"; baseDir: string; startDirs: string[]; propagateReadErrors: boolean }
  | { kind: "entity-entries-fingerprint"; entitiesDir: string }
  | { kind: "stat-mtimes"; paths: string[] };

/** Result shape per job kind. */
export interface CorpusScanResults {
  walk: string[];
  "entity-entries-fingerprint": string;
  "stat-mtimes": Array<number | null>;
}

/** Every result shape the worker can return, in one union. */
export type CorpusScanResult = string[] | string | Array<number | null>;

/** A worker-side failure, flattened for the thread boundary. */
export interface CorpusScanErrorPayload {
  name: string;
  message: string;
  code?: string;
}

/** A message posted back from the worker. */
export interface CorpusScanReply {
  id: number;
  ok: boolean;
  result?: CorpusScanResult;
  error?: CorpusScanErrorPayload;
}

/** Completed-job counters per kind. */
export interface CorpusScanStats {
  jobs: number;
  byKind: Record<string, number>;
}

interface PendingJob {
  kind: CorpusScanJobKind;
  resolve: (value: CorpusScanResult) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
}

/**
 * Resolve the worker entry beside THIS module: the source tree keeps the
 * generated JavaScript entry at `src/corpus-scan-worker.entry.mjs` and the
 * built package copies it next to the bundled host, so the same relative path
 * works in both.
 */
function resolveWorkerEntryUrl(): URL {
  const candidates = [
    "./corpus-scan-worker.entry.mjs",
    "../corpus-scan-worker.entry.mjs",
  ];
  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  throw new Error(`corpus scan worker entry not found (looked for ${candidates.join(", ")})`);
}

function toError(payload: CorpusScanErrorPayload, fallback: string): Error {
  const error = new Error(payload.message === "" ? fallback : payload.message);
  error.name = payload.name;
  if (payload.code !== undefined) {
    // SAFETY: the errno `code` is an optional string on an Error, and the
    // worker only forwards a code it read off a filesystem rejection.
    const errno = error as NodeJS.ErrnoException;
    errno.code = payload.code;
  }
  return error;
}

/** Run the same scan inline (the fallback when no worker is available). */
async function runInline(payload: CorpusScanPayload, checkCancelled?: () => void): Promise<CorpusScanResult> {
  switch (payload.kind) {
    case "walk":
      return await collectContainedMarkdownPaths({
        baseDir: payload.baseDir,
        startDirs: payload.startDirs,
        propagateReadErrors: payload.propagateReadErrors,
        checkCancelled,
      });
    case "entity-entries-fingerprint":
      return await fingerprintEntityEntries(payload.entitiesDir);
    case "stat-mtimes":
      return await statMtimes(payload.paths);
  }
}

export class CorpusScanWorkerHost {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingJob>();
  private nextId = 1;
  private readonly jobCounts = new Map<CorpusScanJobKind, number>();
  private attached = false;
  private workerUnavailable = false;

  /** Completed jobs per kind — observability for tests and diagnostics. */
  public stats(): CorpusScanStats {
    const byKind: Record<string, number> = {};
    let jobs = 0;
    for (const [kind, count] of this.jobCounts) {
      byKind[kind] = count;
      jobs += count;
    }
    return { jobs, byKind };
  }

  /**
   * Run one scan. It executes in the worker; when no worker can run it, the
   * same implementation runs inline. Rejects with the job's error (errno code
   * preserved) or an AbortError when `signal` fires first.
   */
  public async request<P extends CorpusScanPayload>(
    payload: P,
    signal?: AbortSignal,
  ): Promise<CorpusScanResults[P["kind"]]> {
    if (signal?.aborted) throw abortError("corpus read aborted");
    const result = await this.runInWorker(payload, signal);
    // SAFETY: the worker answers with the result type of the job it was given,
    // and the kind is part of the request, so the pair holds.
    return result as CorpusScanResults[P["kind"]];
  }

  private async runInWorker(payload: CorpusScanPayload, signal?: AbortSignal): Promise<CorpusScanResult> {
    if (this.workerUnavailable) {
      return await runInline(payload, this.cancellationCheck(signal));
    }
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      // No worker available (missing entry, unsupported runtime): the scan
      // still happens, on this thread. Report the fallback once: every later
      // scan would otherwise run inline silently.
      // SAFETY: ensureWorker throws only its own Error; normalize anything else
      // so the disabled reason is always a real Error instance.
      this.disableWorker(error instanceof Error ? error : new Error(String(error)));
      return await runInline(payload, this.cancellationCheck(signal));
    }
    const id = this.nextId++;
    // Keep the process alive while a job is in flight; release it when the
    // queue drains so an idle worker never holds the event loop open.
    this.setAttached(true);
    try {
      return await new Promise<CorpusScanResult>((resolve, reject) => {
        const job: PendingJob = { kind: payload.kind, resolve, reject };
        if (signal) {
          const onAbort = (): void => {
            this.cancelJob(id);
            // Drop the job now: the worker's late reply is ignored, and the
            // queue must not stay "busy" for a job nobody awaits.
            this.pending.delete(id);
            if (this.pending.size === 0) this.setAttached(false);
            reject(abortError("corpus read aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          job.cleanup = () => signal.removeEventListener("abort", onAbort);
        }
        this.pending.set(id, job);
        worker.postMessage({ id, payload });
      });
    } catch (error) {
      // A worker that died before answering leaves the scan undone: run it
      // inline so the caller still gets its result.
      if (!this.pending.has(id) && this.workerUnavailable) {
        return await runInline(payload, this.cancellationCheck(signal));
      }
      throw error;
    }
  }

  private cancellationCheck(signal?: AbortSignal): (() => void) | undefined {
    if (!signal) return undefined;
    return () => {
      if (signal.aborted) throw abortError("corpus read aborted");
    };
  }

  /** Tell the worker to abandon a job (its next checkpoint stops the walk). */
  private cancelJob(id: number): void {
    this.worker?.postMessage({ id, cancel: true });
  }

  /**
   * Attach/detach the worker's message listener. A worker with a `message`
   * listener keeps the parent's event loop alive (the port stays ref'd), so an
   * idle worker is detached: the daemon must be able to exit with a warm
   * corpus-scan worker in memory.
   */
  private setAttached(attached: boolean): void {
    const worker = this.worker;
    if (!worker) return;
    if (attached) {
      if (!this.attached) {
        worker.on("message", this.onMessage);
        this.attached = true;
      }
      worker.ref();
    } else {
      if (this.attached) {
        worker.removeAllListeners("message");
        this.attached = false;
      }
      worker.unref();
    }
  }

  private readonly onMessage = (message: CorpusScanReply): void => {
    const job = this.pending.get(message.id);
    if (!job) return;
    this.pending.delete(message.id);
    job.cleanup?.();
    this.jobCounts.set(job.kind, (this.jobCounts.get(job.kind) ?? 0) + 1);
    if (message.ok && message.result !== undefined) job.resolve(message.result);
    else job.reject(toError(message.error ?? { name: "Error", message: "corpus scan worker job failed" }, "corpus scan worker job failed"));
    if (this.pending.size === 0) this.setAttached(false);
  };

  /**
   * Disable the worker and say why, exactly once: after this, every corpus
   * scan runs inline on the main thread, which is the starvation this module
   * exists to avoid. Silence here would hide the regression.
   */
  private disableWorker(error: Error): void {
    if (this.workerUnavailable) return;
    this.workerUnavailable = true;
    log.warn("corpus scan worker unavailable; falling back to inline scans", error);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(resolveWorkerEntryUrl());
    worker.unref();
    // Events from a worker that is no longer current (closed, replaced) must
    // not touch jobs that belong to its successor: `exit` is delivered after
    // `terminate()` resolves, by which time a new worker may own the queue.
    worker.on("error", (error: Error) => {
      if (this.worker !== worker) return;
      this.failAll(error);
      this.disableWorker(error);
    });
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.attached = false;
      this.failAll(new Error("corpus scan worker exited"));
    });
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    for (const [id, job] of [...this.pending]) {
      this.pending.delete(id);
      job.cleanup?.();
      job.reject(error);
    }
  }

  /**
   * Terminate the worker and reject in-flight jobs. The next request spawns a
   * fresh worker, so a shutdown (or a test teardown) leaves no handle behind.
   */
  public close(): void {
    const worker = this.worker;
    this.worker = null;
    this.attached = false;
    this.failAll(new Error("corpus scan worker closed"));
    void worker?.terminate();
  }
}

/** Process-wide corpus-scan worker. */
export const corpusScanWorker = new CorpusScanWorkerHost();
