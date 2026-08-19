/**
 * Format managed-region HTML comment markers (issue #1985).
 *
 * Rejects empty names, newlines, and `-->` so the closer cannot leak
 * out of `<!-- remnic:begin NAME -->`.
 */

export type RegionMarkers = {
  begin: string;
  end: string;
};

export function formatRegionMarkers(name: string): RegionMarkers {
  if (typeof name !== "string" || name.length === 0) {
    throw new RangeError("Region name must be non-empty.");
  }
  if (name.includes("\n") || name.includes("\r")) {
    throw new RangeError("Region name must not contain a newline.");
  }
  if (name.includes("-->")) {
    throw new RangeError("Region name must not contain -->.");
  }
  return {
    begin: `<!-- remnic:begin ${name} -->`,
    end: `<!-- remnic:end ${name} -->`,
  };
}
