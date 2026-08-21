/**
 * Shared-context curation self-check (issue #1957 requirement 4).
 *
 * Pure. A synthesized claim with no traceable source is a lint error:
 * report claims whose citations are missing, blank, or absent from the
 * item ids the curation run actually had available.
 */

export interface CuratedClaim {
  claimId: string;
  /** Shared-context item ids this claim was synthesized from. */
  citedItemIds?: readonly string[];
}

export interface CurationLintFinding {
  claimId: string;
  reason: "no_citations" | "unknown_citation";
  /** Cited ids that are not in the available set. Only for unknown_citation. */
  unknownIds?: string[];
}

export function lintCuratedClaims(input: {
  claims: readonly CuratedClaim[];
  availableItemIds: readonly string[];
}): CurationLintFinding[] {
  const available = new Set(input.availableItemIds);
  const findings: CurationLintFinding[] = [];

  for (const claim of input.claims) {
    const claimId = claim.claimId;
    if (typeof claimId !== "string" || claimId.trim().length === 0) {
      throw new RangeError("claimId must be a non-blank string");
    }

    const unknown = new Set<string>();
    let validCount = 0;
    for (const id of claim.citedItemIds ?? []) {
      if (id.trim().length === 0) continue;
      if (available.has(id)) {
        validCount += 1;
      } else {
        unknown.add(id);
      }
    }

    if (validCount === 0) {
      findings.push({ claimId, reason: "no_citations" });
      continue;
    }
    if (unknown.size > 0) {
      findings.push({ claimId, reason: "unknown_citation", unknownIds: [...unknown].sort() });
    }
  }

  findings.sort((a, b) => {
    if (a.claimId !== b.claimId) return a.claimId < b.claimId ? -1 : 1;
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    // Duplicate claim ids are linted independently, so two findings can share
    // both keys above and still differ. Without this tertiary key the result
    // would depend on upstream iteration order, which the deterministic-output
    // contract forbids.
    const left = (a.unknownIds ?? []).join(",");
    const right = (b.unknownIds ?? []).join(",");
    if (left !== right) return left < right ? -1 : 1;
    return 0;
  });
  return findings;
}
