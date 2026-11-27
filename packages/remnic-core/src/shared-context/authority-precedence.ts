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
  authority?: unknown;
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
  const allowBinding = input.allowBinding;
  if (allowBinding !== undefined && typeof allowBinding !== "boolean") {
    throw new TypeError(
      `resolveSharedAuthority: allowBinding must be a boolean when supplied, got ${typeof allowBinding}`,
    );
  }
  const authority = input.authority;
  if (typeof authority !== "string") return "informational";
  if (!isKnownAuthority(authority)) return "informational";
  if (authority === "binding" && allowBinding !== true) {
    return "advisory";
  }
  return authority;
}

export function compareSharedAuthority(a: string, b: string): number {
  const rankA = isKnownAuthority(a) ? AUTHORITY_RANK[a] : AUTHORITY_RANK.informational;
  const rankB = isKnownAuthority(b) ? AUTHORITY_RANK[b] : AUTHORITY_RANK.informational;
  return Math.sign(rankA - rankB);
}
