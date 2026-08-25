/**
 * Deep-recall HTTP glue (issue #2332) — route body lives here so
 * access-http.ts stays at its structural ceiling (same seam as
 * meetings/http-glue.ts and location/http-glue.ts).
 *
 * Input errors map to 400; everything else rethrows so backend faults keep
 * flowing to the global 500 handler. `deepRecall.enabled` gating lives in
 * EngramAccessService — this module only translates transport shape.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { deepRecallRequestSchema } from "./access-schema.js";
import { EngramAccessInputError } from "./access-errors.js";
import type { EngramAccessService } from "./access-service.js";
import { parseDeepRecallMaxSteps } from "./deep-recall-config.js";

type RespondJson = (res: ServerResponse, status: number, payload: unknown) => void;
type ReadJsonBody = (req: IncomingMessage) => Promise<unknown>;

export async function respondDeepRecall(
  req: IncomingMessage,
  res: ServerResponse,
  respondJson: RespondJson,
  readJsonBody: ReadJsonBody,
  service: EngramAccessService,
  /**
   * Resolve the caller scope for a body-supplied namespace/sessionKey. The
   * body `namespace` is user-controlled, so it MUST flow through the SAME
   * effective-namespace allow-list gate as the query-string value (issue
   * #1850 finding 2 / #2332 review): a scoped bearer that passes an allowed
   * `?namespace=` while setting a different `namespace` in the body would
   * otherwise read another tenant. access-http supplies the gate and applies
   * the query-string fallback, so this module never selects a namespace of
   * its own. Throws 403 when the effective namespace is not permitted.
   *
   * `authenticatedPrincipal` is the identity the transport authenticated, and
   * it MUST reach the service: authorization and the audit trail derive from
   * the presenting principal, never from the client-supplied `sessionKey`.
   * Dropping it let a crafted key matching another principal rule read that
   * principal's namespaces, and made a legitimate namespace-enabled request
   * with no session key fail as unauthenticated.
   */
  scopeFor: (
    bodyNamespace?: string,
    bodySessionKey?: string,
  ) => { namespace?: string; sessionKey?: string; authenticatedPrincipal?: string },
  /** Transport cancellation (issue #2915): aborts seed search, graph reads, policy calls. */
  abortSignal?: AbortSignal,
): Promise<void> {
  const parsed = deepRecallRequestSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    respondJson(
      res,
      400,
      { error: "invalid_request", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
    );
    return;
  }
  let maxSteps: number | undefined;
  try {
    maxSteps = parseDeepRecallMaxSteps(parsed.data.maxSteps);
  } catch (err) {
    throw new EngramAccessInputError(err instanceof Error ? err.message : String(err));
  }
  const scope = scopeFor(parsed.data.namespace, parsed.data.sessionKey);
  const result = await service.deepRecall({
    query: parsed.data.query,
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    namespace: scope.namespace,
    sessionKey: scope.sessionKey,
    authenticatedPrincipal: scope.authenticatedPrincipal,
    ...(abortSignal ? { abortSignal } : {}),
  });
  respondJson(res, 200, result);
}
