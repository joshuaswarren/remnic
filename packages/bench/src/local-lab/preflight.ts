/**
 * Local-lab endpoint preflight (issue #1573 PR2).
 *
 * Before each phase the runner verifies the operator-hosted endpoint is
 * actually serving the model the manifest claims, with at least the
 * manifest-declared context length. The harness never manages model
 * processes — it asks the endpoint what's live and refuses to proceed
 * ("hard error listing what was found vs expected", rule 51) on any
 * mismatch. Silent fallback is explicitly forbidden.
 *
 * Discovery endpoints by provider kind:
 *
 *   - `"openai-compatible"` → `GET <baseUrl>/models` (or `/v1/models` when
 *     the baseUrl does not already end in `/v1`). The body shape mirrors the
 *     OpenAI `/v1/models` contract: `{ data: [{ id, context_length?, ... }] }`.
 *   - `"ollama"` → `GET <baseUrl>/tags` (or `/api/tags`). The body shape
 *     mirrors Ollama's `/api/tags` contract: `{ models: [{ name,
 *     details?.parameter_size?, ... }] }`.
 *
 * `baseUrl` is composed into a fetch URL only — never a shell string
 * (rule 10). Failures carry the endpoint's actual reported model list so an
 * operator can immediately see why their manifest doesn't match.
 */

import type { LocalLabProviderKind } from "./manifest.js";

/** Minimal shape the preflight reader needs from a discovered model entry. */
export interface PreflightDiscoveredModel {
  id: string;
  contextLength?: number;
}

export interface LocalLabPreflightInput {
  provider: LocalLabProviderKind;
  baseUrl: string;
  /** Exact model id the endpoint is expected to report. */
  model: string;
  /** Manifest-declared serving context length; the live endpoint must meet or exceed it. */
  ctx: number;
}

export interface LocalLabPreflightSuccess {
  ok: true;
  provider: LocalLabProviderKind;
  endpoint: string;
  expectedModel: string;
  foundModels: PreflightDiscoveredModel[];
  /** Resolved context length for the matched model, when the endpoint reports one. */
  matchedContextLength?: number;
}

export interface LocalLabPreflightFailure {
  ok: false;
  provider: LocalLabProviderKind;
  endpoint: string;
  expectedModel: string;
  foundModels: PreflightDiscoveredModel[];
  expectedCtx: number;
  matchedContextLength?: number;
  reason: string;
}

export type LocalLabPreflightResult =
  | LocalLabPreflightSuccess
  | LocalLabPreflightFailure;

