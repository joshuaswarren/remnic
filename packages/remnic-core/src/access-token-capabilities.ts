/**
 * Per-token capabilities (issue #1837).
 *
 * A token entry MAY carry an explicit, versioned capabilities record. The
 * record's PRESENCE is mechanically detectable, which is load-bearing for
 * security:
 *
 *   - ABSENT `capabilities` field ⇒ a PRE-FEATURE legacy entry (minted
 *     before this feature). It is UNRESTRICTED — full access — purely for
 *     backward compatibility. This is the ONLY path by which "full access"
 *     is granted by omission.
 *
 *   - PRESENT `capabilities` record (always carries a `version` marker) ⇒ a
 *     token minted by the capability-aware path. Even a new token minted
 *     without `--ops`/`--namespaces` records an EXPLICIT unrestricted record
 *     (`{ version: 1 }`) — a deliberate, auditable choice, never an
 *     accidentally-omitted field. Within the record, the two axes follow
 *     absent-vs-present semantics:
 *       * axis ABSENT (e.g. no `ops` key)        ⇒ unrestricted on that axis.
 *       * axis PRESENT and empty (`ops: []`)     ⇒ deny all (fail-closed).
 *       * axis PRESENT and non-empty             ⇒ allow only the listed values.
 *
 * Malformed capability input at mint time (bad version, non-array axes,
 * non-string elements, unknown op names against the catalog, malformed
 * namespace values) is REJECTED — a token is never created from invalid
 * input (rule: invalid input rejected, not defaulted).
 *
 * This module owns the pure capability logic (shape validation, allow-list
 * checks) and the per-request AsyncLocalStorage carrying the presenting
 * token's resolved capabilities down to the access boundary. It imports
 * nothing else in the package except the forbidden-error class, so it can be
 * reused by the token store, the boundary, and the HTTP/MCP surfaces without
 * cycles.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { EngramAccessForbiddenError } from "./access-errors.js";

/** Current capability-record schema version. */
export const TOKEN_CAPABILITIES_VERSION = 1 as const;

/**
 * Versioned capabilities record stored on a token entry. Presence of this
 * record (vs. an absent field) is what distinguishes a capability-aware
 * token from a pre-feature legacy entry.
 */
export interface TokenCapabilities {
  readonly version: typeof TOKEN_CAPABILITIES_VERSION;
  /**
   * Operations allow-list. `undefined` (key absent) ⇒ unrestricted on this
   * axis. `[]` ⇒ deny all ops (fail-closed). Non-empty ⇒ allow only listed.
   */
  ops?: string[];
  /**
   * Namespaces allow-list. `undefined` ⇒ unrestricted. `[]` ⇒ deny all.
   * Non-empty ⇒ allow only listed.
   */
  namespaces?: string[];
}

/**
 * Namespace value validation. Namespace identifiers are flexible (default,
 * team, self, principal-prefixed, project-prefixed) but must never contain
 * whitespace, path separators, traversal segments, or control characters —
 * such values are malformed at mint time and rejected, never silently
 * coerced.
 */
const NAMESPACE_VALUE_MAX_LENGTH = 128;
// Non-empty, no whitespace, no path separators, no control chars. `.` and
// `..` are rejected separately so legitimate dotted names (e.g. a domain)
// remain allowed while traversal is not.
const NAMESPACE_VALUE_PATTERN = /^[^\s\/\\\x00-\x1F]+$/;

/** True when `value` is an acceptable namespace allow-list entry. */
export function isValidNamespaceValue(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > NAMESPACE_VALUE_MAX_LENGTH) {
    return false;
  }
  if (!NAMESPACE_VALUE_PATTERN.test(value)) return false;
  if (value === "." || value === "..") return false;
  return true;
}

function isStringArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function dedupeSort(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Parse one axis (ops or namespaces) for PERSISTENCE/LOAD. Returns the
 * cleaned array (deduped, sorted; possibly empty to preserve "present ⇒
 * fail-closed") or `undefined` when the key is absent. Throws on a malformed
 * shape (non-array, non-string elements, malformed namespace values). Op
 * validation against the catalog happens only at mint time.
 */
function parseAxis(
  obj: Record<string, unknown>,
  key: "ops" | "namespaces",
  validateValue: (v: unknown) => boolean,
  valueLabel: string,
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!isStringArray(value)) {
    throw new Error(`capabilities ${key} must be an array of non-empty strings`);
  }
  const cleaned: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`capabilities ${key} must be an array of non-empty strings`);
    }
    if (!validateValue(v)) {
      throw new Error(`capabilities ${key} contains a malformed ${valueLabel}: ${JSON.stringify(v)}`);
    }
    cleaned.push(v);
  }
  // Preserve presence: an explicitly empty array stays [] (fail-closed),
  // NOT coerced to undefined (which would mean unrestricted).
  return dedupeSort(cleaned);
}

