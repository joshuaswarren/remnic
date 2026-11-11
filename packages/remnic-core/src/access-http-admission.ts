import type { ServerResponse } from "node:http";

import { log } from "./logger.js";

/** Advisory backpressure hint for 503 buffer_admission_refused (optional; removable without a contract change). */
const BUFFER_ADMISSION_RETRY_AFTER_SECONDS = 5;

/**
 * Map durable-capture admission failures to HTTP answers. Returns true when the
 * error was answered. A missing storage target is a permanent client fault (400,
 * never retryable); a full buffer is retryable backpressure (503) that is logged
 * with the request correlation id, not as a server fault.
 */
export function respondBufferAdmissionError(
  err: Error,
  res: ServerResponse,
  correlationId: string,
  respond: (status: number, body: Record<string, unknown>) => void,
): boolean {
  if (err.name === "StorageTargetRequiredError") {
    respond(400, { error: err.message, code: "storage_target_required" });
    return true;
  }
  if (err.name === "ReplayAdmissionRefusedError") {
    log.warn(`engram access HTTP buffer admission refused [${correlationId}]: ${err.message}`);
    res.setHeader("retry-after", String(BUFFER_ADMISSION_RETRY_AFTER_SECONDS));
    respond(503, { error: err.message, code: "buffer_admission_refused" });
    return true;
  }
  return false;
}
