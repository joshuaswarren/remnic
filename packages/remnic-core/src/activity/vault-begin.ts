/**
 * Match a managed-region begin marker line (issue #1985).
 *
 * True iff the trimmed line equals `<!-- remnic:begin NAME -->`.
 * Empty name throws.
 */

export function isRegionBeginLine(line: string, name: string): boolean {
  if (typeof name !== "string" || name.length === 0) {
    throw new RangeError("Region name must be non-empty.");
  }
  return line.trim() === `<!-- remnic:begin ${name} -->`;
}
