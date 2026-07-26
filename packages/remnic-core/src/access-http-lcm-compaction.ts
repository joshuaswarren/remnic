import type { ServerResponse } from "node:http";

import type { LcmCompactionFlushRequest } from "./access-schema.js";
import type { EngramAccessLcmCompactionFlushResponse, EngramAccessService } from "./access-service.js";

type LcmCompactionService = Pick<EngramAccessService, "lcmCompactionFlush">;
type JsonResponder = (res: ServerResponse, status: number, payload: unknown) => void;

export interface LcmCompactionFlushHttpOptions {
  body: LcmCompactionFlushRequest;
  service: LcmCompactionService;
  response: ServerResponse;
  ensureWriteRateLimitAvailable: () => void;
  recordWriteRateLimitHit: () => void;
  resolveNamespace: (namespace?: string) => string | undefined;
  defaultNamespace?: string;
  resolveRequestPrincipal: () => string | undefined;
  respondJson: JsonResponder;
}

export function respondLcmCompactionCapabilitiesHttp(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ lcmCompactionFlushBatch: true }, null, 2));
}

export async function handleLcmCompactionFlushHttp({
  body,
  service,
  response,
  ensureWriteRateLimitAvailable,
  recordWriteRateLimitHit,
  resolveNamespace,
  defaultNamespace,
  resolveRequestPrincipal,
  respondJson,
}: LcmCompactionFlushHttpOptions): Promise<void> {
  ensureWriteRateLimitAvailable();
  const requestedNamespaces = body.namespaces;
  if (requestedNamespaces === undefined) {
    const result = await service.lcmCompactionFlush({
      sessionKey: body.sessionKey,
      namespace: resolveNamespace(body.namespace),
      authenticatedPrincipal: resolveRequestPrincipal(),
    });
    recordWriteRateLimitHit();
    respondJson(response, 200, result);
    return;
  }
  const resolutionOutcomes = await Promise.allSettled(
    requestedNamespaces.map(async (requestedNamespace) => {
      const namespace = resolveNamespace(requestedNamespace);
      return {
        requestedNamespace,
        namespace,
        effectiveNamespace: namespace ?? defaultNamespace ?? "",
      };
    })
  );
  const uniqueResolvedNamespaces: Array<{
    requestedNamespace: string;
    namespace: string | undefined;
    effectiveNamespace: string;
  }> = [];
  const queuedEffectiveNamespaces = new Set<string>();
  for (const outcome of resolutionOutcomes) {
    if (outcome.status === "fulfilled" && !queuedEffectiveNamespaces.has(outcome.value.effectiveNamespace)) {
      queuedEffectiveNamespaces.add(outcome.value.effectiveNamespace);
      uniqueResolvedNamespaces.push(outcome.value);
    }
  }
  const serviceOutcomes = await Promise.allSettled(
    uniqueResolvedNamespaces.map(({ namespace }) =>
      service.lcmCompactionFlush({
        sessionKey: body.sessionKey,
        namespace,
        authenticatedPrincipal: resolveRequestPrincipal(),
      })
    )
  );
  type BatchResult =
    | {
        requestedNamespace: string;
        status: "fulfilled";
        result: EngramAccessLcmCompactionFlushResponse;
      }
    | { requestedNamespace: string; status: "rejected" };
  const results: BatchResult[] = [];
  const emittedEffectiveNamespaces = new Set<string>();
  let serviceOutcomeIndex = 0;
  for (const [index, outcome] of resolutionOutcomes.entries()) {
    const requestedNamespace = requestedNamespaces[index] ?? "";
    if (outcome.status === "rejected") {
      results.push({ status: "rejected", requestedNamespace });
      continue;
    }
    if (emittedEffectiveNamespaces.has(outcome.value.effectiveNamespace)) continue;
    emittedEffectiveNamespaces.add(outcome.value.effectiveNamespace);
    const serviceOutcome = serviceOutcomes[serviceOutcomeIndex++];
    if (serviceOutcome?.status === "fulfilled") {
      results.push({ status: "fulfilled", requestedNamespace, result: serviceOutcome.value });
    } else {
      results.push({ status: "rejected", requestedNamespace });
    }
  }
  recordWriteRateLimitHit();
  respondJson(response, 200, {
    enabled: results.every((result) => result.status === "fulfilled" && result.result.enabled !== false),
    flushed: results.every((result) => result.status === "fulfilled" && result.result.flushed !== false),
    sessionKey: body.sessionKey,
    namespaces: results.map(({ requestedNamespace }) => requestedNamespace),
    results: results.map(({ requestedNamespace, ...result }) => ({ ...result, namespace: requestedNamespace })),
  });
}
