import { log } from "./logger.js";
import { readEnvVar } from "./runtime/env.js";
import path from "node:path";

/**
 * Resolve provider API keys while keeping core host-agnostic.
 *
 * Plain-text API keys and provider-derived environment variables are handled
 * directly. Host-specific secret references are resolved only when the caller
 * supplies the host's native resolver. Core must not discover OpenClaw, Hermes,
 * or any other runtime on its own.
 *
 * Results are cached per provider and resolver context for the process lifetime.
 */

export type ResolveApiKeyFn = (params: {
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

export interface ProviderSecretResolutionOptions {
  resolveApiKeyForProvider?: ResolveApiKeyFn | null;
}

export interface RuntimeAuthResolutionOptions {
  getRuntimeAuthForModel?: GetRuntimeAuthForModelFn | null;
}

let _resolveApiKeyForProviderForTest: ResolveApiKeyFn | null = null;
let _getRuntimeAuthForModelForTest: GetRuntimeAuthForModelFn | null = null;
const resolvedCache = new Map<string, string | undefined>();
const cacheObjectIds = new WeakMap<object, number>();
let nextCacheObjectId = 1;
const NON_LITERAL_AUTH_MARKERS = new Set([
  "secretref-managed",
  "lm-studio",
]);
const ENV_VAR_MARKER_RE =
  /^[A-Z][A-Z0-9_]*(?:_API_KEY|_ACCESS_TOKEN|_TOKEN|_SECRET|_CREDENTIALS|_CREDENTIALS_JSON)$/;

function isNonLiteralAuthMarker(value: string): boolean {
  return (
    NON_LITERAL_AUTH_MARKERS.has(value) ||
    value.endsWith("-oauth") ||
    value.endsWith("-local") ||
    value.startsWith("gcp-") ||
    ENV_VAR_MARKER_RE.test(value)
  );
}

function resolveFromNamedEnvVar(marker: string): string | undefined {
  if (!ENV_VAR_MARKER_RE.test(marker)) return undefined;
  const value = readEnvVar(marker);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function cacheIdentity(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${String(value)}`;
  if (typeof value === "boolean") return `boolean:${String(value)}`;
  if (typeof value === "bigint") return `bigint:${String(value)}`;
  if (typeof value === "symbol" || typeof value === "function") return typeof value;
  if (typeof value === "object") {
    const existingId = cacheObjectIds.get(value);
    if (existingId !== undefined) return `object:${existingId}`;
    const newId = nextCacheObjectId++;
    cacheObjectIds.set(value, newId);
    return `object:${newId}`;
  }
  return String(value);
}

function providerSecretCacheKey(
  providerId: string,
  resolvedAgentDir: string,
  apiKeyValue: unknown,
  gatewayConfig: unknown,
): string {
  return [
    `provider:${providerId}`,
    `agentDir:${resolvedAgentDir}`,
    `apiKey:${cacheIdentity(apiKeyValue)}`,
    `cfg:${cacheIdentity(gatewayConfig)}`,
  ].join(":");
}

/**
 * Resolve a provider API key from literal values, environment markers, or an
 * injected host resolver.
 *
 * Resolution order:
 * 1. Plain-text string → returned immediately
 * 2. Injected host resolveApiKeyForProvider → handles host secret ref formats
 * 3. Environment variable fallback (PROVIDER_NAME_API_KEY)
 * 4. undefined → provider is skipped in the fallback chain
 */
export async function resolveProviderApiKey(
  providerId: string,
  apiKeyValue: unknown,
  gatewayConfig?: unknown,
  agentDir?: string,
  options: ProviderSecretResolutionOptions = {},
): Promise<string | undefined> {
  const resolvedAgentDir = agentDir ? path.resolve(agentDir) : "";

  let resolved: string | undefined;

  // Fast path: plain-text string that looks like an actual API key
  if (typeof apiKeyValue === "string" && apiKeyValue.trim().length > 0) {
    const trimmedApiKeyValue = apiKeyValue.trim();
    // Skip known non-API-key markers used by the gateway for auth modes,
    // plus env-var-shaped markers such as OPENAI_API_KEY.
    if (isNonLiteralAuthMarker(trimmedApiKeyValue)) {
      const markerEnvValue = resolveFromNamedEnvVar(trimmedApiKeyValue);
      if (markerEnvValue) {
        return markerEnvValue;
      }
      // Fall through to gateway resolver / env var fallback
    } else {
      return trimmedApiKeyValue;
    }
  }

  const cacheKey = providerSecretCacheKey(providerId, resolvedAgentDir, apiKeyValue, gatewayConfig);
  if (resolvedCache.has(cacheKey)) {
    return resolvedCache.get(cacheKey);
  }

  // The API key is either a SecretRef object, "secretref-managed", or empty.
  // Try the host-supplied auth resolution system first.
  const resolver = options.resolveApiKeyForProvider ?? _resolveApiKeyForProviderForTest;
  if (resolver) {
    try {
      const auth = await resolver({ provider: providerId, cfg: gatewayConfig, agentDir: resolvedAgentDir });
      if (auth?.apiKey) {
        resolved = auth.apiKey;
        log.debug(`resolved API key for provider "${providerId}" via host auth (source: ${auth.source ?? "unknown"}, mode: ${auth.mode ?? "unknown"})`);
        resolvedCache.set(cacheKey, resolved);
        return resolved;
      }
    } catch (err) {
      log.debug(
        `host auth resolution failed for provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`,
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
 * Get a host-supplied getRuntimeAuthForModel function, if available.
 * This resolves request-ready auth including provider-owned transforms
 * (OAuth token exchange, base URL override for codex/copilot/etc.).
 */
export async function getGatewayRuntimeAuthForModel(
  options: RuntimeAuthResolutionOptions = {},
): Promise<GetRuntimeAuthForModelFn | null> {
  return options.getRuntimeAuthForModel ?? _getRuntimeAuthForModelForTest;
}

/**
 * Clear the resolution cache (useful for testing or key rotation).
 */
export function clearSecretCache(): void {
  resolvedCache.clear();
  _resolveApiKeyForProviderForTest = null;
  _getRuntimeAuthForModelForTest = null;
}

export function __setGatewayResolverForTest(resolver: ResolveApiKeyFn | null): void {
  _resolveApiKeyForProviderForTest = resolver;
}

export function __setGatewayRuntimeAuthForModelForTest(
  resolver: GetRuntimeAuthForModelFn | null,
): void {
  _getRuntimeAuthForModelForTest = resolver;
}