/**
 * Normalize a capabilities record for PERSISTENCE/LOAD. Returns `undefined`
 * ONLY when the record is entirely absent (a pre-feature legacy entry ⇒
 * unrestricted). When present, an absent/`undefined` `version` is COERCED to
 * the current default (1) — mirroring {@link validateCapabilitiesForMint} — so
 * a record that mint-validated also load-normalizes without a schema throw.
 * An explicitly-present WRONG version (not 1) is still rejected. Throws on a
 * malformed record (non-object, explicitly-wrong version, malformed axes).
 */
export function normalizeCapabilities(raw: unknown): TokenCapabilities | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("capabilities must be an object with a version marker");
  }
  const obj = raw as Record<string, unknown>;
  // Coerce absent/undefined version → 1, mirroring validateCapabilitiesForMint
  // (version 1 is the only schema version; coercing keeps mint-validated
  // records reloadable). Only an explicitly-present WRONG version throws.
  if (obj.version !== undefined && obj.version !== TOKEN_CAPABILITIES_VERSION) {
    throw new Error(`capabilities.version must be ${TOKEN_CAPABILITIES_VERSION}`);
  }
  const ops = parseAxis(obj, "ops", () => true, "operation");
  const namespaces = parseAxis(obj, "namespaces", isValidNamespaceValue, "namespace");
  const result: TokenCapabilities = { version: TOKEN_CAPABILITIES_VERSION };
  if (ops !== undefined) result.ops = ops;
  if (namespaces !== undefined) result.namespaces = namespaces;
  return result;
}

/**
 * Validate a capabilities record at MINT time. ALWAYS returns a versioned
 * record (never `undefined`) so every newly-minted token carries an explicit
 * capability decision — a new token can never gain full access by OMITTING
 * the field. When `raw` is absent/null, the result is an explicit
 * unrestricted record (`{ version: 1 }`), a deliberate/auditable choice. A
 * present-but-`undefined` (or absent) `version` is coerced to the current
 * default (1); an explicitly-wrong version is rejected. This version rule is
 * identical to {@link normalizeCapabilities} (mint/load symmetry). Rejects
 * unknown op names against the catalog and malformed namespace values;
 * throws a plain Error — the caller must NOT create a token when this throws.
 */
export function validateCapabilitiesForMint(
  raw: unknown,
  validOps: readonly string[],
): TokenCapabilities {
  const result: TokenCapabilities = { version: TOKEN_CAPABILITIES_VERSION };
  if (raw === undefined || raw === null) {
    return result;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("capabilities must be an object with optional ops/namespaces arrays");
  }
  const obj = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, "version") && obj.version !== undefined) {
    if (obj.version !== TOKEN_CAPABILITIES_VERSION) {
      throw new Error(`capabilities.version must be ${TOKEN_CAPABILITIES_VERSION}`);
    }
  }
  const validOpSet = new Set(validOps);

  if (Object.prototype.hasOwnProperty.call(obj, "ops") && obj.ops !== undefined && obj.ops !== null) {
    if (!isStringArray(obj.ops)) {
      throw new Error("capabilities ops must be an array of non-empty strings");
    }
    const ops = obj.ops as unknown[];
    for (const v of ops) {
      if (typeof v !== "string" || v.length === 0) {
        throw new Error("capabilities ops must be an array of non-empty strings");
      }
    }
    // Reject unknown op names against the catalog (unknown ⇒ reject, never drop).
    const unknown = ops.filter((op) => typeof op === "string" && !validOpSet.has(op));
    if (unknown.length > 0) {
      throw new Error(
        `capabilities ops contains unknown operation name(s): ${unknown.map((o) => JSON.stringify(o)).join(", ")}`,
      );
    }
    // Preserve presence (empty stays [] ⇒ deny all ops).
    result.ops = dedupeSort(ops as string[]);
  }

  if (
    Object.prototype.hasOwnProperty.call(obj, "namespaces") &&
    obj.namespaces !== undefined &&
    obj.namespaces !== null
  ) {
    if (!isStringArray(obj.namespaces)) {
      throw new Error("capabilities namespaces must be an array of non-empty strings");
    }
    const namespaces = obj.namespaces as unknown[];
    for (const v of namespaces) {
      if (typeof v !== "string" || v.length === 0) {
        throw new Error("capabilities namespaces must be an array of non-empty strings");
      }
      if (!isValidNamespaceValue(v)) {
        throw new Error(`capabilities namespaces contains a malformed namespace: ${JSON.stringify(v)}`);
      }
    }
    result.namespaces = dedupeSort(namespaces as string[]);
  }

  return result;
}

