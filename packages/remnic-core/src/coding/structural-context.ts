/**
 * Structural-context provider port (issue #1548 Track A PR 5).
 *
 * The architectural boundary between Track A (durable coding-memory
 * features) and Track B (the native @remnic/coding-graph engine). A
 * structural-context provider expands a unified diff into the SYMBOLS it
 * touches (and optionally yields architecture hints), so review-intent
 * recall can boost memories that mention those symbols — not just the
 * bare file paths that `review-context.ts` already boosts on.
 *
 * Three providers satisfy this port, selected by
 * `codingKnowledge.structuralProvider`:
 *
 *   - `"none"`      — no provider consulted (default; review-context stays
 *                     file-path-only, byte-identical to pre-feature — rule 39).
 *   - `"subprocess"` — an external binary shelled out via `execFile` with an
 *                     argv ARRAY (never a shell string — rule 10). The
 *                     built-in adapter lives in `structural-subprocess-provider.ts`;
 *                     codebase-memory-mcp's CLI mode is the canonical target,
 *                     but the provider is command-agnostic.
 *   - `"native"`    — the in-family @remnic/coding-graph engine, adapted to
 *                     this port by a future PR (#1551/#1554). Only the enum
 *                     value and this doc note land in this PR — no engine
 *                     code. codebase-memory-mcp remains a supported
 *                     subprocess provider through this same port regardless.
 *
 * Every result is a tagged outcome shaped like #1536's `SearchDegradation`
 * (CLAUDE.md rule 34 — a degraded/absent provider must NEVER masquerade as
 * "no structural matches"):
 *   - `{ ok: true,  symbols }` on success
 *   - `{ ok: false, code }`    on every failure (distinct codes per mode)
 *
 * No module-level mutable state (rule 11): the registry is keyed per
 * orchestrator/service instance via a `Symbol.for(...)` slot on
 * `globalThis`, mirroring `host-embedding-provider.ts`.
 */
