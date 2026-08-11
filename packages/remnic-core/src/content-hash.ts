/**
 * content-hash.ts — standalone content normalization + SHA-256 hashing.
 *
 * Extracted from `ContentHashIndex` (storage.ts) so correction modules and
 * other consumers can hash content WITHOUT importing the storage god file
 * (issue #1533 directStorageImports ratchet). The static methods on
 * `ContentHashIndex` delegate here to guarantee identical results.
 */

import { createHash } from "node:crypto";

/** Normalize content: preserve Unicode letters, marks, and numbers. */
export function normalizeContent(content: string): string {
  return content
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize content with the pre-Unicode ASCII-only normalizer. */
export function normalizeLegacyContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compute the SHA-256 hash used by pre-Unicode content indexes. */
export function computeLegacyContentHash(content: string): string {
  return createHash("sha256").update(normalizeLegacyContent(content)).digest("hex");
}

/**
 * Return true only when a persisted legacy hash can be proved to identify the
 * same body under the current normalizer. Empty or changed legacy forms are
 * ambiguous and must not be promoted to a current identity.
 */
export function isUnambiguousLegacyContentHash(
  content: string,
  contentHash: string,
  currentNormalizedText: string = normalizeContent(content),
): boolean {
  const legacyNormalizedText = normalizeLegacyContent(content);
  return (
    legacyNormalizedText.length > 0 &&
    legacyNormalizedText === currentNormalizedText &&
    createHash("sha256").update(legacyNormalizedText).digest("hex") === contentHash
  );
}

/** Normalize content and compute SHA-256 hash. */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(normalizeContent(content)).digest("hex");
}
