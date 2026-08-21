/**
 * Strip a trailing `.md` suffix from a vault note path (issue #1985).
 *
 * Case-sensitive. Does not strip `.markdown`. Empty input is rejected.
 */

export function stripVaultMdSuffix(notePath: string): string {
  if (typeof notePath !== "string" || notePath.length === 0) {
    throw new RangeError("Vault path must be non-empty.");
  }
  return notePath.endsWith(".md") ? notePath.slice(0, -3) : notePath;
}
