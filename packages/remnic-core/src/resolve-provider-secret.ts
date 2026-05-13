import { log } from "./logger.js";
import { readEnvVar } from "./runtime/env.js";
import path from "node:path";
import os from "node:os";

/**
 * Resolve a provider API key using OpenClaw's own auth resolution system.
 *
 * This module delegates to the gateway's `resolveApiKeyForProvider()` function,
 * which handles all secret reference formats (SecretRef objects, auth profiles,
 * "secretref-managed" markers, environment variables, etc.) using the same
 * codepath the gateway uses for its own agent sessions.
 *
 * For plain-text API keys, a fast path returns them directly without
 * involving the gateway auth system.
 *
 * Results are cached per provider for the gateway process lifetime.
 */

type ResolveApiKeyFn = (params: {
  provider: string;
  cfg?: unknown;
  agentDir?: string;
}) => Promise<{ apiKey?: string; source?: string; mode?: string } | null>;

/**
 * Resolve request-ready auth for a model, including provider-owned transforms
 * (e.g., OAuth token exchange, base URL override for openai-codex).
 */
export type GetRuntimeAuthForModelFn = (params: {
  model: { provider: string; id: string; api?: string; baseUrl?: string };
  cfg?: unknown;
  workspaceDir?: string;
}) => Promise<{
  apiKey?: string;
  baseUrl?: string;
  source?: string;
  mode?: string;
  profileId?: string;
} | null>;

let _resolveApiKeyForProvider: ResolveApiKeyFn | null = null;
let _getRuntimeAuthForModel: GetRuntimeAuthForModelFn | null = null;
let _resolverLoaded = false;
let _resolverNextRetryAt = 0;
const RESOLVER_RETRY_BACKOFF_MS = 60_000; // 1 minute between retries after first failure
const resolvedCache = new Map<string, string | undefined>();

/**
 * Lazily load the gateway's resolveApiKeyForProvider function.
 * Returns null if not available (e.g., running outside the gateway process).
 */
async function getGatewayResolver(): Promise<ResolveApiKeyFn | null> {
  if (_resolverLoaded) {
    return _resolveApiKeyForProvider;
  }
  // Backoff: don't re-scan filesystem on every call when module wasn't found.
  // After a failure, wait RESOLVER_RETRY_BACKOFF_MS before trying again.
  if (_resolverNextRetryAt > 0 && Date.now() < _resolverNextRetryAt) {
    return null;
  }

  try {
    // The gateway bundles this in a runtime chunk — import it dynamically.
    // This import path is stable across gateway versions since it's a named runtime export.
    const candidates = [
      // Try glob-matching the runtime module name (hash varies per build)
      ...await findRuntimeModules(),
    ];

    const { pathToFileURL } = await import("node:url");
    for (const candidate of candidates) {
      try {
        // Convert native path to file:// URL for cross-platform ESM import compatibility
        const importUrl = pathToFileURL(candidate).href;
        const mod = await import(importUrl);
        if (typeof mod.resolveApiKeyForProvider === "function") {
          _resolveApiKeyForProvider = mod.resolveApiKeyForProvider;
          if (typeof mod.getRuntimeAuthForModel === "function") {
            _getRuntimeAuthForModel = mod.getRuntimeAuthForModel;
            log.debug("loaded gateway getRuntimeAuthForModel from runtime module");
          }
          _resolverLoaded = true;
          log.debug("loaded gateway resolveApiKeyForProvider from runtime module");
          return _resolveApiKeyForProvider;
        }
      } catch {
        // Try next candidate
      }
    }
  } catch {
    // Silent
  }

  // Backoff before retrying — avoid repeated fs scanning.
  // Retries after RESOLVER_RETRY_BACKOFF_MS so the resolver can
  // recover if the gateway restarts or the module becomes available.
  _resolverNextRetryAt = Date.now() + RESOLVER_RETRY_BACKOFF_MS;
  log.debug(`gateway resolveApiKeyForProvider not available — will retry after ${RESOLVER_RETRY_BACKOFF_MS / 1000}s`);
  return null;
}

