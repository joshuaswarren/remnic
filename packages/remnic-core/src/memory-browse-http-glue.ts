/**
 * Memory-store browse HTTP glue (issue #2978) — route bodies live here so
 * access-http.ts stays at its structural ceiling (same seam as
 * recall-navigation-http-glue.ts).
 *
 * Each route carries its literal `enforceTokenOp("<op>")` boundary-dispatch
 * marker so `access-surface-catalog.test.ts` can prove dispatch statically.
 * Input errors map to 400; everything else rethrows to the global 500
 * handler. Namespace resolution flows through the caller-supplied
 * `scopeFor` gate so a body-supplied namespace passes the SAME
 * effective-namespace allow-list as the query string (issue #1850 finding
 * 2), and `authenticatedPrincipal` reaches the service so authorization
 * derives from the presenting principal, never client-supplied input.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { EngramAccessInputError } from "./access-errors.js";
import type { EngramAccessService } from "./access-service.js";
import type { BrowseVerb } from "./memory-browse.js";

type RespondJson = (res: ServerResponse, status: number, payload: unknown) => void;
type ReadJsonBody = (req: IncomingMessage) => Promise<unknown>;

type ScopeFor = (
  bodyNamespace?: string,
) => { namespace?: string; authenticatedPrincipal?: string };

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
    throw new EngramAccessInputError("depth must be an integer");
  }
  return parsed;
}

async function respondBrowse(
  req: IncomingMessage,
  res: ServerResponse,
  respondJson: RespondJson,
  readJsonBody: ReadJsonBody,
  service: EngramAccessService,
  scopeFor: ScopeFor,
  verb: BrowseVerb,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const scope = scopeFor(optStr(body.namespace));
  const depth = verb === "tree" ? optInt(body.depth) : undefined;
  const result = await service.memoryStoreBrowse({
    verb,
    ...(optStr(body.path) !== undefined ? { path: optStr(body.path) } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(verb === "find" && optStr(body.pattern) !== undefined ? { pattern: optStr(body.pattern) } : {}),
    namespace: scope.namespace,
    authenticatedPrincipal: scope.authenticatedPrincipal,
  });
  const { rendered: _rendered, ...payload } = result;
  respondJson(res, 200, payload);
}

export async function maybeRespondMemoryBrowse(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string | undefined,
  enforceTokenOp: (op: "memory_ls" | "memory_tree" | "memory_find") => void,
  respondJson: RespondJson,
  readJsonBody: ReadJsonBody,
  service: EngramAccessService,
  scopeFor: ScopeFor,
): Promise<boolean> {
  if (method === "POST" && (pathname === "/engram/v1/memory/ls" || pathname === "/remnic/v1/memory/ls")) {
    enforceTokenOp("memory_ls");
    await respondBrowse(req, res, respondJson, readJsonBody, service, scopeFor, "ls");
    return true;
  }
  if (method === "POST" && (pathname === "/engram/v1/memory/tree" || pathname === "/remnic/v1/memory/tree")) {
    enforceTokenOp("memory_tree");
    await respondBrowse(req, res, respondJson, readJsonBody, service, scopeFor, "tree");
    return true;
  }
  if (method === "POST" && (pathname === "/engram/v1/memory/find" || pathname === "/remnic/v1/memory/find")) {
    enforceTokenOp("memory_find");
    await respondBrowse(req, res, respondJson, readJsonBody, service, scopeFor, "find");
    return true;
  }
  return false;
}
