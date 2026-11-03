/**
 * Corpus-scan worker entry (TypeScript source of the generated worker).
 *
 * The worker runs the daemon's pure, read-only corpus scans off the main event
 * loop: the recall-corpus path walk, the entity-entry fingerprint, and the
 * watermark's freshness stat. Every job carries its own inputs and returns its
 * own results, so the worker holds no state.
 *
 * This file is BUNDLED into `src/corpus-scan-worker.entry.mjs` (plain
 * JavaScript) by scripts/sync-corpus-scan-worker.mjs: a worker thread does not
 * inherit the TypeScript loader the source tree runs under, so the worker
 * entry must be JavaScript on every runtime the package supports. The bundled
 * file is committed and checked for drift by
 * scripts/check-corpus-scan-worker-sync.mjs.
 *
 * Protocol: the host posts `{ id, payload }`; the worker answers
 * `{ id, ok: true, result }` or `{ id, ok: false, error }`. A posted
 * `{ id, cancel: true }` abandons that job at its next checkpoint.
 */

import { parentPort } from "node:worker_threads";
import { abortError } from "./abort-error.js";
import {
  collectContainedMarkdownPaths,
  fingerprintEntityEntries,
  statMtimes,
} from "./corpus-scan.js";
import type {
  CorpusScanErrorPayload,
  CorpusScanPayload,
  CorpusScanResult,
} from "./corpus-scan-worker-host.js";

if (!parentPort) throw new Error("corpus scan worker must run as a worker thread");

const port = parentPort;
const cancelled = new Set<number>();

/** A thrown value from the scan code: an Error, optionally errno-coded. */
type ScanFailure = Error & { code?: string };

/** A message the host posts to the worker. */
interface CorpusScanRequestMessage {
  id: number;
  payload?: CorpusScanPayload;
  cancel?: boolean;
}

function serializeError(error: ScanFailure): CorpusScanErrorPayload {
  const payload: CorpusScanErrorPayload = {
    name: error.name,
    message: error instanceof Error ? error.message : String(error),
  };
  if (error.code !== undefined) payload.code = error.code;
  return payload;
}

async function runJob(id: number, payload: CorpusScanPayload): Promise<CorpusScanResult> {
  const checkCancelled = (): void => {
    if (cancelled.has(id)) throw abortError("corpus read aborted");
  };
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

port.on("message", (message: CorpusScanRequestMessage) => {
  if (message.cancel) {
    cancelled.add(message.id);
    return;
  }
  const { id } = message;
  const payload = message.payload;
  if (!payload) return;
  void runJob(id, payload)
    .then((result) => {
      port.postMessage({ id, ok: true, result });
    })
    .catch((error: ScanFailure) => {
      port.postMessage({ id, ok: false, error: serializeError(error) });
    })
    .finally(() => {
      cancelled.delete(id);
    });
});
