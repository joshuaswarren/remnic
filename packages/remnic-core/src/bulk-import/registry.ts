// ---------------------------------------------------------------------------
// Bulk-import source adapter registry
// ---------------------------------------------------------------------------

import type { BulkImportSourceAdapter } from "./types.js";

const adapters = new Map<string, BulkImportSourceAdapter>();

/**
 * Register a source adapter. Rejects duplicate names and empty names.
 */
export function registerBulkImportSource(
  adapter: BulkImportSourceAdapter,
): void {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("bulk-import adapter must be an object");
  }
  if (
    !adapter.name ||
    typeof adapter.name !== "string" ||
    adapter.name.trim().length === 0
  ) {
    throw new Error("bulk-import adapter name must be a non-empty string");
  }
  if (typeof adapter.parse !== "function") {
    throw new Error(
      `bulk-import adapter '${adapter.name}' must have a parse function`,
    );
  }
  const key = adapter.name.trim();
  if (adapters.has(key)) {
    throw new Error(
      `bulk-import source adapter '${key}' is already registered`,
    );
  }
  // Store adapter with trimmed name so `adapter.name` stays consistent with
  // the registry key returned by `listBulkImportSources()`.
  const normalized: BulkImportSourceAdapter =
    adapter.name === key ? adapter : { ...adapter, name: key };
  adapters.set(key, normalized);
}

/**
 * Retrieve a registered adapter by name.
 *
 * Names are trimmed on write (see `registerBulkImportSource`), so we
 * also trim on read to avoid the asymmetric-lookup footgun where a
 * whitespace-padded lookup would never find a registered adapter.
 * Non-string or empty-after-trim inputs return undefined.
 */
export function getBulkImportSource(
  name: string,
): BulkImportSourceAdapter | undefined {
  if (typeof name !== "string") return undefined;
  const key = name.trim();
  if (key.length === 0) return undefined;
  return adapters.get(key);
}

/**
 * List all registered adapter names.
 */
export function listBulkImportSources(): string[] {
  return [...adapters.keys()];
}

/**
 * Clear all registered adapters (for testing).
 */
export function clearBulkImportSources(): void {
  adapters.clear();
}
