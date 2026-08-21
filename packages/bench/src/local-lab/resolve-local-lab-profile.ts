/**
 * Resolve a parsed local-lab manifest into runtime ProviderConfigs.
 *
 * Resolution is the bridge between the manifest (operator-authored JSON) and
 * the harness's existing `ProviderConfig` shape: each manifest role becomes a
 * `ProviderConfig` with `temperature` and `seed` forwarded verbatim so a test
 * can assert on the resolved config (issue #1573 PR2 test list).
 *
 * Provider kind mapping (kept dumb and explicit, never silent fallback):
 *
 *   - `"openai-compatible"` → `BuiltInProvider` `"local-llm"` (the bench
 *     provider that talks `/v1/chat/completions` + `/v1/models`, requiring an
 *     explicit `baseUrl` — exactly what the manifest pins).
 *   - `"ollama"` → `"ollama"` (native `/api/generate` + `/api/tags`).
 *
 * Both baseUrl and model are copied as-is; they are only ever fetch targets,
 * never interpolated into a shell (rule 10). API keys are not part of the
 * manifest — local-lab endpoints are operator-hosted on the loopback or a
 * private host, so persisting a key into the manifest would be a footgun.
 * Operators with auth'd local endpoints pass the key out-of-band.
 *
 * `quantization` is informational only; the bench `ProviderConfig` does not
 * have a quantization field, so it is kept on the resolved role and surfaces
 * in the bench artifact (PR3's tier/hardware metadata).
 */

import type {
  LocalLabManifest,
  LocalLabManifestNotes,
  LocalLabRoleConfig,
} from "./manifest.js";
import type { BuiltInProvider, ProviderConfig } from "../types.js";

/**
 * A manifest role paired with its resolved `ProviderConfig`. The PR2 test
 * list asserts temperature/seed on `providerConfig` directly.
 */
export interface ResolvedLocalLabRole {
  readonly provider: LocalLabRoleConfig["provider"];
  readonly baseUrl: string;
  readonly model: string;
  readonly quantization?: string;
  readonly ctx: number;
  readonly temperature: number;
  readonly seed: number;
  readonly providerConfig: ProviderConfig;
}

export interface ResolvedLocalLabProfile {
  /** The parsed manifest this resolution was produced from. */
  readonly manifest: LocalLabManifest;
  readonly responder: ResolvedLocalLabRole;
  readonly judge: ResolvedLocalLabRole;
  readonly embedding?: ResolvedLocalLabRole;
  /** Phase scheduling mode. PR2 ships `"sequential"` only. */
  readonly phases: "sequential";
  /** Operator hand-off note (or undefined when not authored). */
  readonly notes?: LocalLabManifestNotes;
}

/**
 * Resolve a single manifest role into a `ResolvedLocalLabRole`, forwarding
 * `temperature` and `seed` into the `ProviderConfig` so providers can read
 * them off the config directly.
 *
 * Ollama `baseUrl`s are normalized to include `/api` so the provider posts to
 * `${baseUrl}/generate` → `…/api/generate` rather than `…/generate` (404).
 * This mirrors `discoveryEndpointFor` which already appends `/api/tags` for
 * preflight. Operators can write `http://127.0.0.1:11434` or
 * `http://127.0.0.1:11434/api` interchangeably (codex review, #1573 PR2).
 */
export function resolveLocalLabRole(role: LocalLabRoleConfig): ResolvedLocalLabRole {
  const provider = manifestProviderKindToBuiltIn(role.provider);
  const baseUrl = normalizeRoleBaseUrl(role.provider, role.baseUrl);
  const providerConfig: ProviderConfig = {
    provider,
    model: role.model,
    baseUrl,
    temperature: role.temperature,
    seed: role.seed,
  };

  return {
    provider: role.provider,
    baseUrl,
    model: role.model,
    ctx: role.ctx,
    temperature: role.temperature,
    seed: role.seed,
    ...(role.quantization ? { quantization: role.quantization } : {}),
    providerConfig,
  };
}

/**
 * Normalize a manifest role's `baseUrl` for the provider that will consume it.
 * Strips a trailing slash, then ensures:
 *   - Ollama URLs carry the `/api` path segment (`/api/generate`, `/api/tags`)
 *   - openai-compatible URLs carry the `/v1` path segment (`/v1/chat/completions`)
 * This mirrors `discoveryEndpointFor` which already appends `/v1/models` and
 * `/api/tags` for the bare-host forms, so endpoint-sameness comparisons in the
 * CLI runner see consistent URLs regardless of whether the operator wrote
 * `http://host:port` or `http://host:port/v1` (codex review, #1573 PR2).
 * Implemented without a regex so CodeQL does not flag manifest input as
 * uncontrolled pattern source.
 */
function normalizeRoleBaseUrl(
  providerKind: LocalLabRoleConfig["provider"],
  rawBaseUrl: string,
): string {
  const trimmed = rawBaseUrl.endsWith("/") ? rawBaseUrl.slice(0, -1) : rawBaseUrl;
  if (providerKind === "ollama" && !trimmed.endsWith("/api")) {
    return `${trimmed}/api`;
  }
  if (providerKind === "openai-compatible" && !trimmed.endsWith("/v1")) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}

/**
 * Resolve the full manifest into a `ResolvedLocalLabProfile`. Used by
 * `resolveBenchRuntimeProfile` for `runtimeProfile: "local-lab"`, and
 * directly by the unit test for the temperature/seed forwarding assertion.
 */
export function resolveLocalLabProfile(
  manifest: LocalLabManifest,
): ResolvedLocalLabProfile {
  return {
    manifest,
    responder: resolveLocalLabRole(manifest.responder),
    judge: resolveLocalLabRole(manifest.judge),
    ...(manifest.embedding
      ? { embedding: resolveLocalLabRole(manifest.embedding) }
      : {}),
    phases: manifest.phases,
    ...(manifest.notes ? { notes: manifest.notes } : {}),
  };
}

/**
 * Map a manifest provider kind to the bench `BuiltInProvider` enum. Throws
 * on any value not in `LOCAL_LAB_PROVIDER_KINDS` — the parser already
 * enforces this, but the guard here keeps the function total and prevents a
 * future caller from bypassing the parser.
 */
function manifestProviderKindToBuiltIn(
  kind: LocalLabRoleConfig["provider"],
): BuiltInProvider {
  if (kind === "openai-compatible") {
    return "local-llm";
  }
  if (kind === "ollama") {
    return "ollama";
  }
  const exhaustive: never = kind;
  throw new Error(`local-lab manifest provider kind unsupported: ${exhaustive}`);
}
