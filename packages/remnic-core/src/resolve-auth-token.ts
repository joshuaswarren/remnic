import type { AgentAccessAuthToken, SecretRef } from "./types.js";

/**
 * Resolve `agentAccessHttp.authToken` (issue #757).
 *
 * Two shapes are accepted:
 *
 *   1. Plain string — returned unchanged. This is the only shape supported
 *      in standalone Remnic; it preserves backward compatibility with every
 *      pre-#757 config.
 *
 *   2. SecretRef-like object (`{source, provider?, id?, command?, ...}`) —
 *      resolved only through a resolver supplied by the host adapter. Core
 *      stays host-agnostic and never scans OpenClaw, Hermes, or any other
 *      runtime directly.
 *
 * Resolution flow for SecretRef objects:
 *
 *   - Plain strings short-circuit before any host work.
 *   - Host adapters pass their native SecretRef resolver in `options`.
 *   - If no resolver is provided, throw a clear, actionable error rather
 *     than silently leaving the bridge open or starting with no auth.
 *
 * Lessons baked in from PRs #316–#319:
 *
 *   - Successful resolutions are cached for the process lifetime; failures
 *     are not cached so transient issues (Keychain unlocked late, agent
 *     restarts) recover automatically.
 */

export type ResolveSecretRefFn = (
  ref: SecretRef,
  context?: unknown,
) => Promise<string | undefined> | string | undefined;

type ResolveAgentAccessAuthTokenOptions = {
  resolveSecretRef?: ResolveSecretRefFn | null;
};

let resolvedCache = new WeakMap<ResolveSecretRefFn, Map<string, string>>();

/**
 * SecretRef objects are stable per (source, provider, id, command) tuple.
 * Sort keys before serializing so semantically-identical refs hit the same
 * cache slot regardless of authoring order (Lesson 38 in CLAUDE.md).
 */
function cacheKeyForSecretRef(ref: SecretRef): string {
  const sortedKeys = Object.keys(ref).sort();
  const stable: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    stable[key] = ref[key];
  }
  return JSON.stringify(stable);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve an `agentAccessHttp.authToken` value to a literal bearer string.
 *
 * @returns the resolved string, or `undefined` if input was undefined/empty.
 * @throws if the input is a SecretRef and no resolver is provided, if the
 *         resolver returns no value, or if the input shape is malformed.
 */
export async function resolveAgentAccessAuthToken(
  value: AgentAccessAuthToken | undefined,
  options: ResolveAgentAccessAuthTokenOptions = {},
): Promise<string | undefined> {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error(
      "unsupported SecretRef shape for agentAccessHttp.authToken — " +
        "expected a string or an object with a `source` field " +
        "(see https://github.com/joshuaswarren/remnic/issues/757)",
    );
  }

  const ref = value as SecretRef;
  if (typeof ref.source !== "string" || ref.source.trim().length === 0) {
    throw new Error(
      "unsupported SecretRef shape for agentAccessHttp.authToken — " +
        "missing required `source` field " +
        "(see https://github.com/joshuaswarren/remnic/issues/757)",
    );
  }

  const resolver = options.resolveSecretRef ?? null;
  if (!resolver) {
    throw new Error(
      `cannot resolve agentAccessHttp.authToken SecretRef (source="${ref.source}") — ` +
        "a SecretRef resolver was not provided. Use a literal string or " +
        "${ENV_VAR} expansion in standalone Remnic, or have the host adapter " +
        "resolve SecretRef objects through its native secret resolver " +
        "(see https://github.com/joshuaswarren/remnic/issues/757).",
    );
  }

  const cacheKey = cacheKeyForSecretRef(ref);
  let resolverCache = resolvedCache.get(resolver);
  if (!resolverCache) {
    resolverCache = new Map<string, string>();
    resolvedCache.set(resolver, resolverCache);
  }
  const cached = resolverCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let resolved: string | undefined;
  try {
    const out = await resolver(ref);
    if (typeof out === "string") {
      const trimmed = out.trim();
      if (trimmed.length > 0) resolved = trimmed;
    }
  } catch (err) {
    throw new Error(
      `failed to resolve agentAccessHttp.authToken SecretRef (source="${ref.source}"): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!resolved) {
    throw new Error(
      `agentAccessHttp.authToken SecretRef resolved to empty value (source="${ref.source}", provider="${
        ref.provider ?? ""
      }") — refusing to start the HTTP bridge with an empty bearer token.`,
    );
  }

  resolverCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Returns true if the value is a SecretRef object (issue #757). Useful for
 * surfaces (CLI flags, doctor checks) that want to render a redacted
 * placeholder instead of leaking the unresolved object shape.
 */
export function isAgentAccessSecretRef(value: unknown): value is SecretRef {
  if (!isPlainObject(value)) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.source === "string" && ref.source.trim().length > 0;
}

/** Test/operations hook: drop the cache and force resolver rediscovery. */
export function clearAuthTokenSecretCache(): void {
  resolvedCache = new WeakMap<ResolveSecretRefFn, Map<string, string>>();
}
