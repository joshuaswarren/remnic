import { getOperation } from "./access-boundary.js";
import { BriefingTimeoutError } from "./briefing-deadline.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";

type JsonResponder = (status: number, payload: unknown) => void;

export interface BriefingHttpOptions {
  /** Request body already run through the namespace gate (gatedBodyNamespace). */
  gatedBody: Record<string, unknown>;
  service: EngramAccessService;
  principal: string | undefined;
  respondJson: JsonResponder;
  /** HTTP request lifetime; aborting it stops the briefing (issue #3139). */
  abortSignal?: AbortSignal;
}

/**
 * POST /engram/v1/briefing — daily briefing over the access HTTP boundary.
 *
 * Dispatches the registered `briefing` boundary operation (the one the MCP
 * tool uses) so schema validation, namespace gating, and principal
 * propagation reach every HTTP briefing call — the same shape as the
 * coding/delta read dispatch. Pure read: nothing persists, so no
 * write-quota accounting. The operation result already carries both
 * renderings (markdown + json sections) in one response, letting thin
 * clients render without a CLI subprocess.
 */
export async function respondBriefingHttp(options: BriefingHttpOptions): Promise<void> {
  const op = getOperation("briefing");
  if (!op) {
    throw new EngramAccessInputError("access-boundary: operation not registered: briefing");
  }
  try {
    // SAFETY: the built-in briefing operation returns { result }; this adapter passes it through unchanged.
    const output = (await op.run(options.gatedBody, {
      service: options.service,
      authenticatedPrincipal: options.principal,
      abortSignal: options.abortSignal,
    })) as { result: unknown };
    options.respondJson(200, output.result);
  } catch (err) {
    // An exhausted budget is a gateway timeout the client can tell from a crash.
    if (!(err instanceof BriefingTimeoutError)) throw err;
    options.respondJson(504, { error: err.message, code: "briefing_timeout" });
  }
}
