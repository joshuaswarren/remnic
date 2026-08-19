/**
 * Join vault-relative path segments (issue #1985).
 *
 * Joins with `/`. Rejects an empty list, empty parts, `..`, absolute
 * parts, backslash, and newline.
 */
import path from "node:path";

export function joinVaultSegments(parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new RangeError("Vault path parts must be a non-empty list.");
  }
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0) {
      throw new RangeError("Vault path part must be non-empty.");
    }
    if (part.includes("\\")) {
      throw new RangeError("Vault path part must not contain a backslash.");
    }
    if (part.includes("\n") || part.includes("\r")) {
      throw new RangeError("Vault path part must not contain a newline.");
    }
    if (path.posix.isAbsolute(part) || path.win32.isAbsolute(part)) {
      throw new RangeError("Vault path part must be relative.");
    }
    if (part.split("/").includes("..")) {
      throw new RangeError("Vault path part must not contain `..`.");
    }
  }
  return parts.join("/");
}
