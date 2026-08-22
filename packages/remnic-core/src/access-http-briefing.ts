import { getOperation } from "./access-boundary.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";

type JsonResponder = (status: number, payload: unknown) => void;

export interface BriefingHttpOptions {
  /** Request body already run through the namespace gate (gatedBodyNamespace). */
  gatedBody: Record<string, unknown>;
  service: EngramAccessService;
  principal: string | undefined;
  respondJson: JsonResponder;
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
  const output = (await op.run(options.gatedBody, {
    service: options.service,
    authenticatedPrincipal: options.principal,
  })) as { result: unknown };
  options.respondJson(200, output.result);
}
