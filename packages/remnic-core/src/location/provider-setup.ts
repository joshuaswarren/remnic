/**
 * Location provider bootstrapping (issue #2047).
 *
 * Core never statically imports a provider package (adapter-isolation test),
 * so every surface calls this before status/check/sync: it registers
 * configured providers from optional packages via computed-specifier dynamic
 * imports, with credentials read from environment variables — tokens never
 * enter config files, errors, or logs. A source whose package or credentials
 * are absent stays unregistered and the pipeline reports
 * `provider-not-registered`; that is a skip reason, never an error (the
 * connector-reitti package's README contract).
 */

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
  /** Injectable env (tests); defaults to REITTI_* process variables. */
  env?: LocationProviderEnv;
  /** Injectable module loader (tests); defaults to a dynamic import. */
  importModule?: (specifier: string) => Promise<unknown>;
}

interface ReittiProviderModule {
  ensureReittiProviderRegistered(options: {
    baseUrl: string;
    token: string;
    timezone: string;
    authMode?: "x-api-token" | "bearer";
  }): boolean;
}

const loadFailuresWarned = new Set<string>();

function readReittiEnv(): LocationProviderEnv {
  return {
    baseUrl: readEnvVar("REITTI_BASE_URL"),
    token: readEnvVar("REITTI_TOKEN"),
    authMode: readEnvVar("REITTI_AUTH_MODE"),
  };
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
  for (const source of config.sources) {
    if (!source.enabled) continue;
    if (getLocationProvider(source.id) !== undefined) continue;
    // ponytail: only the `reitti` built-in exists today; add cases here as
    // provider packages land — a registry table when there is more than one.
    if (source.id !== "reitti") continue;
    const env = deps.env ?? readReittiEnv();
    const baseUrl = env.baseUrl?.trim();
    const token = env.token?.trim();
    if (!baseUrl || !token) continue;
    const authMode =
      env.authMode === "x-api-token" || env.authMode === "bearer" ? env.authMode : undefined;
    const specifier = "@remnic/" + "connector-reitti";
    const load = deps.importModule ?? ((s: string) => import(s));
    try {
      const mod = (await load(specifier)) as ReittiProviderModule;
      if (
        mod.ensureReittiProviderRegistered({
          baseUrl,
          token,
          timezone: config.timezone,
          ...(authMode !== undefined ? { authMode } : {}),
        })
      ) {
        registered.push("reitti");
      }
    } catch (err) {
      // Absent optional package is the common case (skip silently); a real
      // load failure is worth one warn line, never credentials.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes(specifier)) {
        if (!loadFailuresWarned.has(specifier)) {
          loadFailuresWarned.add(specifier);
          log.warn(`location: failed to load optional provider package ${specifier}: ${message}`);
        }
      }
    }
  }
  return registered;
}
