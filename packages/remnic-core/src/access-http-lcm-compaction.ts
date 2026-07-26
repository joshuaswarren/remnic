import type { ServerResponse } from "node:http";

import type { LcmCompactionFlushRequest, LcmCompactionRecordRequest } from "./access-schema.js";
import type {
  EngramAccessLcmCompactionFlushResponse,
  EngramAccessLcmCompactionRecordResponse,
  EngramAccessService,
} from "./access-service.js";

type LcmCompactionService = Pick<EngramAccessService, "lcmCompactionFlush" | "lcmCompactionRecord">;
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

export interface LcmCompactionFlushRunnerOptions {
  body: LcmCompactionFlushRequest;
  service: LcmCompactionService;
  ensureWriteRateLimitAvailable: () => void;
  recordWriteRateLimitHit: () => void;
  resolveNamespace: (namespace?: string) => string | undefined;
  defaultNamespace?: string;
  resolveRequestPrincipal: () => string | undefined;
}

type LcmCompactionFlushBatchResult =
  | {
      namespace: string;
      status: "fulfilled";
      result: EngramAccessLcmCompactionFlushResponse;
    }
  | { namespace: string; status: "rejected" };

type LcmCompactionFlushHttpResult =
  | EngramAccessLcmCompactionFlushResponse
  | {
      enabled: boolean;
      flushed: boolean;
      sessionKey: string;
      namespaces: string[];
      results: LcmCompactionFlushBatchResult[];
    };

export async function runLcmCompactionFlushHttp({
  body,
  service,
  ensureWriteRateLimitAvailable,
  recordWriteRateLimitHit,
  resolveNamespace,
  defaultNamespace,
  resolveRequestPrincipal,
}: LcmCompactionFlushRunnerOptions): Promise<LcmCompactionFlushHttpResult> {
  ensureWriteRateLimitAvailable();
  const requestedNamespaces = body.namespaces;
  if (requestedNamespaces === undefined) {
    const result = await service.lcmCompactionFlush({
      sessionKey: body.sessionKey,
      namespace: resolveNamespace(body.namespace),
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
      ...(body.projectTag !== undefined ? { projectTag: body.projectTag } : {}),
      authenticatedPrincipal: resolveRequestPrincipal(),
    });
    recordWriteRateLimitHit();
    return result;
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
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.projectTag !== undefined ? { projectTag: body.projectTag } : {}),
        authenticatedPrincipal: resolveRequestPrincipal(),
      })
    )
  );
  const serviceOutcomesByEffectiveNamespace = new Map<
    string,
    PromiseSettledResult<EngramAccessLcmCompactionFlushResponse>
  >();
  for (const [index, resolved] of uniqueResolvedNamespaces.entries()) {
    const serviceOutcome = serviceOutcomes[index];
    if (serviceOutcome !== undefined) {
      serviceOutcomesByEffectiveNamespace.set(resolved.effectiveNamespace, serviceOutcome);
    }
  }
  const results = resolutionOutcomes.map((outcome, index): LcmCompactionFlushBatchResult => {
    const requestedNamespace = requestedNamespaces[index] ?? "";
    if (outcome.status === "rejected") {
      return { status: "rejected", namespace: requestedNamespace };
    }
    const serviceOutcome = serviceOutcomesByEffectiveNamespace.get(outcome.value.effectiveNamespace);
    return serviceOutcome?.status === "fulfilled"
      ? { status: "fulfilled", namespace: requestedNamespace, result: serviceOutcome.value }
      : { status: "rejected", namespace: requestedNamespace };
  });
  recordWriteRateLimitHit();
  return {
    enabled: results.every((result) => result.status === "fulfilled" && result.result.enabled !== false),
    flushed: results.every((result) => result.status === "fulfilled" && result.result.flushed !== false),
    sessionKey: body.sessionKey,
    namespaces: requestedNamespaces,
    results,
  };
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
  const result = await runLcmCompactionFlushHttp({
    body,
    service,
    ensureWriteRateLimitAvailable,
    recordWriteRateLimitHit,
    resolveNamespace,
    defaultNamespace,
    resolveRequestPrincipal,
  });
  respondJson(response, 200, result);
}

export interface LcmCompactionRecordHttpOptions {
  body: LcmCompactionRecordRequest;
  service: LcmCompactionService;
  ensureWriteRateLimitAvailable: () => void;
  recordWriteRateLimitHit: () => void;
  resolveNamespace: (namespace?: string) => string | undefined;
  resolveRequestPrincipal: () => string | undefined;
}

export async function runLcmCompactionRecordHttp({
  body,
  service,
  ensureWriteRateLimitAvailable,
  recordWriteRateLimitHit,
  resolveNamespace,
  resolveRequestPrincipal,
}: LcmCompactionRecordHttpOptions): Promise<EngramAccessLcmCompactionRecordResponse> {
  ensureWriteRateLimitAvailable();
  const response = await service.lcmCompactionRecord({
    sessionKey: body.sessionKey,
    namespace: resolveNamespace(body.namespace),
    tokensBefore: body.tokensBefore,
    tokensAfter: body.tokensAfter,
    authenticatedPrincipal: resolveRequestPrincipal(),
  });
  recordWriteRateLimitHit();
  return response;
}
