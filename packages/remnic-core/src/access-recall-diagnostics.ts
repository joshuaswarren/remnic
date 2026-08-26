/**
 * Surface glue for the two recall-diagnostics reads (issue #3033).
 *
 * `access-http.ts` is at its file-size ratchet ceiling, so the route bodies
 * live here and the router keeps only a thin dispatch line each (AGENTS.md:
 * extract the addition to a sibling module). The pre-existing X-ray route
 * body moved here unchanged for the same reason and because the two reads
 * belong together — `xray` explains the results a recall returned, `why`
 * explains the ones it did not.
 *
 * Both helpers return `{ status, body }` rather than writing to the response
 * so they stay unit-testable, matching `handleWhoKnowsHttpQuery`.
 */

import { EngramAccessInputError } from "./access-errors.js";
import type { McpTool } from "./access-mcp.js";
import { RecallWhyInputError } from "./recall-why.js";
import type { RecallWhyRequest, RecallWhyResponse } from "./recall-why-service.js";
import { isRecallDisclosure, type RecallDisclosure } from "./types.js";

export interface RecallDiagnosticsHttpOutcome {
  status: number;
  body: unknown;
}

/**
 * `remnic.recall_why` / `engram.recall_why`. `withToolAliases` in
 * `access-mcp.ts` emits the canonical `remnic.` alias automatically
 * (dual-naming invariant for every new MCP tool).
 */
export const RECALL_WHY_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.recall_why",
    description:
      "Diagnose why a query did NOT surface an expected memory (issue #3033). Replays the real recall once and attributes the outcome to pipeline stages (retrieval -> policy filters -> rerank -> cap -> format) with per-drop reasons. Pass `expect` with a memory id or substring to get the exact stage that dropped it plus a remediation hint. Read-only; never mutates memory, and never gated behind recallDirectAnswerEnabled. A search-backend outage reports backend_unavailable rather than an empty pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The prompt that failed to recall what you expected. Required; non-empty.",
        },
        expect: {
          type: "string",
          description:
            "Memory id, or a substring of an id or path, to trace through every stage. Omit for a whole-pipeline report.",
        },
        sessionKey: {
          type: "string",
          description: "Optional session key to scope the diagnosis.",
        },
        namespace: {
          type: "string",
          description:
            "Optional namespace. Enforced against the caller's principal; a denial yields reportFound:false.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/**
 * `GET /engram/v1/recall/why` (and the `/remnic/v1/...` spelling).
 *
 * Invalid input is a 400 rather than a silent default (Review Prevention
 * Checklist #1 / #39). Backend faults are NOT mapped here: an outage is
 * reported inside the 200 body as `backend_unavailable`, and a genuine
 * server-side fault rethrows so the router returns 500 and logs it.
 */
export async function handleRecallWhyHttpQuery(deps: {
  getParam: (name: string) => string | null;
  resolveNamespace: (namespace: string | undefined) => string | undefined;
  principal?: string;
  connector?: string;
  run: (request: RecallWhyRequest) => Promise<RecallWhyResponse>;
}): Promise<RecallDiagnosticsHttpOutcome> {
  const queryParam = deps.getParam("q");
  if (queryParam === null || queryParam.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: "missing_query",
        code: "missing_query",
        message: "q search parameter is required and must be non-empty",
      },
    };
  }
  // `expect` is optional, but an explicitly-supplied blank value is a caller
  // mistake, not a request for the whole-pipeline report.
  const expectParam = deps.getParam("expect");
  if (expectParam !== null && expectParam.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: "invalid_expect",
        code: "invalid_expect",
        message: "expect must be non-empty when supplied",
      },
    };
  }
  const sessionParam = deps.getParam("session");
  const namespaceParam = deps.getParam("namespace");
  // Always resolve (and allow-list check) the effective namespace, even when
  // the param is omitted — the implicit default namespace is still a
  // namespace every other GET route gates the same way.
  const namespace = deps.resolveNamespace(
    namespaceParam !== null && namespaceParam.length > 0 ? namespaceParam : undefined,
  );
  try {
    return {
      status: 200,
      body: await deps.run({
        query: queryParam,
        ...(expectParam !== null ? { expect: expectParam } : {}),
        ...(sessionParam !== null && sessionParam.length > 0 ? { sessionKey: sessionParam } : {}),
        ...(namespace !== undefined ? { namespace } : {}),
        ...(deps.principal ? { authenticatedPrincipal: deps.principal } : {}),
        ...(deps.connector ? { sourceConnector: deps.connector } : {}),
      }),
    };
  } catch (err) {
    if (err instanceof RecallWhyInputError || err instanceof EngramAccessInputError) {
      return {
        status: 400,
        body: { error: "invalid_request", code: "invalid_request", message: err.message },
      };
    }
    throw err;
  }
}

