/**
 * content-hash.ts — standalone content normalization + SHA-256 hashing.
 *
 * Extracted from `ContentHashIndex` (storage.ts) so correction modules and
 * other consumers can hash content WITHOUT importing the storage god file
 * (issue #1533 directStorageImports ratchet). The static methods on
 * `ContentHashIndex` delegate here to guarantee identical results.
 */

import { createHash } from "node:crypto";

/** Normalize content: lowercase, strip non-alphanumerics, collapse whitespace. */
export function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize content and compute SHA-256 hash. */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(normalizeContent(content)).digest("hex");
}
