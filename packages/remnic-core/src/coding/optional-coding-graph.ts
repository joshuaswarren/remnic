// Lazy loader for the optional @remnic/coding-graph package.
//
// Remnic's core is installed à-la-carte: users who only need memory
// features should not have to install codebase-graph tooling, so
// @remnic/coding-graph is an optional peer dependency, not a bundled
// dependency. Any code path that actually needs the graph engine calls
// loadCodingGraphEngineFactory() or one of the try* helpers; the loader
// either returns the engine factory or throws a user-facing install hint.
//
// Justification for the dynamic import:
//   CLAUDE.md rule 57 / AGENTS.md rule 44 require à-la-carte optional
//   workspace packages to be loaded via a *computed-specifier* dynamic
//   import. Static `import "@remnic/coding-graph"` would either fail the
//   base install when the optional package is absent or — worse — force
//   the bundler to bundle it into @remnic/core's dist. Concat'ing the
//   specifier from string literals keeps the dynamic import a runtime
//   call. The same pattern is canonical in
//   packages/remnic-cli/src/optional-bench.ts and
//   packages/remnic-cli/src/optional-module-loader.ts; we mirror it here
//   because core, not the CLI, owns the engine entry point.
//
// Type-source direction:
//   The CodingGraphEngine interface and supporting IR types live in
//   packages/remnic-core/src/coding/coding-graph-types.ts (a local
//   types-only module). They are owned by core; @remnic/coding-graph
//   imports them and implements against them. This breaks the type
//   cycle that would otherwise require core to resolve
//   @remnic/coding-graph at compile time. Core's tsup DTS phase emits
//   declarations against the package's compiled output — this would
//   fail in CI's fresh base install where the optional peer is not
//   symlinked. With the types owned locally, the loader types its
//   dynamic-import result through the local shape (validated at runtime
//   via a structural check, not via TS) so the base install compiles.
//
// Failure-mode policy:
//   - Missing optional package → install hint (loadCodingGraphEngineFactory
//     throws the canonical user-facing message).
//   - Present-but-mismatched install (the optional package resolves to a
//     module that does not satisfy the structural contract) →
//     `module_load_failed` Error on the loadFactory path; probe paths
//     return null with no throw (graceful degradation). User sees a
//     real diagnostic telling them the install is broken — NOT the
//     "npm install @remnic/coding-graph" install hint, which would
//     mislead users into re-installing a package that is already there.
//   - Present-but-broken install (transitive dep missing, loader
//     fault, etc.) → underlying import error is rethrown on the
//     loadFactory path; probe paths swallow and return null.
//   - Three separate cache slots, kept strictly disjoint:
//     (a) `cachedLoadResult` — successful-module cache, read by both
//         loadFactory and tryLoad. Never populated on missing or
//         broken installs (preserves the "users see the real
//         diagnostic" invariant).
//     (b) `inFlightProbe` — in-flight promise slot shared by concurrent
//         probe callers; cleared once settled.
//     (c) (No "absent result" cache.) loadFactory ALWAYS attempts a
//         fresh import on a fresh call — never serves a stale
//         decision from a previous attempt.

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

/**
 * Structural minimal shape of `@remnic/coding-graph`'s public surface,
 * as seen by core after a successful dynamic import. We narrow to
 * `unknown` first (since the dynamic import returns `any` at runtime)
 * and then to this interface only after the runtime check below.
 */
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

/**
 * Outcome of a single import attempt. The probe path collapses
 * "missing" and "incompatible" into `null` (graceful degradation);
 * the loader path distinguishes the two so users get an accurate
 * diagnostic instead of a misleading install hint on a broken install.
 */
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

/**
 * Build the present-but-incompatible diagnostic. The user has the
 * package installed but it does not satisfy the structural contract;
 * "npm install @remnic/coding-graph" would NOT help them (the package
 * is already there). Tell them to reinstall or open an issue.
 */
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

