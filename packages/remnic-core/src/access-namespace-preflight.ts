import { getOperation } from "./access-boundary.js";
import { capabilityAllowsOp, isNamespaceAllowed, type TokenCapabilities } from "./access-token-capabilities.js";
import { EngramAccessForbiddenError, EngramAccessInputError, NamespaceNotWritableError } from "./access-errors.js";
import type { WritableNamespaceResult } from "./scopes/scope-plan.js";

export interface EngramAccessNamespaceWritableRequest {
  namespace?: string;
  sessionKey?: string;
  authenticatedPrincipal?: string;
  cwd?: string;
  projectTag?: string;
}

export function namespaceWritableRequest(
  params: URLSearchParams,
  authenticatedPrincipal?: string,
): EngramAccessNamespaceWritableRequest {
  const namespace = params.get("namespace") || undefined;
  return {
    namespace,
    sessionKey: params.get("session") || undefined,
    authenticatedPrincipal,
    cwd: params.get("cwd") || undefined,
    projectTag: params.get("projectTag") || undefined,
  };
}

export function parseNamespacePreflightWriteOp(
  value: string | undefined,
): "observe" | "memory_store" {
  if (value === undefined || value === "observe") return "observe";
  if (value === "memory_store") return "memory_store";
  throw new EngramAccessInputError(`unsupported namespace preflight operation: ${value}`);
}

export function assertNamespacePreflightPermitted(
  caps: TokenCapabilities | undefined | null,
): void {
  const allowedOps = getOperation("namespace_writable")?.spec.allowedByOps ?? [];
  if (!allowedOps.some((op) => capabilityAllowsOp(caps, op))) {
    throw new EngramAccessForbiddenError("token is not permitted to run the namespace preflight");
  }
}

export type NamespaceWritableResolver = (
  request: EngramAccessNamespaceWritableRequest,
) => Promise<string>;
export type NamespaceWritablePreflightResolver = (
  request: EngramAccessNamespaceWritableRequest,
) => Promise<WritableNamespaceResult>;

export async function resolveNamespaceWritablePreflight(
  request: EngramAccessNamespaceWritableRequest,
  resolveWritable: NamespaceWritableResolver,
): Promise<WritableNamespaceResult> {
  try {
    return { ok: true, namespace: await resolveWritable(request) };
  } catch (error) {
    if (error instanceof NamespaceNotWritableError) {
      return { ok: false, reason: "not_writable", namespace: error.attemptedNamespace };
    }
    if (error instanceof EngramAccessInputError) {
      return {
        ok: false,
        reason: "unsupported",
        namespace: request.namespace?.trim() ?? "",
      };
    }
    throw error;
  }
}

export async function resolveAuthorizedNamespaceWritablePreflight(
  caps: TokenCapabilities | undefined | null,
  request: EngramAccessNamespaceWritableRequest,
  defaultNamespace: string,
  writeOp: "observe" | "memory_store",
  resolvePreflight: NamespaceWritablePreflightResolver,
): Promise<WritableNamespaceResult> {
  if (!capabilityAllowsOp(caps, writeOp)) {
    return {
      ok: false,
      reason: "not_writable",
      namespace: request.namespace?.trim() || defaultNamespace,
    };
  }

  const result = await resolvePreflight(request);
  if (!isNamespaceAllowed(caps, result.namespace, defaultNamespace)) {

    return { ok: false, reason: "not_writable", namespace: result.namespace };
  }
  return result;
}

export function resolveQueryNamespaceWritablePreflight(
  caps: TokenCapabilities | undefined | null,
  params: URLSearchParams,
  authenticatedPrincipal: string | undefined,
  defaultNamespace: string,
  resolvePreflight: NamespaceWritablePreflightResolver,
): Promise<WritableNamespaceResult> {
  assertNamespacePreflightPermitted(caps);
  return resolveAuthorizedNamespaceWritablePreflight(
    caps,
    namespaceWritableRequest(params, authenticatedPrincipal),
    defaultNamespace,
    parseNamespacePreflightWriteOp(params.get("op") ?? undefined),
    resolvePreflight,
  );
}
