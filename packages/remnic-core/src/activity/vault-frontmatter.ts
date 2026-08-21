/**
 * Merge vault note frontmatter keys (issue #1985).
 *
 * Pure string helper. Empty updates leave the original YAML unchanged.
 * Listed keys stay. Output keys are sorted. Keys with newlines are rejected.
 */

function assertNoNewlineKey(key: string): void {
  if (key.includes("\n") || key.includes("\r")) {
    throw new RangeError("Vault frontmatter keys must not contain newlines.");
  }
}

export function applyVaultFrontmatter(
  existingYaml: string,
  updates: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(updates);
  if (entries.length === 0) return existingYaml;

  const merged = new Map<string, string>();
  for (const line of existingYaml.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key.length === 0) continue;
    assertNoNewlineKey(key);
    merged.set(key, line.slice(idx + 1).trim());
  }
  for (const [key, value] of entries) {
    assertNoNewlineKey(key);
    merged.set(key, value);
  }

  return [...merged.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}: ${merged.get(key)}`)
    .join("\n");
}
