/**
 * Trim managed-region body text before vault publish (issue #1985 leftover).
 *
 * Removes leading and trailing blank lines. Internal content is preserved.
 */

export function trimVaultRegionBody(body: string): string {
  const lines = body.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}
