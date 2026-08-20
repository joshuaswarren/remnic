/**
 * Shared-item authority precedence (issue #1957).
 *
 * Pure helpers over the authority classes owned by `governance.ts`
 * (`SHARED_AUTHORITIES`). Resolution is least-privilege: an absent,
 * malformed, or unrecognized authority never resolves above
 * `informational`, and `binding` additionally requires the explicit
 * `allowBinding` flag. The helpers are exported for callers; wiring them
 * into the shared-context read and write paths is a later slice.
 */

import { SHARED_AUTHORITIES, type SharedAuthority } from "./governance.js";

export { SHARED_AUTHORITIES as SHARED_AUTHORITY_CLASSES };
export type { SharedAuthority as SharedAuthorityClass };

export interface ResolveSharedAuthorityInput {
  /** Raw authority value from an item's envelope, if any. */
  authority?: unknown;
  /** Explicit opt-in required before "binding" is honored. */
  allowBinding?: boolean;
}

const AUTHORITY_RANK: Readonly<Record<SharedAuthority, number>> = {
  informational: 0,
  advisory: 1,
  binding: 2,
};

function isKnownAuthority(value: string): value is SharedAuthority {
  return (SHARED_AUTHORITIES as readonly string[]).includes(value);
}


export function resolveSharedAuthority(input: ResolveSharedAuthorityInput): SharedAuthority {
  if (input.allowBinding !== undefined && typeof input.allowBinding !== "boolean") {
    // The flag is the security switch, so a truthy string or number must
    // not enable binding: reject it instead of coercing.
    throw new TypeError(
      `resolveSharedAuthority: allowBinding must be a boolean when supplied, got ${typeof input.allowBinding}`,
    );
  }
  const authority = input.authority;
  // Absent (missing key, undefined, null) and present-but-invalid both land
  // on informational — the least-privileged class — so an unmarked or
  // malformed legacy item can never be treated as binding. Validate the
  // exact value: no trim, no case-fold, because " binding" and "BINDING"
  // are unrecognized data, not normalized matches for a known class.
  if (typeof authority !== "string") return "informational";
  if (!isKnownAuthority(authority)) return "informational";
  if (authority === "binding" && input.allowBinding !== true) {
    // Downgrade rather than throw: a legacy item already carrying "binding"
    // is stored data, not a caller bug, so it resolves to the highest class
    // that does not require the explicit opt-in.
    return "advisory";
  }
  return authority;
}

export function compareSharedAuthority(a: string, b: string): number {
  const rankA = isKnownAuthority(a) ? AUTHORITY_RANK[a] : AUTHORITY_RANK.informational;
  const rankB = isKnownAuthority(b) ? AUTHORITY_RANK[b] : AUTHORITY_RANK.informational;
  return Math.sign(rankA - rankB);
}
