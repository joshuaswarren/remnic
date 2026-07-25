import type { ServerResponse } from "node:http";

import type { EngramAccessService } from "./access-service.js";
import type { LcmCompactionFlushRequest } from "./access-schema.js";

type LcmCompactionService = Pick<EngramAccessService, "lcmCompactionFlush">;
type JsonResponder = (res: ServerResponse, status: number, payload: unknown) => void;

export interface LcmCompactionFlushHttpOptions {
  body: LcmCompactionFlushRequest;
  service: LcmCompactionService;
  response: ServerResponse;
  ensureWriteRateLimitAvailable: () => void;
  recordWriteRateLimitHit: () => void;
  resolveNamespace: (namespace?: string) => string | undefined;
  resolveRequestPrincipal: () => string | undefined;
  respondJson: JsonResponder;
}

export async function handleLcmCompactionFlushHttp({
  body,
  service,
  response,
  ensureWriteRateLimitAvailable,
  recordWriteRateLimitHit,
  resolveNamespace,
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

  const outcomes = await Promise.allSettled(
    requestedNamespaces.map(async (requestedNamespace) =>
      service.lcmCompactionFlush({
        sessionKey: body.sessionKey,
        namespace: resolveNamespace(requestedNamespace),
        authenticatedPrincipal: resolveRequestPrincipal(),
      }),
    ),
  );
  recordWriteRateLimitHit();
  respondJson(response, 200, {
    enabled: outcomes.every(
      (outcome) => outcome.status === "fulfilled" && outcome.value.enabled !== false,
    ),
    flushed: outcomes.every(
      (outcome) => outcome.status === "fulfilled" && outcome.value.flushed !== false,
    ),
    sessionKey: body.sessionKey,
    namespaces: requestedNamespaces,
    results: outcomes.map((outcome, index) =>
      outcome.status === "fulfilled"
        ? { status: "fulfilled", namespace: requestedNamespaces[index], result: outcome.value }
        : { status: "rejected", namespace: requestedNamespaces[index] },
    ),
  });
}
