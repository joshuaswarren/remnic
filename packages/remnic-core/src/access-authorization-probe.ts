import { getOperation, type OperationName, OPERATION_NAMES } from "./access-boundary.js";
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
