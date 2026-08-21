/**
 * Format a vault-relative note path as an Obsidian wikilink (issue #1985).
 *
 * Relative paths only. Rejects absolute paths, `..` segments, empty input,
 * and newlines. Strips a trailing `.md` suffix.
 */
import path from "node:path";

export function formatVaultWikilink(notePath: string): string {
  if (typeof notePath !== "string" || notePath.trim().length === 0) {
    throw new RangeError("Vault wikilink path must be a non-empty relative path.");
  }
  if (notePath.includes("\n") || notePath.includes("\r")) {
    throw new RangeError("Vault wikilink path must not contain newlines.");
  }
  if (path.posix.isAbsolute(notePath) || path.win32.isAbsolute(notePath)) {
    throw new RangeError("Vault wikilink path must be relative; absolute paths are rejected.");
  }
  if (notePath.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new RangeError("Vault wikilink path must not contain `..` segments.");
  }

  const stripped = notePath.endsWith(".md") ? notePath.slice(0, -3) : notePath;
  if (stripped.length === 0) {
    throw new RangeError("Vault wikilink path must be a non-empty relative path.");
  }
  return `[[${stripped}]]`;
}
