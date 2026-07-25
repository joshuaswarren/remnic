import { type OperationName, OPERATION_NAMES } from "./access-boundary.js";
import { EngramAccessForbiddenError, EngramAccessInputError } from "./access-errors.js";
import { capabilityAllowsOp, type TokenCapabilities } from "./access-token-capabilities.js";

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
    if (!capabilityAllowsOp(capabilities, operation)) {
      throw new EngramAccessForbiddenError(`token is not permitted to call operation: ${operation}`);
    }
  }

  return { authorized: true, operations };
}
