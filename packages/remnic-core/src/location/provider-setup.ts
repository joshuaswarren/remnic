
import { readEnvVar } from "../runtime/env.js";
import { log } from "../logger.js";
import { getLocationProvider } from "./registry.js";
import type { LocationConfig } from "./types.js";

/** Environment shape the setup reads for the `reitti` source. */
export interface LocationProviderEnv {
  baseUrl?: string;
  token?: string;
  authMode?: string;
}

export interface LocationProviderSetupDeps {
  /** Injectable env (tests); defaults to provider-specific process variables. */
  env?: LocationProviderEnv;
  /** Per-source env overrides keyed by provider id. */
  envBySource?: ReadonlyMap<string, LocationProviderEnv>;
  /** Injectable module loader (tests); defaults to a dynamic import. */
  importModule?: (specifier: string) => Promise<unknown>;
  /** Injectable setup lookup (tests); defaults to the global setup registry. */
  getSetup?: (id: string) => LocationProviderSetupEntry | undefined;
}

export type LocationProviderPackageLoader = <TModule>() => Promise<TModule>;

export interface LocationProviderSetupContext {
  readonly config: LocationConfig;
  readonly env?: LocationProviderEnv;
  readonly loadPackage: LocationProviderPackageLoader;
}

export interface LocationProviderSetupEntry {
  readonly id: string;
  readonly packageSpecifier: string;
  readonly setup: (context: LocationProviderSetupContext) => Promise<boolean>;
}

interface ReittiProviderRegistrationOptions {
  baseUrl: string;
  token: string;
  timezone: string;
  authMode?: "x-api-token" | "bearer";
}

interface ReittiProviderModule {
  ensureReittiProviderRegistered(options: ReittiProviderRegistrationOptions): boolean;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// Computed scope prefix prevents bundlers from statically resolving optional connectors.
const OPTIONAL_PACKAGE_SCOPE = "@remnic/";

const loadFailuresWarned = new Set<string>();

function readReittiEnv(): LocationProviderEnv {
  return {
    baseUrl: readEnvVar("REITTI_BASE_URL"),
    token: readEnvVar("REITTI_TOKEN"),
    authMode: readEnvVar("REITTI_AUTH_MODE"),
  };
}

const BUILT_IN_LOCATION_PROVIDER_SETUPS: readonly LocationProviderSetupEntry[] = [
  {
    id: "reitti",
    packageSpecifier: `${OPTIONAL_PACKAGE_SCOPE}connector-reitti`,
    async setup(context) {
      const env = context.env ?? readReittiEnv();
      const baseUrl = env.baseUrl?.trim();
      const token = env.token?.trim();
      if (!baseUrl || !token) return false;
      const mod = await context.loadPackage<ReittiProviderModule>();
      const options: ReittiProviderRegistrationOptions = {
        baseUrl,
        token,
        timezone: context.config.timezone,
      };
      if (env.authMode === "x-api-token" || env.authMode === "bearer") {
        options.authMode = env.authMode;
      }
      return mod.ensureReittiProviderRegistered(options);
    },
  },
];

const providerSetups = new Map<string, LocationProviderSetupEntry>();

function seedBuiltInProviderSetups(): void {
  for (const entry of BUILT_IN_LOCATION_PROVIDER_SETUPS) {
    providerSetups.set(entry.id, entry);
  }
}

seedBuiltInProviderSetups();

function assertValidProviderSetup(entry: LocationProviderSetupEntry): void {
  if (!entry || !(entry instanceof Object)) {
    throw new TypeError("location provider setup must be an object");
  }
  if (!entry.id || entry.id.constructor !== String || !PROVIDER_ID_PATTERN.test(entry.id)) {
    throw new RangeError(
      "location provider setup id must be a non-empty lowercase kebab string (a-z, 0-9, hyphens)",
    );
  }
  if (
    !entry.packageSpecifier ||
    entry.packageSpecifier.constructor !== String ||
    entry.packageSpecifier.trim().length === 0
  ) {
    throw new TypeError(`location provider setup '${entry.id}' must declare a non-empty packageSpecifier`);
  }
  if (!(entry.setup instanceof Function)) {
    throw new TypeError(`location provider setup '${entry.id}' must implement setup()`);
  }
}

/** Register an optional location provider bootstrap entry for a source id. */
export function registerLocationProviderSetup(entry: LocationProviderSetupEntry): void {
  assertValidProviderSetup(entry);
  if (providerSetups.has(entry.id)) {
    throw new Error(`location provider setup '${entry.id}' is already registered`);
  }
  providerSetups.set(entry.id, {
    id: entry.id,
    packageSpecifier: entry.packageSpecifier.trim(),
    setup: entry.setup,
  });
}

/** Remove a registered provider setup entry by id. Returns `true` if removed. */
export function unregisterLocationProviderSetup(id: string): boolean {
  return Boolean(id && id.constructor === String && providerSetups.delete(id));
}

/** Look up a registered provider setup entry by source id. */
export function getLocationProviderSetup(id: string): LocationProviderSetupEntry | undefined {
  return !id || id.constructor !== String ? undefined : providerSetups.get(id);
}

/** List registered provider setup source ids in sorted order. */
export function listLocationProviderSetups(): string[] {
  return [...providerSetups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Test-only: reset provider setups to built-in defaults and clear warned specifiers. */
export function resetLocationProviderSetups(): void {
  providerSetups.clear();
  loadFailuresWarned.clear();
  seedBuiltInProviderSetups();
}

/**
 * Register every configured+enabled source's provider when its optional
 * package and credentials are available. Idempotent; returns the ids this
 * call registered. Never throws — a missing package or credential set is
 * reported downstream as `provider-not-registered`.
 */
export async function ensureConfiguredLocationProviders(
  config: LocationConfig,
  deps: LocationProviderSetupDeps = {},
): Promise<string[]> {
  const registered: string[] = [];
  if (!config.enabled) return registered;
  const load = deps.importModule ?? ((s: string) => import(s));
  const resolveSetup = deps.getSetup ?? getLocationProviderSetup;
  for (const source of config.sources) {
    if (!source.enabled) continue;
    if (getLocationProvider(source.id) !== undefined) continue;
    const entry = resolveSetup(source.id);
    if (entry === undefined) continue;
    const env = deps.envBySource?.get(source.id) ?? deps.env;
    const loadPackage: LocationProviderPackageLoader = async <TModule>(): Promise<TModule> => {
      // SAFETY: Dynamic ESM import returns an opaque module namespace; each
      // registered setup entry declares its optional package's export contract.
      return (await load(entry.packageSpecifier)) as TModule;
    };
    try {
      if (await entry.setup({ config, env, loadPackage })) {
        registered.push(source.id);
      }
    } catch (err) {
      // Absent optional package is the common case (skip silently); a real
      // load failure is worth one warn line, never credentials.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes(entry.packageSpecifier)) {
        if (!loadFailuresWarned.has(entry.packageSpecifier)) {
          loadFailuresWarned.add(entry.packageSpecifier);
          log.warn(
            `location: failed to load optional provider package ${entry.packageSpecifier}: ${message}`,
          );
        }
      }
    }
  }
  return registered;
}
