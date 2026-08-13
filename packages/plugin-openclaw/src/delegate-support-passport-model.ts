import {
  acceptsSupportPassportModelResponse,
  parseSupportPassportModelJob,
  SUPPORT_PASSPORT_MODEL_JOB_PATH,
  SUPPORT_PASSPORT_MODEL_RESULT_PATH,
  type SupportPassportModelRoute,
  type SupportPassportModelRouteResult,
} from "@remnic/core";
import { log } from "@remnic/core/logger";

import { daemonUrl, type DelegateDaemonTarget } from "./bridge.js";
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
}

async function post(
  target: DelegateDaemonTarget,
  serviceId: string,
  pathname: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const auth = target.resolveAuthToken();
  const response = await fetch(daemonUrl(target, pathname), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    reportDaemonAuthorizationFailure(serviceId, pathname, response.status, auth.source);
  }
  return response;
}

function abortableRetryDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, 1_000);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createDelegateSupportPassportModelService(
  options: DelegateSupportPassportModelOptions,
): DelegateSupportPassportModelService {
  let controller: AbortController | undefined;
  let worker: Promise<void> | undefined;
  const run = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      try {
        const response = await post(
          options.target,
          options.serviceId,
          SUPPORT_PASSPORT_MODEL_JOB_PATH,
          { timeoutMs: 20_000 },
          signal,
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
        const timeoutSignal = AbortSignal.timeout(job.timeoutMs);
        const modelSignal = AbortSignal.any([signal, timeoutSignal]);
        let result: SupportPassportModelRouteResult | null = null;
        try {
          result = await options.route.invoke(job.messages, {
            temperature: job.temperature,
            maxTokens: job.maxTokens,
            timeoutMs: job.timeoutMs,
            signal: modelSignal,
            operation: job.operation,
            jsonSchema: job.jsonSchema,
            acceptResponse: (candidate) =>
              acceptsSupportPassportModelResponse(job.operation, job.messages, candidate.content),
          });
        } catch (error) {
          if (signal.aborted) break;
          log.warn(`delegate support passport model call failed: ${String(error)}`);
        }
        const completion = await post(
          options.target,
          options.serviceId,
          SUPPORT_PASSPORT_MODEL_RESULT_PATH,
          { id: job.id, result },
          signal,
        );
        await completion.body?.cancel();
      } catch (error) {
        if (signal.aborted) break;
        log.warn(`delegate support passport model bridge failed: ${String(error)}`);
        await abortableRetryDelay(signal);
      }
    }
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
