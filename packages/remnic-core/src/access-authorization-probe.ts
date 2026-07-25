import {
  getOperation,
  operationRequiresAuthorizedNamespace,
  OPERATION_NAMES,
  type OperationName,
} from "./access-boundary.js";
import { EngramAccessInputError } from "./access-errors.js";
import {
  assertOperationAuthorizationAllowed,
  type TokenCapabilities,
} from "./access-token-capabilities.js";

const UNRESOLVABLE_RESOURCE_OPERATIONS = new Set<OperationName>([
  "review_resolve",
  "contradiction_detail",
  "chat_message",
  "chat_events",
]);

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
 * Resolve every namespace an authorization probe can verify from the request.
 * Resource-scoped routes resolve their stored target only after a resource id
 * is supplied, so probes validate only request-resolvable namespaces.
 */
export function authorizationProbeNamespaces(
  operations: readonly OperationName[],
  requestedNamespace: string | undefined,
): readonly (string | undefined)[] {
  const namespaceOperations = operations.filter(
    (operation) =>
      operationRequiresAuthorizedNamespace(operation) &&
      !UNRESOLVABLE_RESOURCE_OPERATIONS.has(operation),
  );
  return namespaceOperations.length > 0 ? [requestedNamespace] : [];
}