/**
 * Return true when `err` is a module-not-found failure for exactly the
 * `@remnic/coding-graph` specifier. Same boundary-aware regex as
 * packages/remnic-cli/src/optional-module-loader.ts so transitive
 * misses (a broken @remnic/coding-graph release) bubble up rather than
 * being mis-reported as "run npm install".
 *
 * Exported for tests; the production loaders call the internal alias
 * below.
 */
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
  // Boundary guard so "@remnic/coding-graph" does not match
  // "@remnic/coding-graph-foo".
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundaryRegex = new RegExp(
    `(?:^|[\\s"'\`\\(])${escaped}(?:[\\s"'\`\\)]|$)`,
  );
  return boundaryRegex.test(message);
}

/**
 * Narrow a dynamic import result to the local LoadedCodingGraphModule
 * shape via a runtime structural check (never inline-as casting).
 * The cast-through-unknown double-step satisfies the rule that
 * "unchecked casts" must be justified; here the check is the runtime
 * predicate below.
 */
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

/**
 * Single import attempt. Returns a tagged-outcome object so callers
 * can distinguish "not installed" from "incompatible build" from
 * "broken transitive dep" — each gets its own diagnostic on the
 * user-facing path.
 *
 * Never reads from any cache; the calling function decides whether
 * to consult the success cache first.
 */
async function tryImportCodingGraphModule(): Promise<ImportAttemptOutcome> {
  // The dynamic `import()` with a runtime-concatenated specifier is the
  // documented à-la-carte loader pattern. See file header.
  let mod: unknown;
  try {
    // Cast through `unknown` is justified here: the dynamic import below
    // is the LOADING BOUNDARY between core (no compile-time dependency on
    // @remnic/coding-graph by design — see file header) and the optional
    // package whose shape we have documented locally. We validate the
    // structural shape before using any of the cast fields, so the cast
    // asserts the boundary, not specific fields.
    mod = (await import(SPECIFIER)) as unknown;
  } catch (err) {
    if (isSpecifierNotFoundErrorForCodingGraph(err)) {
      return { kind: "missing" };
    }
    // Non-specifier error (broken transitive dep, loader fault, etc.)
    // is wrapped so the loader can surface the diagnostic on a fresh
    // attempt and the probe path can still swallow.
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
  // Fast path: a previous successful load populated cachedLoadResult.
  // Reading it here matches the CLI `loadBenchModule` pattern and the
  // probe path's convention of sharing the success result (Cursor
  // Bugbot P3 round 5: "Loader skips success cache"). The fast path is
  // intentionally read-only — we never write the success cache from
  // the probe or fail-fast paths, so a probe that returned null cannot
  // convert into a stale loader result here.
  if (cachedLoadResult !== undefined && cachedLoadResult !== null) {
    return cachedLoadResult.createCodingGraphEngine;
  }
  // Fresh attempt — never inherited from a probe failure. Users see
  // the real diagnostic on broken installs.
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

/**
 * Run the probe attempt with a Promise slot so concurrent callers
 * await the same in-flight import (Cursor Bugbot P2 round 4).
 * Successful results are also written into `cachedLoadResult` so a
 * SUBSEQUENT loadCodingGraphEngineFactory skips the import (the
 * success-cache fast path above). All non-ok outcomes (missing,
 * incompatible, broken) are collapsed to `null` so the probe stays
 * boolean-safe for gate-off consumers.
 */
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
      // Defensive: tryImportCodingGraphModule does not reject in
      // practice (we wrap all throws), but a future refactor could
      // regress it — keep the probe boolean-safe.
      return null as LoadedCodingGraphModule | null;
    });
  inFlightProbe = p;
  // Once settled, clear the in-flight slot so a future call after a
  // long delay still re-attempts. The successful module result lives
  // on in cachedLoadResult if it succeeded.
  p.finally(() => {
    if (inFlightProbe === p) {
      inFlightProbe = null;
    }
  });
  return p;
}

// ---------------------------------------------------------------------------
// Cache slots — see file header for the failure-mode policy that justifies
// these being three separate slots.
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
  // Fast path: a previous loadFactory call stored a successful module.
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
