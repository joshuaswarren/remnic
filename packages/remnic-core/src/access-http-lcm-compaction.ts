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
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
      ...(body.projectTag !== undefined ? { projectTag: body.projectTag } : {}),
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
  type BatchResult =
    | {
        requestedNamespace: string;
        status: "fulfilled";
        result: EngramAccessLcmCompactionFlushResponse;
      }
    | { requestedNamespace: string; status: "rejected" };
  const results: BatchResult[] = resolutionOutcomes.map((outcome, index) => {
    const requestedNamespace = requestedNamespaces[index] ?? "";
    if (outcome.status === "rejected") {
      return { status: "rejected", requestedNamespace };
    }
    const serviceOutcome = serviceOutcomesByEffectiveNamespace.get(outcome.value.effectiveNamespace);
    return serviceOutcome?.status === "fulfilled"
      ? { status: "fulfilled", requestedNamespace, result: serviceOutcome.value }
      : { status: "rejected", requestedNamespace };
  });
  recordWriteRateLimitHit();
  respondJson(response, 200, {
    enabled: results.every((result) => result.status === "fulfilled" && result.result.enabled !== false),
    flushed: results.every((result) => result.status === "fulfilled" && result.result.flushed !== false),
    sessionKey: body.sessionKey,
    namespaces: requestedNamespaces,
    results: results.map(({ requestedNamespace, ...result }) => ({ ...result, namespace: requestedNamespace })),
  });
}
