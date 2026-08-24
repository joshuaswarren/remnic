/**
 * Canonical client-input parse for shared-context write-output envelope
 * controls (issue #2920).
 *
 * One module feeds BOTH documented surfaces — the Access MCP
 * `shared_context_write_output` operation and the OpenClaw
 * `shared_context_write_output` tool — so surface policy can never drift.
 * This layer owns only what is a SURFACE concern: field type/shape and the
 * rejection of client-supplied identity. Semantic validation (authority
 * allow-list, the binding gate, strict ISO instants, the future/TTL expiry
 * policy, id shape) stays in `composeWriteEnvelope`, the single write-side
 * gate every path already routes through — there is no in-process bypass
 * with looser rules than the tool surfaces.
 */

export interface SharedWriteOutputControls {
  authority?: string;
  expiresAt?: string;
  supersedes?: string;
}

const CONTROL_FIELDS = ["authority", "expiresAt", "supersedes"] as const;

/** Server-resolved fields a caller must never supply (issue #2920). */
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
