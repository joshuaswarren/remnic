/**
 * Canonical unknown-payload guard for @remnic/connector-x.
 *
 * Fields stay `unknown` after narrowing; every field read is checked at
 * its use site with `typeof` / `in` / `Array.isArray`.
 */

export function isXObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
