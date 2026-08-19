/**
 * Trim a managed-region name (issue #1985).
 *
 * Empty after trim throws. Newline throws. Else the trimmed string.
 */

export function trimRegionName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new RangeError("Region name must be non-empty.");
  }
  if (name.includes("\n") || name.includes("\r")) {
    throw new RangeError("Region name must not contain a newline.");
  }
  return name;
}
