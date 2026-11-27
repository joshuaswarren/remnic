
export interface SharedWriteOutputControls {
  authority?: string;
  expiresAt?: string;
  supersedes?: string;
}

const CONTROL_FIELDS = ["authority", "expiresAt", "supersedes"] as const;

const SERVER_RESOLVED_FIELDS = ["principal", "namespace"] as const;

/**
 * Parse the optional envelope controls off a raw client request.
 *
 * - Absent fields are omitted; a control must be a non-blank string when
 *   present (an explicit empty string is a client error, not "unspecified").
 * - A client-supplied `principal` or `namespace` is rejected: identity and
 *   scoping are resolved by the surface, never accepted from the caller.
 *
 * Throws `Error` with a `shared-context write output:` prefix; access
 * surfaces map that to their input-error class.
 */
export function parseSharedWriteOutputControls(raw: unknown): SharedWriteOutputControls {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  for (const field of SERVER_RESOLVED_FIELDS) {
    if (Object.hasOwn(record, field) && record[field] !== undefined) {
      throw new Error(
        `shared-context write output: ${field} is server-resolved and cannot be supplied by the caller`,
      );
    }
  }
  const controls: SharedWriteOutputControls = {};
  for (const field of CONTROL_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`shared-context write output: ${field} must be a string`);
    }
    if (value.trim().length === 0) {
      throw new Error(`shared-context write output: ${field} must be a non-empty string`);
    }
    controls[field] = value;
  }
  return controls;
}

const WRITE_INPUT_PREFIXES = [
  "shared-context write origin mismatch",
  "applyDefaultEnvelope:",
  "composeWriteEnvelope:",
  "shared-context write output:",
] as const;

export function isSharedContextWriteInputError(message: string): boolean {
  return WRITE_INPUT_PREFIXES.some((prefix) => message.startsWith(prefix));
}