/**
 * True when `caps` imposes any restriction (a present record with at least
 * one axis key). `undefined` (legacy / absent record) ⇒ unrestricted. A
 * present `{ version: 1 }` record with no axes ⇒ also unrestricted (but
 * auditable — it is a deliberate new-token decision, not omission).
 */
export function isCapabilityRestricted(caps: TokenCapabilities | undefined | null): boolean {
  if (!caps) return false;
  return caps.ops !== undefined || caps.namespaces !== undefined;
}

/**
 * True when `caps` permits `op`.
 *   - record ABSENT (legacy) ⇒ unrestricted (true).
 *   - ops axis ABSENT        ⇒ unrestricted on this axis (true).
 *   - ops axis PRESENT       ⇒ `op` must be listed; `[]` ⇒ false (deny all).
 */
export function capabilityAllowsOp(caps: TokenCapabilities | undefined | null, op: string): boolean {
  if (caps?.ops === undefined) return true;
  return caps.ops.includes(op);
}

/**
 * The operation policy that all access surfaces use to decide whether a token
 * can invoke an operation.
 */
export interface OperationAuthorizationPolicy {
  readonly name: string;
  readonly allowedByOps?: readonly string[];
  readonly fleetWide?: boolean;
}

/**
 * Apply an operation's alternate grant and fleet-wide restrictions without
 * invoking its handler.
 */
export function assertOperationAuthorizationAllowed(
  caps: TokenCapabilities | undefined | null,
  operation: OperationAuthorizationPolicy,
): void {
  if (operation.allowedByOps && operation.allowedByOps.length > 0) {
    if (!operation.allowedByOps.some((allowedOperation) => capabilityAllowsOp(caps, allowedOperation))) {
      throw new EngramAccessForbiddenError(`token is not permitted to call operation: ${operation.name}`);
    }
  } else {
    assertOperationAllowed(caps, operation.name);
  }

  if (operation.fleetWide) {
    assertFleetWideOperationAllowed(caps);
  }
}

/**
 * True when `caps` permits `namespace`.
 *   - record ABSENT / namespaces axis ABSENT ⇒ unrestricted (true).
 *   - namespaces axis PRESENT ⇒ `namespace` must be listed; undefined
 *     namespace ⇒ false; `[]` ⇒ false (deny all).
 */
export function capabilityAllowsNamespace(
  caps: TokenCapabilities | undefined | null,
  namespace: string | undefined,
): boolean {
  if (caps?.namespaces === undefined) return true;
  if (namespace === undefined) return false;
  return caps.namespaces.includes(namespace);
}

/**
 * Throw {@link EngramAccessForbiddenError} when `caps` restricts ops and
 * `op` is not permitted. No-op for unrestricted tokens.
 */
export function assertOperationAllowed(
  caps: TokenCapabilities | undefined | null,
  op: string,
): void {
  if (!capabilityAllowsOp(caps, op)) {
    throw new EngramAccessForbiddenError(
      `token is not permitted to call operation: ${op}`,
    );
  }
}

/**
 * Throw {@link EngramAccessForbiddenError} when `caps` restricts namespaces
 * and `namespace` is not permitted. No-op for unrestricted tokens.
 */
export function assertNamespaceAllowed(
  caps: TokenCapabilities | undefined | null,
  namespace: string | undefined,
): void {
  if (!capabilityAllowsNamespace(caps, namespace)) {
    throw new EngramAccessForbiddenError(
      namespace === undefined
        ? "token is scoped to specific namespaces and this operation requires an explicit namespace"
        : `token is not permitted to access namespace: ${namespace}`,
    );
  }
}

/**
 * Resolve the EFFECTIVE namespace an operation runs against: a present,
 * non-empty request namespace wins, otherwise the server default — the same
 * resolution downstream storage applies
 * (`getWritableStorageForNamespace(undefined)` → `defaultNamespace`). Empty
 * strings are treated as absent. Centralized so every invocation surface
 * (HTTP query/body, MCP `tools/call`, id-loaded records, legacy pairs that
 * carry no namespace) applies ONE rule and none can dodge the check by
 * dropping the param. (issue #1850)
 */