/**
 * Find the gateway's model-auth runtime module by scanning the dist directory.
 * Uses require.resolve to find the openclaw package regardless of install method.
 */
async function findRuntimeModules(): Promise<string[]> {
  return findGatewayRuntimeModules("runtime-model-auth.runtime-");
}

/**
 * Discover gateway runtime module files matching the given filename prefix.
 *
 * Reused by adjacent SecretRef resolution code (`resolve-auth-token.ts`,
 * issue #757). Walks the same dist-dir candidates as the model-auth path
 * so callers don't reimplement install-method discovery.
 */
export async function findGatewayRuntimeModules(filePrefix: string): Promise<string[]> {
  const { accessSync, constants, readdirSync, realpathSync, statSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const candidates: string[] = [];

  const distDirs: string[] = [];
  const pushDistDirs = (entryPath: string): void => {
    const resolvedEntryDir = path.dirname(entryPath);
    const packageRoot = path.basename(resolvedEntryDir) === "dist"
      ? path.resolve(resolvedEntryDir, "..")
      : resolvedEntryDir;
    const candidateDistDirs = [
      path.join(packageRoot, "dist"),
      path.join(packageRoot, "..", "dist"),
    ];
    for (const candidate of candidateDistDirs) {
      const resolved = path.resolve(candidate);
      if (!distDirs.includes(resolved)) distDirs.push(resolved);
    }
  };

  try {
    const req = createRequire(import.meta.url);
    const openclawMain = req.resolve("openclaw");
    pushDistDirs(openclawMain);
  } catch {
    // openclaw not resolvable from plugin context — try alternate paths
  }

  try {
    const mainScript = process.argv[1];
    if (mainScript) {
      const realScript = realpathSync(mainScript);
      if (realScript.includes("openclaw")) {
        pushDistDirs(realScript);
      }
    }
  } catch {
    // Silent
  }

  try {
    const openclawBin = findExecutableOnPath("openclaw", accessSync, statSync, constants.X_OK);
    if (openclawBin) {
      pushDistDirs(realpathSync(openclawBin));
    }
  } catch {
    // Silent
  }

  for (const dir of distDirs) {
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (f.startsWith(filePrefix) && f.endsWith(".js")) {
          candidates.push(path.join(dir, f));
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return candidates;
}

function findExecutableOnPath(
  executableName: string,
  access: (path: string, mode?: number) => void,
  stat: (path: string) => { isFile(): boolean },
  executableMode: number,
): string | undefined {
  const pathEnv = readEnvVar("PATH");
  if (!pathEnv) return undefined;

  const pathExts = process.platform === "win32"
    ? (readEnvVar("PATHEXT") ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter((ext) => ext.length > 0)
    : [""];
  const hasExtension = path.extname(executableName).length > 0;

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidateNames = process.platform === "win32" && !hasExtension
      ? pathExts.map((ext) => `${executableName}${ext}`)
      : [executableName];

    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      try {
        access(candidate, executableMode);
        if (!stat(candidate).isFile()) continue;
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }

  return undefined;
}

export const __findExecutableOnPathForTest = findExecutableOnPath;

/**
 * Resolve a provider API key from various OpenClaw formats.
 *
 * Resolution order:
 * 1. Plain-text string → returned immediately
 * 2. Gateway's resolveApiKeyForProvider → handles all secret ref formats
 * 3. Environment variable fallback (PROVIDER_NAME_API_KEY)
 * 4. undefined → provider is skipped in the fallback chain
 */
export async function resolveProviderApiKey(
  providerId: string,
  apiKeyValue: unknown,
  gatewayConfig?: unknown,
  agentDir?: string,
): Promise<string | undefined> {
  const resolvedAgentDir = path.resolve(
    agentDir ?? path.join(os.homedir(), ".openclaw", "agents", "main", "agent"),
  );

  // Check cache first
  const cacheKey = `provider:${providerId}:agentDir:${resolvedAgentDir}`;
  if (resolvedCache.has(cacheKey)) {
    return resolvedCache.get(cacheKey);
  }

  let resolved: string | undefined;

  // Fast path: plain-text string that looks like an actual API key
  if (typeof apiKeyValue === "string" && apiKeyValue.trim().length > 0) {
    // Skip known non-API-key markers used by the gateway for auth modes
    // that don't use bearer tokens (OAuth, local endpoints, GCP credentials)
    if (
      apiKeyValue === "secretref-managed" ||
      apiKeyValue.endsWith("-oauth") ||
      apiKeyValue.endsWith("-local") ||
      apiKeyValue === "lm-studio" ||
      apiKeyValue.startsWith("gcp-")
    ) {
      // Fall through to gateway resolver / env var fallback
    } else {
      resolved = apiKeyValue;
      resolvedCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  // The API key is either a SecretRef object, "secretref-managed", or empty.
  // Try the gateway's own auth resolution system first.
  const resolver = await getGatewayResolver();
  if (resolver) {
    try {
      const auth = await resolver({ provider: providerId, cfg: gatewayConfig, agentDir: resolvedAgentDir });
      if (auth?.apiKey) {
        resolved = auth.apiKey;
        log.debug(`resolved API key for provider "${providerId}" via gateway auth (source: ${auth.source ?? "unknown"}, mode: ${auth.mode ?? "unknown"})`);
        resolvedCache.set(cacheKey, resolved);
        return resolved;
      }
    } catch (err) {
      log.debug(
        `gateway auth resolution failed for provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Environment variable fallback
  resolved = resolveFromEnv(providerId);
  if (resolved) {
    log.debug(`resolved API key for provider "${providerId}" from environment variable`);
  } else {
    log.debug(`could not resolve API key for provider "${providerId}" — skipping`);
  }

  // Only cache successful resolutions — failures are retried on next call
  // so providers can recover after transient issues (e.g., 1Password agent restart)
  if (resolved) {
    resolvedCache.set(cacheKey, resolved);
  }
  return resolved;
}

/**
 * Try to resolve an API key from environment variables.
 */
function resolveFromEnv(providerId: string): string | undefined {
  const normalized = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const candidates = [
    `${normalized}_API_KEY`,
    `${normalized}_TOKEN`,
  ];
  for (const envVar of candidates) {
    const value = readEnvVar(envVar);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Get the gateway's getRuntimeAuthForModel function, if available.
 * This resolves request-ready auth including provider-owned transforms
 * (OAuth token exchange, base URL override for codex/copilot/etc.).
 * Must be called after at least one resolveProviderApiKey() call to
 * trigger the lazy module load.
 */
export async function getGatewayRuntimeAuthForModel(): Promise<GetRuntimeAuthForModelFn | null> {
  // Ensure the runtime module has been loaded
  await getGatewayResolver();
  return _getRuntimeAuthForModel;
}

/**
 * Clear the resolution cache (useful for testing or key rotation).
 */
export function clearSecretCache(): void {
  resolvedCache.clear();
  _resolveApiKeyForProvider = null;
  _getRuntimeAuthForModel = null;
  _resolverLoaded = false;
  _resolverNextRetryAt = 0;
}

export function __setGatewayResolverForTest(resolver: ResolveApiKeyFn | null): void {
  _resolveApiKeyForProvider = resolver;
  _resolverLoaded = resolver !== null;
  _resolverNextRetryAt = 0;
}

export function __setGatewayRuntimeAuthForModelForTest(
  resolver: GetRuntimeAuthForModelFn | null,
): void {
  _getRuntimeAuthForModel = resolver;
  _resolverLoaded = resolver !== null || _resolveApiKeyForProvider !== null;
  _resolverNextRetryAt = 0;
}
