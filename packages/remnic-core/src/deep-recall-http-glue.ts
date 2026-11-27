
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
