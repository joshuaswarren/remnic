import {
  getOperation,
  operationRequiresAuthorizedNamespace,
  OPERATION_NAMES,
  RESOURCE_SCOPED_HTTP_NAMESPACE_OPERATIONS,
  type OperationName,
} from "./access-boundary.js";
import { EngramAccessInputError } from "./access-errors.js";
import {
  assertOperationAuthorizationAllowed,
  type TokenCapabilities,
} from "./access-token-capabilities.js";

export interface AuthorizationProbeResponse {
  readonly authorized: true;
  readonly operations: readonly OperationName[];
}

/**
 * Verify that the presenting token may call every requested operation without
 * invoking any operation handler.
 */
export function probeOperationAuthorization(
  capabilities: TokenCapabilities | undefined | null,
  requestedOperations: readonly string[],
): AuthorizationProbeResponse {
  const operations: OperationName[] = [];
  for (const candidate of requestedOperations) {
    if (!OPERATION_NAMES.includes(candidate as OperationName)) {
      throw new EngramAccessInputError(`unsupported operation: ${candidate}`);
    }
    const operation = candidate as OperationName;
    if (!operations.includes(operation)) operations.push(operation);
  }

  if (operations.length === 0) {
    throw new EngramAccessInputError("at least one operation is required");
  }

  for (const operation of operations) {
    const boundOperation = getOperation(operation);
    if (!boundOperation) {
      throw new Error(`authorization probe operation is not registered: ${operation}`);
    }
    assertOperationAuthorizationAllowed(capabilities, boundOperation.spec);
  }

  return { authorized: true, operations };
}

/**
 * Resolve every namespace an authorization probe must check. Resource-scoped
 * routes ignore the query namespace and use their stored target or daemon
 * default, so mixed probes check both the requested and default namespaces.
 */
export function authorizationProbeNamespaces(
  operations: readonly OperationName[],
  requestedNamespace: string | undefined,
): readonly (string | undefined)[] {
  const namespaceOperations = operations.filter(operationRequiresAuthorizedNamespace);
  const usesRequestNamespace = namespaceOperations.some(
    (operation) => RESOURCE_SCOPED_HTTP_NAMESPACE_OPERATIONS[operation] !== true,
  );
  const usesResourceNamespace = namespaceOperations.some(
    (operation) => RESOURCE_SCOPED_HTTP_NAMESPACE_OPERATIONS[operation] === true,
  );
  const namespaces: Array<string | undefined> = usesRequestNamespace ? [requestedNamespace] : [];
  if (usesResourceNamespace && (requestedNamespace !== undefined || !usesRequestNamespace)) {
    namespaces.push(undefined);
  }
  return namespaces;
}
