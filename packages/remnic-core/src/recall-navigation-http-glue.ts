/**
 * Recall-navigation HTTP glue (issue #1956) — route body lives here so
 * access-http.ts stays at its structural ceiling (same seam as
 * deep-recall-http-glue.ts).
 *
 * Input errors map to 400; everything else rethrows to the global 500
 * handler. Config gating (`recallNavigation.enabled`) lives in the service
 * and returns a typed `error: "disabled"` refusal — this module only
 * translates transport shape. Namespace/sessionKey resolution flows through
 * the caller-supplied `scopeFor` gate so a body-supplied namespace passes
 * the SAME effective-namespace allow-list as the query string (issue #1850
 * finding 2), and `authenticatedPrincipal` reaches the service so
 * authorization derives from the presenting principal, never the
 * client-supplied sessionKey.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { EngramAccessInputError } from "./access-errors.js";
import type { EngramAccessService } from "./access-service.js";
import type { NavigationAction } from "./recall-navigation.js";

type RespondJson = (res: ServerResponse, status: number, payload: unknown) => void;
type ReadJsonBody = (req: IncomingMessage) => Promise<unknown>;

type ScopeFor = (
  bodyNamespace?: string,
  bodySessionKey?: string,
) => { namespace?: string; sessionKey?: string; authenticatedPrincipal?: string };

const VALID_RELATIONS = [
  "supports",
  "contradicts",
  "elaborates",
  "causes",
  "caused_by",
  "supersedes",
  "follows",
  "references",
  "related",
] as const;

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new EngramAccessInputError("limit must be a positive integer");
  }
  return parsed;
}

async function respondNavigation(
  req: IncomingMessage,
  res: ServerResponse,
  respondJson: RespondJson,
  readJsonBody: ReadJsonBody,
  service: EngramAccessService,
  scopeFor: ScopeFor,
  action: Extract<NavigationAction, "expand" | "traverse">,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const memoryId = optStr(body.memoryId);
  if (memoryId === undefined || memoryId.trim().length === 0) {
    respondJson(res, 400, { error: "invalid_request", detail: "memoryId is required" });
    return;
  }
  const sessionKey = optStr(body.sessionKey);
  if (sessionKey === undefined || sessionKey.trim().length === 0) {
    respondJson(res, 400, { error: "invalid_request", detail: "sessionKey is required" });
    return;
  }
  let disclosure: "chunk" | "section" | "raw" | undefined;
  let relation: string | undefined;
  if (action === "expand") {
    const raw = optStr(body.disclosure);
    if (raw !== undefined && raw !== "chunk" && raw !== "section" && raw !== "raw") {
      respondJson(res, 400, { error: "invalid_request", detail: "disclosure must be one of chunk, section, raw" });
      return;
    }
    disclosure = raw;
  } else {
    relation = optStr(body.relation);
    if (relation !== undefined && !(VALID_RELATIONS as readonly string[]).includes(relation)) {
      respondJson(
        res,
        400,
        { error: "invalid_request", detail: `relation must be one of ${VALID_RELATIONS.join(", ")}` },
      );
      return;
    }
  }
  let limit: number | undefined;
  try {
    limit = optInt(body.limit);
  } catch (err) {
    respondJson(res, 400, { error: "invalid_request", detail: err instanceof Error ? err.message : String(err) });
    return;
  }
  const scope = scopeFor(optStr(body.namespace), sessionKey);
  const result = await service.recallNavigate({
    action,
    memoryId,
    sessionKey: scope.sessionKey ?? sessionKey,
    ...(disclosure !== undefined ? { disclosure } : {}),
    ...(relation !== undefined ? { relation } : {}),
    ...(limit !== undefined ? { limit } : {}),
    namespace: scope.namespace,
    authenticatedPrincipal: scope.authenticatedPrincipal,
  });
  const { rendered: _rendered, ...payload } = result;
  respondJson(res, 200, payload);
}

export async function maybeRespondRecallNavigation(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string | undefined,
  enforceTokenOp: (op: "memory_expand" | "memory_traverse") => void,
  respondJson: RespondJson,
  readJsonBody: ReadJsonBody,
  service: EngramAccessService,
  scopeFor: ScopeFor,
): Promise<boolean> {
  if (method === "POST" && (pathname === "/engram/v1/memory/expand" || pathname === "/remnic/v1/memory/expand")) {
    enforceTokenOp("memory_expand");
    await respondNavigation(req, res, respondJson, readJsonBody, service, scopeFor, "expand");
    return true;
  }
  if (method === "POST" && (pathname === "/engram/v1/memory/traverse" || pathname === "/remnic/v1/memory/traverse")) {
    enforceTokenOp("memory_traverse");
    await respondNavigation(req, res, respondJson, readJsonBody, service, scopeFor, "traverse");
    return true;
  }
  return false;
}

