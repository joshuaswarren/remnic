/**
 * Connector-aware neighbor scoping, shared by every write-path dedup gate.
 *
 * A candidate fact carrying provenance (`sourceConnector`) must only be
 * compared against neighbors from the SAME connector — otherwise connector B's
 * write is suppressed by, or merged into, connector A's memory while that
 * memory's `sourceConnector` frontmatter still identifies A (PR #1852 review
 * finding on 7e0eb1a0; PR #2564 review finding on 54d865cb9; issue #2330).
 *
 * The rule was previously reimplemented inline in each gate. It is one
 * mechanism, so it lives in one module: the semantic near-duplicate skip gate
 * (`semantic.ts`), the novelty gate (`novelty-gate.ts`), and merge-on-write
 * (`merge.ts`) all resolve scope and match neighbors through these helpers.
 */

/**
 * The candidate's connector scope. An absent, non-string, or whitespace-only
 * value is "unattributed" (operator writes), which keeps the unscoped
 * neighborhood — the original pre-provenance behavior.
 */
export function normalizeConnectorScope(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Whether a neighbor may act on a candidate in this scope. An unscoped
 * candidate matches every neighbor; a scoped candidate matches only neighbors
 * carrying the identical connector. A neighbor with an absent or
 * whitespace-only connector never matches a scoped candidate.
 */
export function connectorMatchesScope(
  neighborConnector: unknown,
  scope: string | undefined,
): boolean {
  if (scope === undefined) return true;
  return normalizeConnectorScope(neighborConnector) === scope;
}
