import {
  SUPPORT_PASSPORT_MODEL_JOB_PATH,
  SUPPORT_PASSPORT_MODEL_RESULT_PATH,
  type SupportPassportModelRoute,
  type SupportPassportModelRouteResult,
  acceptsSupportPassportModelResponse,
  parseSupportPassportModelJob,
} from "@remnic/core";
import { log } from "@remnic/core/logger";

import { type DelegateDaemonTarget, daemonUrl } from "./bridge.js";
import { reportDaemonAuthorizationFailure } from "./delegate-authorization.js";

export interface DelegateSupportPassportModelService {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DelegateSupportPassportModelOptions {
  serviceId: string;
  target: DelegateDaemonTarget;
  route: SupportPassportModelRoute;
  requestTimeoutMs?: number;
}

const MODEL_WORKER_COUNT = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const RESULT_REQUEST_TIMEOUT_MS = 5_000;
const RESULT_RETRY_DELAY_MS = 1_000;
const SHUTDOWN_RESULT_REQUEST_TIMEOUT_MS = 250;

async function post(
  target: DelegateDaemonTarget,
  serviceId: string,
  pathname: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Response> {
  const auth = target.resolveAuthToken();
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const response = await fetch(daemonUrl(target, pathname), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: requestSignal,
  });
  if (response.status === 401 || response.status === 403) {
    reportDaemonAuthorizationFailure(serviceId, pathname, response.status, auth.source);
  }
  return response;
}

function abortableRetryDelay(signal: AbortSignal, delayMs = RESULT_RETRY_DELAY_MS): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createDelegateSupportPassportModelService(
  options: DelegateSupportPassportModelOptions
): DelegateSupportPassportModelService {
  let controller: AbortController | undefined;
  let worker: Promise<void> | undefined;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("requestTimeoutMs must be a positive integer");
  }
  const invoke = async (
    job: NonNullable<ReturnType<typeof parseSupportPassportModelJob>>,
    signal: AbortSignal
  ): Promise<SupportPassportModelRouteResult | null> => {
    const remainingMs = job.deadlineAt - Date.now();
    if (remainingMs <= 0) return null;
    const timeoutSignal = AbortSignal.timeout(remainingMs);
    const modelSignal = AbortSignal.any([signal, timeoutSignal]);
    if (modelSignal.aborted) return null;
    let removeAbort = (): void => {};
    const aborted = new Promise<null>((resolve) => {
      const onAbort = (): void => resolve(null);
      modelSignal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => modelSignal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([
        options.route.invoke(job.messages, {
          temperature: job.temperature,
          maxTokens: job.maxTokens,
          timeoutMs: remainingMs,
          signal: modelSignal,
          operation: job.operation,
          jsonSchema: job.jsonSchema,
          acceptResponse: (candidate) =>
            acceptsSupportPassportModelResponse(job.operation, job.messages, candidate.content),
        }),
        aborted,
      ]);
    } catch (error) {
      if (!modelSignal.aborted) {
        log.warn(`delegate support passport model call failed: ${String(error)}`);
      }
      return null;
    } finally {
      removeAbort();
    }
  };
  const complete = async (
    job: NonNullable<ReturnType<typeof parseSupportPassportModelJob>>,
    result: SupportPassportModelRouteResult | null,
    signal: AbortSignal
  ): Promise<void> => {
    if (signal.aborted) {
      const remainingMs = job.deadlineAt - Date.now();
      if (remainingMs <= 0) return;
      const shutdownTimeoutMs = Math.min(SHUTDOWN_RESULT_REQUEST_TIMEOUT_MS, remainingMs);
      const completion = await post(
        options.target,
        options.serviceId,
        SUPPORT_PASSPORT_MODEL_RESULT_PATH,
        { id: job.id, result },
        AbortSignal.timeout(shutdownTimeoutMs),
        shutdownTimeoutMs
      );
      await completion.body?.cancel();
      if (!completion.ok && completion.status !== 404) {
        throw new Error(`delegate support passport model completion was rejected with HTTP ${completion.status}`);
      }
      return;
    }
    let lastFailure = "the job deadline elapsed";
    while (!signal.aborted && Date.now() < job.deadlineAt) {
      const remainingMs = job.deadlineAt - Date.now();
      let completion: Response;
      try {
        completion = await post(
          options.target,
          options.serviceId,
          SUPPORT_PASSPORT_MODEL_RESULT_PATH,
          { id: job.id, result },
          signal,
          Math.min(RESULT_REQUEST_TIMEOUT_MS, remainingMs)
        );
      } catch (error) {
        if (signal.aborted) return;
        lastFailure = String(error);
        const retryDelayMs = Math.min(RESULT_RETRY_DELAY_MS, job.deadlineAt - Date.now());
        if (retryDelayMs > 0) await abortableRetryDelay(signal, retryDelayMs);
        continue;
      }
      const status = completion.status;
      await completion.body?.cancel();
      if (completion.ok) return;
      if (status !== 408 && status !== 425 && status !== 429 && status < 500) {
        throw new Error(`delegate support passport model completion was rejected with HTTP ${status}`);
      }
      if (signal.aborted) return;
      lastFailure = `HTTP ${status}`;
      const retryDelayMs = Math.min(RESULT_RETRY_DELAY_MS, job.deadlineAt - Date.now());
      if (retryDelayMs > 0) await abortableRetryDelay(signal, retryDelayMs);
    }
    if (signal.aborted) return;
    throw new Error(`delegate support passport model completion missed its deadline after ${lastFailure}`);
  };
  const runPoller = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      try {
        const response = await post(
          options.target,
          options.serviceId,
          SUPPORT_PASSPORT_MODEL_JOB_PATH,
          { timeoutMs: 20_000 },
          signal,
          requestTimeoutMs
        );
        if (response.status === 204) continue;
        if (!response.ok) {
          await response.body?.cancel();
          await abortableRetryDelay(signal);
          continue;
        }
        const job = parseSupportPassportModelJob(await response.json());
        if (!job) {
          log.warn("delegate support passport model bridge received an invalid job");
          continue;
        }
        if (job.deadlineAt <= Date.now()) continue;
        try {
          await complete(job, await invoke(job, signal), signal);
        } catch (error) {
          log.warn(`delegate support passport model completion failed: ${String(error)}`);
        }
      } catch (error) {
        if (signal.aborted) break;
        log.warn(`delegate support passport model bridge failed: ${String(error)}`);
        await abortableRetryDelay(signal);
      }
    }
  };
  const run = async (signal: AbortSignal): Promise<void> => {
    await Promise.all(Array.from({ length: MODEL_WORKER_COUNT }, () => runPoller(signal)));
  };
  return {
    id: `${options.serviceId}:support-passport-model`,
    async start() {
      if (worker) return;
      controller = new AbortController();
      worker = run(controller.signal).finally(() => {
        worker = undefined;
        controller = undefined;
      });
    },
    async stop() {
      controller?.abort();
      await worker;
    },
  };
}
