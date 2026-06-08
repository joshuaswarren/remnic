import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";

export type BetterSqlite3Database = BetterSqlite3.Database;
type BetterSqlite3Ctor = typeof BetterSqlite3;
type RuntimeRequire = ReturnType<typeof createRequire>;

let cachedCtor: BetterSqlite3Ctor | null = null;

function loadBetterSqlite3(): BetterSqlite3Ctor {
  if (cachedCtor) return cachedCtor;

  const require = createRequire(import.meta.url);

  try {
    cachedCtor = requireBetterSqlite3Ctor(require);
    return cachedCtor;
  } catch (error) {
    throw unavailableError(error);
  }
}

export function openBetterSqlite3(
  file: string,
  options?: ConstructorParameters<BetterSqlite3Ctor>[1],
): BetterSqlite3Database {
  const Database = loadBetterSqlite3();
  return new Database(file, options);
}

function requireBetterSqlite3Ctor(require: RuntimeRequire): BetterSqlite3Ctor {
  const loaded = require("better-sqlite3") as
    | BetterSqlite3Ctor
    | { default?: BetterSqlite3Ctor };
  const ctor = typeof loaded === "function" ? loaded : loaded.default;

  if (typeof ctor !== "function") {
    throw new Error("module did not export a constructor");
  }

  return ctor;
}

export function isLikelyBetterSqlite3NativeBindingError(error: unknown): boolean {
  const detail = errorDetail(error);
  return (
    detail.includes("Could not locate the bindings file") ||
    detail.includes("better_sqlite3.node") ||
    (detail.includes("node-v") && detail.includes("better-sqlite3")) ||
    (detail.includes("NODE_MODULE_VERSION") && detail.includes("better-sqlite3")) ||
    detail.includes("was compiled against a different Node.js version")
  );
}

function unavailableError(error: unknown): Error {
  const detail = errorDetail(error);
  const nativeBindingHint = isLikelyBetterSqlite3NativeBindingError(error)
    ? " This usually means the better-sqlite3 native binding was not compiled for this Node.js/platform combination. " +
      "Run `node scripts/ensure-better-sqlite3.mjs` from the Remnic install directory, or run " +
      "`npx node-gyp rebuild --directory=node_modules/better-sqlite3` if the verification script is unavailable."
    : "";
  return new Error(
    "better-sqlite3 is unavailable. Remnic attempted to load the native SQLite binding and could not." +
      nativeBindingHint +
      (detail ? ` Original error: ${detail}` : ""),
    { cause: error instanceof Error ? error : undefined },
  );
}

function errorDetail(error: unknown): string {
  // This string becomes the message of the Error thrown by unavailableError(),
  // which propagates to user-facing surfaces (HTTP error bodies, MCP tool
  // errors — see access-http.ts / access-mcp.ts, which return err.message).
  // We must not leak server internals (CodeQL js/stack-trace-exposure):
  //   - error.stack is excluded entirely.
  //   - Node module-load errors embed absolute server paths directly in
  //     error.message: a "Require stack:" block (MODULE_NOT_FOUND) and native
  //     loader paths. We keep only the first line and redact filesystem paths.
  // The full original error is still preserved via the `cause` chain on
  // unavailableError() and logged with its stack elsewhere.
  if (error instanceof Error) {
    const firstLine = error.message.split("\n", 1)[0] ?? "";
    return redactFilesystemPaths(firstLine);
  }
  return redactFilesystemPaths(String(error ?? ""));
}

// Replace absolute filesystem paths (POSIX, UNC, or Windows drive form) with a
// placeholder so loader error text cannot expose server directory layout.
// Requires at least two path segments to avoid mangling innocuous tokens like
// "and/or". The single bounded quantifier keeps this linear (no ReDoS).
function redactFilesystemPaths(text: string): string {
  return text.replace(/(?:[A-Za-z]:)?(?:[/\\][^\s/\\'"]+){2,}/g, "<path>");
}
