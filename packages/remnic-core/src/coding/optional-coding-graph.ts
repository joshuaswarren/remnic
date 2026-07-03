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
// Failure-mode policy (Bugbot P1/P2/P3 review iterations on #1588):
//   - Missing optional package → install hint (loadCodingGraphEngineFactory throws).
//   - Present-but-broken optional package (transitive dep missing,
//     loader error, etc.) → underlying error rethrows on the
//     loadFactory path (real diagnostic on a fresh attempt).
//   - Probe / try* paths never throw; a broken install resolves to
//     `null`/`false`. They use an in-flight promise slot so concurrent
//     callers share the same import attempt.
//   - Three cache slots, kept strictly separate:
//     (a) `cachedLoadResult` — the resolved module after a SUCCESSFUL
//         loadFactory call. Read by both loadFactory and tryLoad.
//     (b) `inFlightProbe` — the Promise of the current (or most recent)
//         probe attempt. Shared between concurrent probe callers.
//     (c) (no "broken install" cache) — a probe failure is NOT cached
//         into the loadFactory path; loadFactory ALWAYS re-attempts on
//         a fresh call so users see the real diagnostic on broken
//         installs, never a stale install hint (Cursor Bugbot P2 round
//         3 + round 4).

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

// ---------------------------------------------------------------------------
// Cache slots — three, kept strictly separate.
//
// (a) `cachedLoadResult` — ONLY populated on a SUCCESSFUL loadFactory.
//     Read on subsequent loadFactory AND tryLoad calls. Never set on
//     a broken-install or missing-install path (Cursor Bugbot P2
//     round 3: probe-poisoned-loader).
//
// (b) `inFlightProbe` — the Promise of an in-flight probe attempt.
//     Concurrent probe callers await the same promise (Cursor Bugbot
//     P2 round 4: concurrent-probe-race). Cleared once settled; a
//     fresh probe after that starts a new import attempt.
//
// (c) (no "broken install" cache) — loadFactory ALWAYS re-attempts
//     fresh imports so users see the real diagnostic on broken
//     installs. Only the SUCCESS path is cached.
// ---------------------------------------------------------------------------
let cachedLoadResult: LoadedCodingGraphModule | null | undefined;
let inFlightProbe: Promise<LoadedCodingGraphModule | null> | null = null;

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

function notInstalledError(): Error {
  return new Error(buildCodingGraphInstallHint());
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
 * Imports the optional package and returns the resolved module, or null
 * if the package is missing (vs. broken — broken imports throw).
 *
 * Never reads from the cache; the calling function decides whether to
 * consult the cache first.
 */
async function tryImportCodingGraphModule(): Promise<LoadedCodingGraphModule | null> {
  // The dynamic `import()` with a runtime-concatenated specifier is the
  // documented à-la-carte loader pattern. See file header.
  try {
    // Cast through `unknown` is justified here: the dynamic import below
    // is the LOADING BOUNDARY between core (no compile-time dependency on
    // @remnic/coding-graph by design — see file header) and the optional
    // package whose shape we have documented locally. We validate the
    // structural shape before using any of the cast fields, so the cast
    // asserts the boundary, not specific fields.
    const mod = (await import(SPECIFIER)) as unknown;
    if (!isLoadedCodingGraphModule(mod)) {
      return null;
    }
    return mod;
  } catch (err) {
    if (isSpecifierNotFoundErrorForCodingGraph(err)) {
      return null;
    }
    // Non-specifier error (broken transitive dep, loader fault, etc.) —
    // rethrow so the user-facing loader path can surface the diagnostic.
    throw err;
  }
}

/**
 * Load `@remnic/coding-graph` if installed and return its
 * `createCodingGraphEngine` factory. Throws a user-facing install hint
 * when the package is absent. Reuses the cached success path so
 * repeated calls in the same process do not re-import. On success the
 * resolved module is cached and shared with the try* helpers; a broken
 * install never poisons the cache so each call attempts a fresh
 * import (Cursor Bugbot P3 round 5).
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
  const result = await tryImportCodingGraphModule();
  if (!result) {
    throw notInstalledError();
  }
  cachedLoadResult = result;
  return result.createCodingGraphEngine;
}

/**
 * Run the probe attempt with a Promise slot so concurrent callers
 * await the same in-flight import (Cursor Bugbot P2 round 4).
 * Successful results are also written into `cachedLoadResult` so a
 * SUBSEQUENT loadCodingGraphEngineFactory skips the import (the
 * success-cache fast path above).
 */
function startProbeOnce(): Promise<LoadedCodingGraphModule | null> {
  if (inFlightProbe !== null) {
    return inFlightProbe;
  }
  const p = tryImportCodingGraphModule()
    .then((mod) => {
      if (mod !== null) {
        cachedLoadResult = mod;
      }
      return mod as LoadedCodingGraphModule | null;
    })
    .catch(() => {
      // Broken install — keep probe boolean-safe (returns null) and DO
      // NOT touch cachedLoadResult. Loader can still re-attempt on a
      // fresh call.
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

/**
 * Return `true` only when `@remnic/coding-graph` is installed AND
 * importable. Returns `false` for either a missing package or a broken
 * install. Never throws — callers using this as a safe gate-off probe
 * do not need try/catch. Broken-install diagnostics surface through
 * `loadCodingGraphEngineFactory()` instead.
 */
export async function isCodingGraphInstalled(): Promise<boolean> {
  return (await tryLoadCodingGraphModule()) !== null;
}

/**
 * Return the engine factory module if `@remnic/coding-graph` is
 * installed, or `null` if it is not. Use this for graceful-degradation
 * code paths. A malformed install resolves to `null` here without
 * throwing — broken-install reporting lives on
 * `loadCodingGraphEngineFactory()`.
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
