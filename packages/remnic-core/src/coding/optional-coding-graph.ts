// Lazy loader for the optional @remnic/coding-graph package.
//
// Remnic's core is installed à-la-carte: users who only need memory features
// should not have to install codebase-graph tooling, so @remnic/coding-graph
// is an optional peer dependency, not a bundled dependency. Any code path
// that actually needs the graph engine calls loadCodingGraphEngineFactory()
// or one of the try* helpers; the loader either returns the engine factory
// or throws a user-facing install hint.
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
// The shape of the engine comes from a top-level `import type` so type
// checking and refactoring tools see the dependency without bundling it.

import type {
  CodingGraphEngine,
  CodingGraphLanguage,
  FileIR,
  ParseFileInput,
  ParseResult,
  SymbolIR,
  CreateCodingGraphEngineOptions,
} from "@remnic/coding-graph";

const SPECIFIER = "@remnic/" + "coding-graph";

type CodingGraphModule = typeof import("@remnic/coding-graph");

let cached: CodingGraphModule | null | undefined;

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
 * packages/remnic-cli/src/optional-module-loader.ts so transitive misses
 * (a broken @remnic/coding-graph release) bubble up rather than being
 * mis-reported as "run npm install".
 *
 * Exported for tests; the production loaders call the internal alias below.
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

async function tryImportCodingGraphModule(): Promise<CodingGraphModule | null> {
  // The dynamic `import()` with a runtime-concatenated specifier is the
  // documented à-la-carte loader pattern. See file header.
  try {
    return (await import(SPECIFIER)) as CodingGraphModule;
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
  // `cached.createCodingGraphEngine` is the named export from the
  // resolved module; the dynamic import `as CodingGraphModule` makes
  // it statically typed without rebundling the optional package.
  return cached.createCodingGraphEngine;
}

/**
 * Return `true` only when `@remnic/coding-graph` can be loaded. Use this
 * for gate-off characterization (CLAUDE.md rule 30/48 — `codingGraph.enabled`
 * defaults `false`, and when off the loader must never run). Returns
 * `false` when the package is absent; never throws.
 */
export async function isCodingGraphInstalled(): Promise<boolean> {
  return (await tryLoadCodingGraphModule()) !== null;
}

/**
 * Return the engine factory module if `@remnic/coding-graph` is installed,
 * or `null` if it is not. Use this for code paths that can degrade
 * gracefully when the optional package is absent; do NOT use it where the
 * absence is a user-facing error (use `loadCodingGraphEngineFactory` for
 * that).
 */
export async function tryLoadCodingGraphModule(): Promise<CodingGraphModule | null> {
  if (cached === undefined) {
    cached = await tryImportCodingGraphModule();
  }
  return cached ?? null;
}

/**
 * Re-export of the public engine types so consumers can stay in `core`
 * (the engine contract is owned by `core`, not the optional package).
 *
 * Why: rule 31 — generic names, no host prefix. The branded types live in
 * the optional package; we expose them under core so call-sites don't need
 * a separate import line that fails the moment the optional package goes
 * missing.
 */
export type {
  CodingGraphEngine,
  CodingGraphLanguage,
  FileIR,
  ParseFileInput,
  ParseResult,
  SymbolIR,
  CreateCodingGraphEngineOptions,
};
