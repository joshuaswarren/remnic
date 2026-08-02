/**
 * The blocking daemon health probe that runs on a worker thread.
 *
 * `register()` is synchronous, so consulting the daemon before deciding how to
 * register means blocking the main thread on `Atomics.wait` while a worker
 * performs the request. This module holds the worker BODY and the source text
 * it is instantiated from; it takes everything by parameter and imports
 * nothing from bridge.ts, so the two cannot form a cycle.
 */

export interface HealthWorkerData {
  state: SharedArrayBuffer;
  deadline: number;
  host: string;
  port: number;
  path: string;
  fallbackPath: string | null;
  token: string;
  /**
   * When present, a 200 response body is parsed as JSON and the string value
   * at `captureField` is written here UTF-8 encoded, length-prefixed in the
   * first 4 bytes. Absent for plain liveness probes, which never read a body.
   */
  capture?: SharedArrayBuffer;
  captureField?: string;
}

export interface HealthWorkerResponse {
  statusCode?: number;
  resume(): void;
  setEncoding?(encoding: string): void;
  on?(event: "data" | "end", handler: (chunk?: string) => void): void;
}

export interface HealthWorkerRequest {
  on(event: "error" | "timeout", handler: () => void): HealthWorkerRequest;
  destroy(): void;
  end(): void;
}

export type HealthRequest = (
  options: {
    hostname: string;
    port: number;
    path: string;
    method: "GET";
    timeout: number;
    headers: Record<string, string>;
  },
  onResponse: (response: HealthWorkerResponse) => void,
) => HealthWorkerRequest;

export function runHealthWorker(request: HealthRequest, data: HealthWorkerData): void {
  // Inlined rather than closed over: the worker runs this function's SOURCE,
  // so it can reference nothing from this module.
  const READINESS_RETRY_MS = 250;
  const view = new Int32Array(data.state);
  let completed = false;

  function finish(ok: boolean): void {
    if (completed) return;
    completed = true;
    Atomics.store(view, 0, ok ? 1 : 2);
    Atomics.notify(view, 0);
  }

  function probe(pathname: string, fallbackPath: string | null): void {
    const remainingMs = data.deadline - Date.now();
    if (remainingMs <= 0) {
      finish(false);
      return;
    }
    let responseReceived = false;
    try {
      const headers: Record<string, string> = {};
      if (data.token) headers.Authorization = `Bearer ${data.token}`;
      const req = request(
        {
          hostname: data.host,
          port: data.port,
          path: pathname,
          method: "GET",
          timeout: remainingMs,
          headers,
        },
        (res) => {
          responseReceived = true;
          const statusCode = res.statusCode;
          if (statusCode === 200 && data.capture && data.captureField && res.on) {
            // Only the capture probe reads a body; every other caller resumes
            // the stream immediately so the socket is freed.
            let body = "";
            res.setEncoding?.("utf8");
            res.on("data", (chunk) => {
              // Bound the buffered body: a runaway response must not grow the
              // worker's heap while the caller blocks on Atomics.wait.
              if (body.length < 65_536) body += chunk ?? "";
            });
            res.on("end", () => {
              try {
                const parsed: unknown = JSON.parse(body);
                const value =
                  typeof parsed === "object" && parsed !== null
                    ? (parsed as Record<string, unknown>)[data.captureField as string]
                    : undefined;
                if (typeof value === "string") {
                  const bytes = new TextEncoder().encode(value);
                  const capture = new Uint8Array(data.capture as SharedArrayBuffer);
                  // Record the TRUE byte length even when it does not fit, so
                  // the reader can tell "too long to carry" from a short value
                  // and treat it as unknown instead of truncated.
                  new DataView(data.capture as SharedArrayBuffer).setUint32(0, bytes.length);
                  if (bytes.length <= capture.length - 4) capture.set(bytes, 4);
                }
              } catch {
                // A malformed body leaves the capture empty; the caller treats
                // an empty capture as "unknown", never as a match.
              }
              finish(true);
            });
            return;
          }
          res.resume();
          if (statusCode === 200) {
            finish(true);
          } else if (statusCode === 404 && fallbackPath) {
            probe(fallbackPath, null);
          } else if (statusCode === 503) {
            // The daemon is listening but its readiness gate is still closed
            // (deferred warmup). When the gateway and the service start
            // together this is a matter of seconds - treating it as "no
            // daemon" would start a second orchestrator on its corpus. Retry
            // within the SAME preflight deadline the caller already budgeted.
            if (Date.now() + READINESS_RETRY_MS >= data.deadline) {
              finish(false);
              return;
            }
            setTimeout(() => probe(pathname, fallbackPath), READINESS_RETRY_MS);
          } else {
            finish(false);
          }
        },
      );
      req.on("error", () => {
        if (!responseReceived) finish(false);
      });
      req.on("timeout", () => {
        req.destroy();
        if (!responseReceived) finish(false);
      });
      req.end();
    } catch {
      finish(false);
    }
  }

  probe(data.path, data.fallbackPath);
}

export const HEALTH_WORKER_SOURCE = `
import { request } from "node:http";
import { workerData } from "node:worker_threads";
const __name = (target) => target;
(${runHealthWorker.toString()})(request, workerData);
`;
