// Lazy loader for the optional @remnic/import-lossless-claw package.
//
// CLAUDE.md à-la-carte invariant: optional packages MUST be loaded via
// computed-specifier dynamic imports so bundlers cannot statically resolve
// them. Mirrors optional-bench.ts / optional-weclone-export.ts.
//
// Type-shape declared manually (not via `typeof import(...)`) so the CLI
// type-checks even when the optional package is not yet linked into
// node_modules — same pattern as optional-importer.ts.

import type { openLcmDatabase } from "@remnic/core";

import { isSpecifierNotFoundError } from "./optional-module-loader.js";

const SPECIFIER = "@remnic/" + "import-lossless-claw";

type BetterSqlite3DatabaseLike = ReturnType<typeof openLcmDatabase>;

export interface ImportLosslessClawModule {
  openSourceDatabase(filePath: string): BetterSqlite3DatabaseLike;
  assertLosslessClawSchema(db: BetterSqlite3DatabaseLike): void;
  openInMemoryDestinationDatabase(): BetterSqlite3DatabaseLike;
  openExistingLcmDatabaseReadOnly(filePath: string): BetterSqlite3DatabaseLike;
  importLosslessClaw(options: {
    sourceDb: BetterSqlite3DatabaseLike;
    destDb: BetterSqlite3DatabaseLike;
    dryRun?: boolean;
    sessionFilter?: ReadonlySet<string>;
    onLog?: (line: string) => void;
  }): {
    conversationsScanned: number;
    sessionsTouched: string[];
    messagesInserted: number;
    messagesSkipped: number;
    messagePartsInserted: number;
    messagePartsSkipped: number;
    summariesInserted: number;
    summariesSkipped: number;
    summariesMultiParentCollapsed: number;
    summariesSkippedNoMessages: number;
    summariesSkippedMultiSession: number;
    compactionEventsInserted: number;
    dryRun: boolean;
  };
}

let cached: ImportLosslessClawModule | null | undefined;

async function tryImport(): Promise<ImportLosslessClawModule | null> {
  try {
    return (await import(SPECIFIER)) as ImportLosslessClawModule;
  } catch (err) {
    if (isSpecifierNotFoundError(err, SPECIFIER)) {
      return null;
    }
    throw err;
  }
}

export async function loadImportLosslessClawModule(): Promise<ImportLosslessClawModule> {
  if (cached === undefined) {
    cached = await tryImport();
  }
  if (!cached) {
    throw new Error(
      "The `remnic import-lossless-claw` command requires the optional " +
        "@remnic/import-lossless-claw package.\n" +
        "\n" +
        "Install it alongside the CLI:\n" +
        "  npm install -g @remnic/import-lossless-claw\n" +
        "\n" +
        "Or add it to a project:\n" +
        "  pnpm add @remnic/import-lossless-claw\n",
    );
  }
  return cached;
}
