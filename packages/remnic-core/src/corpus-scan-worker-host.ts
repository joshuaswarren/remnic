
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

export type CorpusScanJobKind = "walk" | "entity-entries-fingerprint" | "stat-mtimes";

export type CorpusScanPayload =
  | { kind: "walk"; baseDir: string; startDirs: string[]; propagateReadErrors: boolean }
  | { kind: "entity-entries-fingerprint"; entitiesDir: string }
  | { kind: "stat-mtimes"; paths: string[] };

export interface CorpusScanResults {
  walk: string[];
  "entity-entries-fingerprint": string;
  "stat-mtimes": Array<number | null>;
}

export type CorpusScanResult = string[] | string | Array<number | null>;

/** A worker-side failure, flattened for the thread boundary. */
export interface CorpusScanErrorPayload {
  name: string;
  message: string;
  code?: string;
}

export interface CorpusScanReply {
  id: number;
  ok: boolean;
  result?: CorpusScanResult;
  error?: CorpusScanErrorPayload;
}

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
      this.disableWorker(error instanceof Error ? error : new Error(String(error)));
      return await runInline(payload, this.cancellationCheck(signal));
    }
    const id = this.nextId++;
    this.setAttached(true);
    try {
      return await new Promise<CorpusScanResult>((resolve, reject) => {
        const job: PendingJob = { kind: payload.kind, resolve, reject };
        if (signal) {
          const onAbort = (): void => {
            this.cancelJob(id);
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

  private cancelJob(id: number): void {
    this.worker?.postMessage({ id, cancel: true });
  }

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

  private disableWorker(error: Error): void {
    if (this.workerUnavailable) return;
    this.workerUnavailable = true;
    log.warn("corpus scan worker unavailable; falling back to inline scans", error);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(resolveWorkerEntryUrl());
    worker.unref();
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

export const corpusScanWorker = new CorpusScanWorkerHost();
