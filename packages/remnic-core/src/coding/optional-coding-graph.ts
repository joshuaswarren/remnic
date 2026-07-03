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

let cached: LoadedCodingGraphModule | null | undefined;

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
      // Present but mismatched — treat as a missing install so the hint
      // surfaces cleanly. A future PR may add a richer diagnostic, but
      // for PR1 this keeps the contract identical to "not installed".
      return null;
    }
    return mod;
  } catch (err) {
    if (isSpecifierNotFoundErrorForCodingGraph(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Load `@remnic/coding-graph` if installed and return its
 * `createCodingGraphEngine` factory. Throws a user-facing install hint
 * when the package is absent. Cached per process so repeated calls do
 * not re-import.
 */
export async function loadCodingGraphEngineFactory(): Promise<
  (options?: CreateCodingGraphEngineOptions) => CodingGraphEngine
> {
  if (cached === undefined) {
    cached = await tryImportCodingGraphModule();
  }
  if (!cached) {
    throw notInstalledError();
  }
  return cached.createCodingGraphEngine;
}

/**
 * Return `true` only when `@remnic/coding-graph` can be loaded. Use this
 * for gate-off characterization (CLAUDE.md rule 30/48 —
 * `codingGraph.enabled` defaults `false`, and when off the loader must
 * never run). Returns `false` when the package is absent; never throws.
 */
export async function isCodingGraphInstalled(): Promise<boolean> {
  return (await tryLoadCodingGraphModule()) !== null;
}

/**
 * Return the engine factory module if `@remnic/coding-graph` is
 * installed, or `null` if it is not. Use this for code paths that can
 * degrade gracefully when the optional package is absent; do NOT use it
 * where the absence is a user-facing error (use
 * `loadCodingGraphEngineFactory` for that).
 */
export async function tryLoadCodingGraphModule(): Promise<LoadedCodingGraphModule | null> {
  if (cached === undefined) {
    cached = await tryImportCodingGraphModule();
  }
  return cached ?? null;
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
