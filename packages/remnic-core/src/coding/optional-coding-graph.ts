//
//
//

import {
  CODING_GRAPH_ENGINE_VERSION,
  TIER_1_LANGUAGES,
  type CodingGraphEngine,
  type CodingGraphErrorCode,
  type CodingGraphLanguage,
  type CreateCodingGraphEngineOptions,
  type FileIR,
  type ParseFileInput,
  type ParseResult,
  type SymbolIR,
} from "./coding-graph-types.js";

const SPECIFIER = "@remnic/" + "coding-graph";

interface LoadedCodingGraphModule {
  ENGINE_VERSION: string;
  TIER_1_LANGUAGES: readonly CodingGraphLanguage[];
  CodingGraphError: new (
    code: CodingGraphErrorCode,
    message: string,
    engineVersion?: string,
  ) => Error;
  createCodingGraphEngine: (
    options?: CreateCodingGraphEngineOptions,
  ) => CodingGraphEngine;
}

type ImportAttemptOutcome =
  | { readonly kind: "ok"; readonly module: LoadedCodingGraphModule }
  | { readonly kind: "missing" }
  | { readonly kind: "incompatible"; readonly actual: unknown }
  | { readonly kind: "broken"; readonly cause: unknown };

/**
 * Build the user-facing install hint message. Exported so tests can assert
 * on the exact text (CLAUDE.md rule 51 / issue #1551 prove-fail-before).
 */
export function buildCodingGraphInstallHint(): string {
  return (
    "The `@remnic/coding-graph` engine is optional and not installed in this environment.\n" +
    "\n" +
    "Install it alongside @remnic/core to enable codebase-graph features:\n" +
    "  npm install @remnic/coding-graph\n" +
    "\n" +
    "Or add it to a project (pnpm / yarn):\n" +
    "  pnpm add @remnic/coding-graph\n" +
    "  yarn add @remnic/coding-graph\n"
  );
}

function notInstalledError(): Error {
  return new Error(buildCodingGraphInstallHint());
}

function incompatibleModuleError(actual: unknown): Error {
  const keys =
    actual && typeof actual === "object"
      ? Object.keys(actual).slice(0, 8).join(", ") || "(none)"
      : typeof actual;
  return new Error(
    "`@remnic/coding-graph` is present but its module shape does not match " +
      "the expected contract. The installed build may be stale, broken, or " +
      "from an incompatible version. Try reinstalling it " +
      "(`npm install --force @remnic/coding-graph`) or pinning to a known " +
      `working version. Detected exports: ${keys}.`,
  );
}

export function isSpecifierNotFoundErrorForCodingGraph(
  err: unknown,
  specifier: string = SPECIFIER,
): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") {
    return false;
  }
  if (message.includes(`'${specifier}'`)) return true;
  if (message.includes(`"${specifier}"`)) return true;
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundaryRegex = new RegExp(
    `(?:^|[\\s"'\`\\(])${escaped}(?:[\\s"'\`\\)]|$)`,
  );
  return boundaryRegex.test(message);
}

function isLoadedCodingGraphModule(value: unknown): value is LoadedCodingGraphModule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.createCodingGraphEngine === "function" &&
    typeof candidate.CodingGraphError === "function" &&
    typeof candidate.ENGINE_VERSION === "string" &&
    Array.isArray(candidate.TIER_1_LANGUAGES)
  );
}

async function tryImportCodingGraphModule(): Promise<ImportAttemptOutcome> {
  let mod: unknown;
  try {
    mod = (await import(SPECIFIER)) as unknown;
  } catch (err) {
    if (isSpecifierNotFoundErrorForCodingGraph(err)) {
      return { kind: "missing" };
    }
    return { kind: "broken", cause: err };
  }
  if (!isLoadedCodingGraphModule(mod)) {
    return { kind: "incompatible", actual: mod };
  }
  return { kind: "ok", module: mod };
}

/**
 * Load `@remnic/coding-graph` if installed and return its
 * `createCodingGraphEngine` factory. Throws a user-facing diagnostic
 * that distinguishes three failure modes:
 *   - missing    → install hint (canonical "npm install ..." message).
 *   - incompatible → "package shape mismatch" diagnostic.
 *   - broken     → rethrows the original import error.
 *
 * Reuses the cached success path so repeated calls in the same
 * process do not re-import. On success the resolved module is cached
 * and shared with the try* helpers; a failure never poisons the cache
 * so each call attempts a fresh import.
 */
export async function loadCodingGraphEngineFactory(): Promise<
  (options?: CreateCodingGraphEngineOptions) => CodingGraphEngine
> {
  if (cachedLoadResult !== undefined && cachedLoadResult !== null) {
    return cachedLoadResult.createCodingGraphEngine;
  }
  const outcome = await tryImportCodingGraphModule();
  switch (outcome.kind) {
    case "ok":
      cachedLoadResult = outcome.module;
      return outcome.module.createCodingGraphEngine;
    case "missing":
      throw notInstalledError();
    case "incompatible":
      throw incompatibleModuleError(outcome.actual);
    case "broken":
      throw outcome.cause instanceof Error
        ? outcome.cause
        : new Error(`@remnic/coding-graph failed to load: ${String(outcome.cause)}`);
  }
}

function startProbeOnce(): Promise<LoadedCodingGraphModule | null> {
  if (inFlightProbe !== null) {
    return inFlightProbe;
  }
  const p = tryImportCodingGraphModule()
    .then((outcome) => {
      if (outcome.kind === "ok") {
        cachedLoadResult = outcome.module;
        return outcome.module;
      }
      return null;
    })
    .catch(() => {
      return null as LoadedCodingGraphModule | null;
    });
  inFlightProbe = p;
  p.finally(() => {
    if (inFlightProbe === p) {
      inFlightProbe = null;
    }
  });
  return p;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
let cachedLoadResult: LoadedCodingGraphModule | null | undefined;
let inFlightProbe: Promise<LoadedCodingGraphModule | null> | null = null;

/**
 * Return `true` only when `@remnic/coding-graph` is installed AND
 * importable in a usable shape. Returns `false` for missing, broken,
 * or incompatible installs. Never throws.
 */
export async function isCodingGraphInstalled(): Promise<boolean> {
  return (await tryLoadCodingGraphModule()) !== null;
}

/**
 * Return the engine factory module if `@remnic/coding-graph` is
 * installed AND importable in a usable shape, or `null` otherwise.
 * Use this for graceful-degradation code paths. Never throws.
 *
 * Uses an in-flight-promise slot so concurrent callers share the same
 * import attempt, then caches the successful result so subsequent
 * loadFactory calls skip the import.
 */
export async function tryLoadCodingGraphModule(): Promise<LoadedCodingGraphModule | null> {
  if (cachedLoadResult !== undefined && cachedLoadResult !== null) {
    return cachedLoadResult;
  }
  return startProbeOnce();
}

// ---------------------------------------------------------------------------
// Re-export the engine contract types and stable constants so callers can
// stay in `core` (no host prefix; the engine contract is owned by core).
// ---------------------------------------------------------------------------
export {
  CODING_GRAPH_ENGINE_VERSION,
  TIER_1_LANGUAGES,
};

export type {
  CodingGraphEngine,
  CodingGraphErrorCode,
  CodingGraphLanguage,
  CreateCodingGraphEngineOptions,
  FileIR,
  ParseFileInput,
  ParseResult,
  SymbolIR,
};