import type { CodingKnowledgeConfig, PluginConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Tagged-outcome types (rule 34 — #1536 pattern; rule 18 — object-not-null)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Distinct failure codes for the structural-context port. Every code is
 * load-bearing: callers (review-context, `remnic doctor`, xray) switch on
 * `code` to distinguish "binary not installed" from "timed out" from
 * "protocol violation" so a silent provider failure can never look like an
 * empty-but-healthy result.
 */
export type StructuralContextErrorCode =
  /** Probe failed: binary missing / not executable, or native package absent. */
  | "provider_unavailable"
  /** The provider exceeded its deadline. */
  | "provider_timeout"
  /** Output was present but not a valid JSON object/array (rule 18). */
  | "provider_malformed"
  /** Provider ran but returned an explicit error or threw. */
  | "provider_error";

/**
 * A single symbol touched by a diff. The `symbol` name is the load-bearing
 * field — it is what review-context adds to its match set. `path`/`kind`
 * are informational and surface in xray when present.
 */
export interface StructuralSymbol {
  /** Qualified or bare symbol name, e.g. `"AuthService.login"` or `"login"`. */
  readonly symbol: string;
  /** Source file the symbol lives in (forward-slashed, repo-relative when possible). */
  readonly path?: string;
  /** Coarse kind if the provider knows it (`function`/`method`/`class`/...). */
  readonly kind?: string;
}

export interface SymbolsForDiffOk {
  readonly ok: true;
  readonly symbols: StructuralSymbol[];
  /** Provider-reported latency in ms, when available. */
  readonly latencyMs?: number;
}

export interface SymbolsForDiffErr {
  readonly ok: false;
  readonly code: StructuralContextErrorCode;
  readonly detail?: string;
}

export type SymbolsForDiffResult = SymbolsForDiffOk | SymbolsForDiffErr;

export interface ArchitectureHintsOk {
  readonly ok: true;
  readonly hints: string[];
}
export interface ArchitectureHintsErr {
  readonly ok: false;
  readonly code: StructuralContextErrorCode;
  readonly detail?: string;
}
export type ArchitectureHintsResult = ArchitectureHintsOk | ArchitectureHintsErr;

/**
 * The port contract. Both the built-in subprocess adapter
 * (`structural-subprocess-provider.ts`) and the future native engine
 * adapter (#1551) implement this. Registry callers retrieve an instance by
 * scope; never construct one inline at a call site.
 */
export interface StructuralContextProvider {
  /** Stable identifier for registry logging / `remnic doctor`. */
  readonly id: string;
  /**
   * Probe availability. Resolves to a tagged result so a missing binary
   * (subprocess) or absent package (native) is surfaced, never thrown
   * (rule 34). Implementations SHOULD cache the outcome per instance
   * (rule 11).
   */
  probe(): Promise<{ available: boolean; detail?: string }>;
  /**
   * Expand a unified diff to the symbols it touches. NEVER throws — every
   * failure path returns a tagged `{ ok: false, code }`. The optional
   * `signal` lets the caller cancel an in-flight subprocess (rule 40).
   */
  symbolsForDiff(
    diff: string,
    options?: { signal?: AbortSignal },
  ): Promise<SymbolsForDiffResult>;
  /**
   * Optional architecture hints for a repo root. Used by the architecture
   * card composition (#1548 Track A PR 3 + #1554). Implementations MAY omit
   * this; callers MUST handle its absence.
   */
  architectureHints?(
    root: string,
    options?: { signal?: AbortSignal },
  ): Promise<ArchitectureHintsResult>;
  /** Release any resources the provider holds (subprocess handles, etc.). */
  close?(): Promise<void> | void;
}

// ──────────────────────────────────────────────────────────────────────────
// Degradation (shaped like SearchDegradation from search/port.ts — #1536)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Backend tag is a literal so consumers can switch on it programmatically
 * alongside `SearchDegradation` (`backend: "qmd"`). `detail` is optional
 * and never load-bearing — `code` is the signal.
 */
export interface StructuralContextDegradation {
  readonly backend: "structural-context";
  readonly code: StructuralContextErrorCode;
  readonly detail?: string;
}

/**
 * Coerce a {@link SymbolsForDiffErr} into the degradation record consumers
 * attach to recall snapshots / xray. Centralised so the `{ backend: ... }`
 * tag is set in one place (rule 22 spirit).
 */
export function toStructuralContextDegradation(
  err: SymbolsForDiffErr,
): StructuralContextDegradation {
  return { backend: "structural-context", code: err.code, detail: err.detail };
}

// ──────────────────────────────────────────────────────────────────────────
// Registry — instance-scoped via Symbol (rule 11; mirrors host-embedding)
// ──────────────────────────────────────────────────────────────────────────

const STRUCTURAL_PROVIDERS_KEY = Symbol.for(
  "remnic.structuralContextProviders",
);

function providerMap(): Map<string, StructuralContextProvider> {
  const store = globalThis as Record<PropertyKey, unknown>;
  const existing = store[STRUCTURAL_PROVIDERS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, StructuralContextProvider>;
  }
  const created = new Map<string, StructuralContextProvider>();
  store[STRUCTURAL_PROVIDERS_KEY] = created;
  return created;
}

function normalizeScope(scope: string): string {
  const normalized = typeof scope === "string" ? scope.trim() : "";
  return normalized || "default";
}

/**
 * Register a provider for a scope (typically an orchestrator `serviceId`).
 * Overwriting a previous registration closes the old provider. Returns an
 * unregister function — callers SHOULD invoke it on service teardown so a
 * hot-reloaded host does not leak subprocess handles.
 */
export function registerStructuralContextProvider(
  scope: string,
  provider: StructuralContextProvider,
): () => void {
  const key = normalizeScope(scope);
  const providers = providerMap();
  const previous = providers.get(key);
  if (previous && previous !== provider) {
    void previous.close?.();
  }
  providers.set(key, provider);
  return () => {
    const current = providerMap();
    if (current.get(key) === provider) {
      current.delete(key);
      void provider.close?.();
    }
  };
}

/** Look up the provider registered for a scope, if any. */
export function getStructuralContextProvider(
  scope: string,
): StructuralContextProvider | undefined {
  return providerMap().get(normalizeScope(scope));
}

/** Test-only: clear every registered provider. */
export function clearStructuralContextProvidersForTest(): void {
  providerMap().clear();
}

// ──────────────────────────────────────────────────────────────────────────
// Gate predicate — rule 39: ONE predicate, checked identically on every path
// ──────────────────────────────────────────────────────────────────────────

/**
 * The single gate every review-context consumer consults before consulting a
 * provider. Returns `true` iff the master `codingKnowledge.enabled` switch is
 * on AND `structuralProvider` is not `"none"`. When this returns `false`,
 * review-context runs its pure file-path-only ranker — byte-identical to
 * pre-feature behaviour on every path.
 */
export function structuralProviderActive(config: PluginConfig): boolean {
  const ck = config.codingKnowledge;
  if (ck === undefined || ck === null) return false;
  return ck.enabled === true && ck.structuralProvider !== "none";
}

// ──────────────────────────────────────────────────────────────────────────
// Doctor / xray status — pure config-only summariser + renderer
// (the live PROBE lives in structural-subprocess-provider.ts so this module
//  stays free of subprocess / optional-package imports)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Config-only structural provider status. `remnic doctor` and xray render
 * this; an async sibling in `structural-subprocess-provider.ts` augments it
 * with a live `probed` field.
 */
export interface StructuralProviderStatus {
  readonly active: boolean;
  readonly mode: CodingKnowledgeConfig["structuralProvider"];
  /** Command path when mode is `"subprocess"` and a command is configured. */
  readonly command?: string;
  /** Provider id when one is registered for the scope. */
  readonly providerId?: string;
  /** Live probe outcome — set only by the async doctor probe. */
  probed?: { available: boolean; detail?: string };
}

/**
 * Summarise the structural provider status from config ALONE (no probe, no
 * I/O). Pure — safe to call from any context, including the recall hot path
 * for xray labels.
 */
export function describeStructuralProviderStatus(
  config: PluginConfig,
  scope?: string,
): StructuralProviderStatus {
  const ck = config.codingKnowledge;
  const mode: CodingKnowledgeConfig["structuralProvider"] =
    ck?.structuralProvider ?? "none";
  const active = structuralProviderActive(config);
  const provider =
    scope !== undefined ? getStructuralContextProvider(scope) : undefined;
  return {
    active,
    mode,
    command:
      mode === "subprocess" && ck?.structuralProviderCommand
        ? ck.structuralProviderCommand
        : undefined,
    providerId: provider?.id,
  };
}

/**
 * Render a single human-readable line for `remnic doctor`. Pure.
 *
 *   `structural-context provider: none (inactive — review-context stays file-path-only)`
 *   `structural-context provider: subprocess, command=/usr/local/bin/cbm, probed=available`
 *   `structural-context provider: subprocess, command=/usr/local/bin/cbm, probed=unavailable (binary not found)`
 */
export function renderStructuralProviderStatusLine(
  status: StructuralProviderStatus,
): string {
  if (!status.active) {
    return `structural-context provider: ${status.mode} (inactive — review-context stays file-path-only)`;
  }
  const parts = [`structural-context provider: ${status.mode}`];
  if (status.command) parts.push(`command=${status.command}`);
  if (status.providerId) parts.push(`registered=${status.providerId}`);
  if (status.probed) {
    parts.push(
      status.probed.available
        ? "probed=available"
        : `probed=unavailable${status.probed.detail ? ` (${status.probed.detail})` : ""}`,
    );
  }
  return parts.join(", ");
}
