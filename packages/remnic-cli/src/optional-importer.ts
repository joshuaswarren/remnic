//
// Adding a new importer:
//   1. Append its name to `SUPPORTED_IMPORTERS`.
//   2. Publish the package as `@remnic/import-<name>`.
//   3. The package MUST export an `adapter` conforming to
//      `ImporterAdapter<unknown>` from `@remnic/core`. Register-on-import
//      side effects are optional — the CLI prefers the named export because
//      side-effect registration breaks à la carte testing.

import type { ImporterAdapter } from "@remnic/core";

import { isSpecifierNotFoundError } from "./optional-module-loader.js";

/**
 * Shape every `@remnic/import-*` package must export.
 *
 * The CLI only consumes the adapter, so packages may also export source-
 * specific helpers (parsers, fixture types) for library use; those exports
 * are not part of the loader contract.
 */
export interface ImporterModule {
  adapter: ImporterAdapter<unknown>;
}

export const SUPPORTED_IMPORTERS = [
  "chatgpt",
  "claude",
  "gemini",
  "mem0",
  "supermemory",
  "okf",
] as const;
export type SupportedImporterName = (typeof SUPPORTED_IMPORTERS)[number];

export function isSupportedImporterName(value: string): value is SupportedImporterName {
  return (SUPPORTED_IMPORTERS as readonly string[]).includes(value);
}

const cached = new Map<string, ImporterModule | null>();

/**
 * Load a specific importer module. Returns the module when installed, throws
 * a user-facing install hint when not installed, and re-throws any other
 * error (syntax errors, transitive missing deps) so broken releases remain
 * diagnosable. Results are cached per CLI invocation.
 */
export async function loadImporterModule(
  name: SupportedImporterName,
): Promise<ImporterModule> {
  if (cached.has(name)) {
    const hit = cached.get(name);
    if (hit) return hit;
    throw notInstalledError(name);
  }

  const specifier = "@remnic/" + "import-" + name;
  try {
    const mod = (await import(specifier)) as Partial<ImporterModule> & {
      // Some packages export the adapter under a name-prefixed export; we
      // accept either the canonical `adapter` export or a `<name>Adapter`
      // alias to keep the contract flexible for slice-authoring ergonomics.
      [key: string]: unknown;
    };
    const resolved = resolveAdapterExport(mod, name);
    if (!resolved) {
      throw new Error(
        `The optional package '${specifier}' loaded but does not export an ImporterAdapter. ` +
          `Expected either 'adapter' or '${name}Adapter' export.`,
      );
    }
    cached.set(name, { adapter: resolved });
    return { adapter: resolved };
  } catch (err) {
    if (isSpecifierNotFoundError(err, specifier)) {
      cached.set(name, null);
      throw notInstalledError(name);
    }
    throw err;
  }
}

function resolveAdapterExport(
  mod: Record<string, unknown>,
  name: string,
): ImporterAdapter<unknown> | undefined {
  const candidates = [mod.adapter, mod[`${name}Adapter`], mod[`${name}ImportAdapter`]];
  for (const candidate of candidates) {
    if (isImporterAdapter(candidate)) return candidate;
  }
  return undefined;
}

function isImporterAdapter(value: unknown): value is ImporterAdapter<unknown> {
  if (!value || typeof value !== "object") return false;
  const adapter = value as Partial<ImporterAdapter<unknown>>;
  return (
    typeof adapter.name === "string" &&
    typeof adapter.sourceLabel === "string" &&
    typeof adapter.parse === "function" &&
    typeof adapter.transform === "function" &&
    typeof adapter.writeTo === "function"
  );
}

function notInstalledError(name: SupportedImporterName): Error {
  const pkg = `@remnic/import-${name}`;
  return new Error(
    `The '${name}' importer requires the optional ${pkg} package.\n` +
      "\n" +
      "Install it alongside the CLI:\n" +
      `  npm install -g ${pkg}\n` +
      "\n" +
      "Or add it to a project:\n" +
      `  pnpm add ${pkg}\n`,
  );
}

/** Visible for tests that need to reset the importer cache between cases. */
export function clearImporterModuleCacheForTesting(): void {
  cached.clear();
}
