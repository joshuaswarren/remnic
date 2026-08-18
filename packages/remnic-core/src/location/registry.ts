/**
 * Location provider registry (issue #2044).
 *
 * In-memory only: host adapters register provider implementations at startup.
 * Core never statically imports an optional provider package — the registry
 * holds whatever the host wired in, and a configured source whose provider is
 * not registered is skipped (not an error), so partial installs keep working.
 */

import type { LocationProvider } from "./types.js";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const providers = new Map<string, LocationProvider>();

function assertValidProvider(provider: LocationProvider): void {
  if (typeof provider !== "object" || provider === null) {
    throw new TypeError("location provider must be an object");
  }
  if (typeof provider.id !== "string" || !PROVIDER_ID_PATTERN.test(provider.id)) {
    throw new RangeError(
      "location provider id must be a non-empty lowercase kebab string (a-z, 0-9, hyphens)",
    );
  }
  if (typeof provider.displayName !== "string" || provider.displayName.trim().length === 0) {
    throw new TypeError(`location provider '${provider.id}' must declare a non-empty displayName`);
  }
  if (typeof provider.verify !== "function" || typeof provider.fetchObservations !== "function") {
    throw new TypeError(
      `location provider '${provider.id}' must implement verify() and fetchObservations()`,
    );
  }
}

export function registerLocationProvider(provider: LocationProvider): void {
  assertValidProvider(provider);
  if (providers.has(provider.id)) {
    throw new Error(`location provider '${provider.id}' is already registered`);
  }
  providers.set(provider.id, provider);
}

export function getLocationProvider(id: string): LocationProvider | undefined {
  return typeof id === "string" ? providers.get(id) : undefined;
}

export function listLocationProviders(): string[] {
  return [...providers.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Test-only: reset the registry between cases. */
export function clearLocationProviders(): void {
  providers.clear();
}