/**
 * `GET /engram/v1/recall/xray`. Moved here verbatim from `access-http.ts`
 * (issue #570 PR 4 behaviour is unchanged): bearer auth and namespace scope
 * are still enforced by the router before this runs; the query comes from
 * `q` so GET stays cacheable, and `namespace` / `session` / `budget` /
 * `disclosure` stay optional.
 */
export async function handleRecallXrayHttpQuery<TResponse>(deps: {
  getParam: (name: string) => string | null;
  resolveNamespace: (namespace: string | undefined) => string | undefined;
  principal?: string;
  connector?: string;
  run: (request: {
    query: string;
    sessionKey?: string;
    namespace?: string;
    budget?: number;
    authenticatedPrincipal?: string;
    sourceConnector?: string;
    disclosure?: RecallDisclosure;
  }) => Promise<TResponse>;
}): Promise<RecallDiagnosticsHttpOutcome> {
  const queryParam = deps.getParam("q");
  if (queryParam === null || queryParam.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: "missing_query",
        code: "missing_query",
        message: "q search parameter is required and must be non-empty",
      },
    };
  }
  const sessionParam = deps.getParam("session");
  const namespaceParam = deps.getParam("namespace");
  const namespace = deps.resolveNamespace(
    namespaceParam !== null && namespaceParam.length > 0 ? namespaceParam : undefined,
  );
  // Reject an invalid `budget` with 400 rather than silently defaulting.
  const budgetParam = deps.getParam("budget");
  let budget: number | undefined;
  if (budgetParam !== null && budgetParam !== "") {
    const parsedBudget = Number(budgetParam);
    if (!Number.isFinite(parsedBudget) || parsedBudget <= 0 || !Number.isInteger(parsedBudget)) {
      return {
        status: 400,
        body: {
          error: "invalid_budget",
          code: "invalid_budget",
          message: "budget expects a positive integer",
        },
      };
    }
    budget = parsedBudget;
  }
  // Disclosure depth (issue #677 PR 3/4 telemetry plumbing). When present it
  // must match the chunk|section|raw allow-list; an invalid value is a 400,
  // never a silent fallback that quietly disables the per-disclosure summary.
  const disclosureParam = deps.getParam("disclosure");
  let disclosure: RecallDisclosure | undefined;
  if (disclosureParam !== null && disclosureParam.length > 0) {
    if (!isRecallDisclosure(disclosureParam)) {
      return {
        status: 400,
        body: {
          error: "invalid_disclosure",
          code: "invalid_disclosure",
          message: "disclosure must be one of: chunk, section, raw",
        },
      };
    }
    disclosure = disclosureParam;
  }
  // Only validation errors become 400s. Backend faults (timeouts, storage
  // errors, unexpected orchestrator failures) must bubble to the router's
  // error handler so they return 500 and get logged. `service.recallXray`
  // prefixes its validation errors with "recallXray:" so we key off that
  // prefix rather than catching everything, and we surface only a real
  // `Error.message` — never `String(err)` of an arbitrary throw, which
  // CodeQL flags as stack-trace exposure (js/stack-trace-exposure).
  try {
    return {
      status: 200,
      body: await deps.run({
        query: queryParam,
        ...(sessionParam !== null && sessionParam.length > 0 ? { sessionKey: sessionParam } : {}),
        ...(namespace !== undefined ? { namespace } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(deps.principal ? { authenticatedPrincipal: deps.principal } : {}),
        ...(deps.connector ? { sourceConnector: deps.connector } : {}),
        ...(disclosure !== undefined ? { disclosure } : {}),
      }),
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("recallXray:")) {
      return {
        status: 400,
        body: { error: "invalid_request", code: "invalid_request", message: err.message },
      };
    }
    throw err;
  }
}
