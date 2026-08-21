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
  scope: { namespace?: string; sessionKey?: string } = {}
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
  const result = await service.deepRecall({
    query: parsed.data.query,
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    namespace: parsed.data.namespace ?? scope.namespace,
    sessionKey: parsed.data.sessionKey ?? scope.sessionKey,
  });
  respondJson(res, 200, result);
}