export interface LocalLabPreflightOptions {
  signal?: AbortSignal;
  /** Per-request timeout. Defaults to 5 s — preflight should be fast. */
  timeoutMs?: number;
  /** Inject a fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000;

/**
 * Preflight a single manifest role. Resolves to a result object — never
 * throws for endpoint/discovery failures (those are preflight failures, not
 * runtime errors). Throws only on truly exceptional conditions (invalid
 * baseUrl shape, fetchImpl contract violation).
 */
export async function preflightLocalLabRole(
  input: LocalLabPreflightInput,
  options: LocalLabPreflightOptions = {},
): Promise<LocalLabPreflightResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const endpoint = discoveryEndpointFor(input.provider, input.baseUrl);
  const ownsController = options.signal === undefined;
  const controller = ownsController ? new AbortController() : undefined;
  const signal = options.signal ?? controller?.signal;
  const timer =
    controller === undefined
      ? undefined
      : setTimeout(() => controller.abort(new Error("preflight timeout")), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      provider: input.provider,
      endpoint,
      expectedModel: input.model,
      foundModels: [],
      expectedCtx: input.ctx,
      reason: `preflight request to ${endpoint} failed: ${detail}`,
    };
  }
  if (timer) clearTimeout(timer);

  if (!response.ok) {
    return {
      ok: false,
      provider: input.provider,
      endpoint,
      expectedModel: input.model,
      foundModels: [],
      expectedCtx: input.ctx,
      reason: `endpoint ${endpoint} returned HTTP ${response.status} ${response.statusText}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      provider: input.provider,
      endpoint,
      expectedModel: input.model,
      foundModels: [],
      expectedCtx: input.ctx,
      reason: `endpoint ${endpoint} returned non-JSON body: ${detail}`,
    };
  }

  const foundModels = extractDiscoveredModels(input.provider, parsed);
  const matched = foundModels.find((model) => model.id === input.model);
  if (matched === undefined) {
    return {
      ok: false,
      provider: input.provider,
      endpoint,
      expectedModel: input.model,
      foundModels,
      expectedCtx: input.ctx,
      reason: modelMismatchReason(input.model, foundModels),
    };
  }

  if (
    matched.contextLength !== undefined &&
    matched.contextLength < input.ctx
  ) {
    return {
      ok: false,
      provider: input.provider,
      endpoint,
      expectedModel: input.model,
      foundModels,
      expectedCtx: input.ctx,
      matchedContextLength: matched.contextLength,
      reason:
        `model ${input.model} reports context length ${matched.contextLength} tokens ` +
        `which is below the manifest ctx ${input.ctx}`,
    };
  }

  return {
    ok: true,
    provider: input.provider,
    endpoint,
    expectedModel: input.model,
    foundModels,
    ...(matched.contextLength !== undefined
      ? { matchedContextLength: matched.contextLength }
      : {}),
  };
}

/**
 * Compose the discovery URL for a provider kind + baseUrl. Never
 * interpolates into a shell — only into a fetch URL. Tolerant of trailing
 * slashes and the common `/v1` (OpenAI-compatible) / `/api` (Ollama)
 * suffixes already being present.
 */
export function discoveryEndpointFor(
  provider: LocalLabProviderKind,
  baseUrl: string,
): string {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (provider === "openai-compatible") {
    if (/\/v1$/i.test(trimmed)) {
      return `${trimmed}/models`;
    }
    return `${trimmed}/v1/models`;
  }
  if (provider === "ollama") {
    if (/\/api$/i.test(trimmed)) {
      return `${trimmed}/tags`;
    }
    return `${trimmed}/api/tags`;
  }
  const exhaustive: never = provider;
  throw new Error(`local-lab preflight provider kind unsupported: ${exhaustive}`);
}

/**
 * Format a model-mismatch reason that surfaces the found list to the
 * operator (rule 51). Does not echo the manifest's expected id back as a
 * confusing prefix — the result object already carries `expectedModel`.
 */
export function modelMismatchReason(
  expectedModel: string,
  foundModels: PreflightDiscoveredModel[],
): string {
  if (foundModels.length === 0) {
    return `endpoint reported no models; expected ${expectedModel}`;
  }
  const foundIds = foundModels.map((model) => model.id);
  const truncated = foundIds.slice(0, 20);
  const ellipsis = foundIds.length > truncated.length ? "…" : "";
  return (
    `endpoint did not report the manifest model ${expectedModel}; ` +
    `found [${truncated.join(", ")}${ellipsis}]`
  );
}

function extractDiscoveredModels(
  provider: LocalLabProviderKind,
  parsed: unknown,
): PreflightDiscoveredModel[] {
  if (!isPlainObject(parsed)) {
    return [];
  }
  if (provider === "openai-compatible") {
    return extractOpenAiModels(parsed.data);
  }
  if (provider === "ollama") {
    return extractOllamaModels(parsed.models);
  }
  const exhaustive: never = provider;
  throw new Error(`local-lab preflight provider kind unsupported: ${exhaustive}`);
}

function extractOpenAiModels(data: unknown): PreflightDiscoveredModel[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const models: PreflightDiscoveredModel[] = [];
  for (const entry of data) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.id !== "string") continue;
    models.push({
      id: entry.id,
      ...(typeof entry.context_length === "number"
        ? { contextLength: entry.context_length }
        : {}),
    });
  }
  return models;
}

function extractOllamaModels(models: unknown): PreflightDiscoveredModel[] {
  if (!Array.isArray(models)) {
    return [];
  }
  const out: PreflightDiscoveredModel[] = [];
  for (const entry of models) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.name !== "string") continue;
    out.push({ id: entry.name });
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