export function resolveEffectiveNamespace(
  namespace: string | undefined,
  defaultNamespace: string | undefined,
): string | undefined {
  const normalized = namespace !== undefined && namespace.length > 0 ? namespace : undefined;
  return normalized ?? defaultNamespace;
}

/**
 * The single effective-namespace allow-list chokepoint (issues #1837/#1850).
 * Throws {@link EngramAccessForbiddenError} when `caps` carries a namespaces
 * allow-list and the EFFECTIVE namespace (request value OR server default) is
 * not a member. FAIL CLOSED:
 *   - a scoped token whose allow-list does not cover the effective namespace
 *     (explicit OR defaulted) is rejected;
 *   - an absent server default (unconfigured) is also rejected for scoped
 *     tokens, so omitting `?namespace=` can never bypass the allow-list.
 * No-op for unrestricted tokens (no namespaces axis) so legacy/unrestricted
 * behavior is unchanged. Both the HTTP transport (`resolveNamespace`) and the
 * MCP dispatch route through this ONE function so no surface is missed.
 */
export function isNamespaceAllowed(
  caps: TokenCapabilities | undefined | null,
  namespace: string | undefined,
  defaultNamespace: string | undefined,
): boolean {
  if (caps?.namespaces === undefined) return true; // unrestricted token
  const effective = resolveEffectiveNamespace(namespace, defaultNamespace);
  return effective !== undefined && caps.namespaces.includes(effective);
}

export function enforceNamespaceAllowList(
  caps: TokenCapabilities | undefined | null,
  namespace: string | undefined,
  defaultNamespace: string | undefined,
): void {
  if (isNamespaceAllowed(caps, namespace, defaultNamespace)) return;
  throw new EngramAccessForbiddenError(
    namespace === undefined
      ? "token is scoped to specific namespaces; the server default namespace is not permitted — supply an allowed namespace"
      : `token is not permitted to access namespace: ${namespace}`,
  );
}

/**
 * Fleet-wide / global maintenance operation guard (issue #1850 round 10).
 *
 * A distinct escalation class from the id-addressed routes (round 9) and the
 * param-namespace ops (round 4): some boundary operations inherently run
 * ACROSS ALL namespaces — or against a single global layer (compression
 * guidelines, shared context, compounding) that is not namespace-partitioned
 * — and carry NO `namespace` argument, so the MCP `tools/call` effective-
 * namespace chokepoint ({@link enforceNamespaceAllowList}, which only fires
 * when `toolAcceptsNamespace`) never applies. Without this guard a bearer
 * scoped to ONE tenant could trigger maintenance that mutates state in EVERY
 * namespace (privilege escalation).
 *
 * Fail CLOSED exactly like the other shared guards: a namespace-SCOPED token
 * (namespaces axis present) is rejected; unrestricted / legacy tokens (absent
 * record or no namespaces axis — i.e. cron and internal callers that never
 * bind a capability record) are unaffected. Reuses the EXISTING capability
 * model via {@link capabilityAllowsNamespace} — no new "all"/"*" scope concept.
 * Must run BEFORE any side effect so a denial never leaks a partial mutation.
 */
export function assertFleetWideOperationAllowed(
  caps: TokenCapabilities | undefined | null,
): void {
  // capabilityAllowsNamespace returns false for ANY scoped token when the
  // namespace is undefined (a fleet-wide op has no single namespace), and
  // true for unrestricted/legacy tokens — exactly the desired policy.
  if (!capabilityAllowsNamespace(caps, undefined)) {
    throw new EngramAccessForbiddenError(
      "token is scoped to specific namespaces; this maintenance operation runs across all namespaces and is not permitted for a namespace-scoped token",
    );
  }
}

/**
 * Per-request AsyncLocalStorage carrying the presenting token's resolved
 * capabilities. The HTTP surface binds the resolved capabilities with
 * `.run(caps, handler)` for the WHOLE authorized request dispatch (NOT
 * `.enterWith()`, which mutates the current async resource and does not
 * reliably isolate the store across the handler's awaits / concurrent
 * requests — risking a fail-open read of undefined mid-handler); the
 * access boundary reads `.getStore()` to enforce the ops allow-list for
 * every boundary operation without each dispatch site threading the value
 * explicitly. Unset (CLI, direct boundary callers, tests) ⇒ undefined ⇒
 * unrestricted (issue #1850 round 7).
 */
export const tokenCapabilityStore = new AsyncLocalStorage<TokenCapabilities | undefined>();
