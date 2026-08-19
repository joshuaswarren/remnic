/**
 * Match a managed-region end marker line (issue #1985).
 *
 * True iff the trimmed line equals `<!-- remnic:end NAME -->`.
 * Empty name throws.
 */

export function isRegionEndLine(line: string, name: string): boolean {
  if (typeof name !== "string" || name.length === 0) {
    throw new RangeError("Region name must be non-empty.");
  }
  return line.trim() === `<!-- remnic:end ${name} -->`;
}
