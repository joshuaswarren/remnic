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

type RespondJson = (res: ServerResponse, status: number, payload: unknown) => void;
type ReadJsonBody = (req: IncomingMessage) => Promise<unknown>;

function coerceMaxSteps(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new EngramAccessInputError("maxSteps must be a non-negative integer");
  }
  return value;
}

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
   */
  scopeFor: (bodyNamespace?: string, bodySessionKey?: string) => { namespace?: string; sessionKey?: string },
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
  const maxSteps = coerceMaxSteps(parsed.data.maxSteps);
  const scope = scopeFor(parsed.data.namespace, parsed.data.sessionKey);
  const result = await service.deepRecall({
    query: parsed.data.query,
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    namespace: scope.namespace,
    sessionKey: scope.sessionKey,
  });
  respondJson(res, 200, result);
}
