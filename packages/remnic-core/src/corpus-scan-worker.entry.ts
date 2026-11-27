
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
