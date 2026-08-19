/**
 * Strip a trailing `.md` suffix from a vault note path (issue #1985).
 *
 * Case-sensitive. Does not strip `.markdown`. Empty input and inputs that
 * would strip to an empty string (exactly ".md") are rejected.
 */

export function stripVaultMdSuffix(notePath: string): string {
  if (typeof notePath !== "string" || notePath.length === 0) {
    throw new RangeError("Vault path must be non-empty.");
  }
  if (notePath === ".md") {
    throw new RangeError("Vault path must name a note, not just a suffix.");
  }
  return notePath.endsWith(".md") ? notePath.slice(0, -3) : notePath;
}
