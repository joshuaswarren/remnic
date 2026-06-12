/**
 * Wearable connector registry.
 *
 * Concrete connectors live in optional à-la-carte packages and register
 * a factory here (directly, or via the built-in loader below which
 * dynamic-imports the known packages with computed specifiers so
 * bundlers and the dts resolver never require them at build time).
 */

import { log } from "../logger.js";
import type {
  WearableSourceConnector,
  WearableSourceSettings,
} from "./types.js";

export interface WearableConnectorFactoryOptions {
  settings: WearableSourceSettings;
  /** IANA timezone transcripts are bucketed in. */
  timezone: string;
}

export type WearableConnectorFactory = (
  options: WearableConnectorFactoryOptions,
) => WearableSourceConnector;

export interface WearableConnectorRegistration {
  id: string;
  displayName: string;
  factory: WearableConnectorFactory;
}

const registrations = new Map<string, WearableConnectorRegistration>();

export function registerWearableConnector(
  registration: WearableConnectorRegistration,
): void {
  if (!registration || typeof registration !== "object") {
    throw new Error("wearable connector registration must be an object");
  }
  if (
    typeof registration.id !== "string" ||
    registration.id.trim().length === 0
  ) {
    throw new Error("wearable connector id must be a non-empty string");
  }
  if (typeof registration.factory !== "function") {
    throw new Error(
      `wearable connector '${registration.id}' must provide a factory function`,
    );
  }
  const key = registration.id.trim();
  if (registrations.has(key)) {
    throw new Error(`wearable connector '${key}' is already registered`);
  }
  registrations.set(key, { ...registration, id: key });
}

export function getWearableConnector(
  id: string,
): WearableConnectorRegistration | undefined {
  if (typeof id !== "string") return undefined;
  const key = id.trim();
  if (key.length === 0) return undefined;
  return registrations.get(key);
}

export function listWearableConnectors(): string[] {
  return [...registrations.keys()];
}

/** Test-only: reset the registry between cases. */
export function clearWearableConnectors(): void {
  registrations.clear();
}

/**
 * Built-in connector packages, tried in order. Each entry is loaded via
 * a computed-specifier dynamic import (see optional-bench.ts in
 * @remnic/cli for the canonical à-la-carte pattern); a missing package
 * is silently skipped, any other load error is logged once and skipped
 * so one broken connector never takes down the others.
 */
const BUILT_IN_CONNECTOR_PACKAGES: Array<{ id: string; suffix: string }> = [
  { id: "limitless", suffix: "connector-limitless" },
  { id: "bee", suffix: "connector-bee" },
  { id: "omi", suffix: "connector-omi" },
];

const loadFailuresWarned = new Set<string>();

export async function ensureBuiltInWearableConnectors(): Promise<void> {
  for (const entry of BUILT_IN_CONNECTOR_PACKAGES) {
    if (registrations.has(entry.id)) continue;
    const specifier = "@remnic/" + entry.suffix;
    let mod: { wearableConnectorRegistration?: WearableConnectorRegistration };
    try {
      mod = (await import(specifier)) as {
        wearableConnectorRegistration?: WearableConnectorRegistration;
      };
    } catch (err) {
      if (isModuleNotFound(err, specifier)) continue;
      if (!loadFailuresWarned.has(specifier)) {
        loadFailuresWarned.add(specifier);
        log.warn(
          `wearables: failed to load optional connector package ${specifier}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      continue;
    }
    const registration = mod.wearableConnectorRegistration;
    if (!registration) continue;
    try {
      registerWearableConnector(registration);
    } catch {
      // Already registered by a direct import — fine.
    }
  }
}

function isModuleNotFound(err: unknown, specifier: string): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }
  const message = (err as { message?: unknown }).message;
  // Only treat the failure as "optional package absent" when the error
  // names the specifier we asked for — a transitive resolution failure
  // inside an installed connector is a broken install worth surfacing.
  return typeof message === "string" && message.includes(specifier);
}
