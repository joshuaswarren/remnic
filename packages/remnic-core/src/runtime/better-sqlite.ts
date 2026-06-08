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

// Raw, unredacted message — used ONLY for internal classification (detecting a
// native-binding mismatch). Never returned to a user-facing surface, because it
// can contain absolute paths. Native-binding markers (better_sqlite3.node,
// NODE_MODULE_VERSION, "was compiled against a different Node.js version") live
// in error.message, so message text is sufficient and we never read .stack.
function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isLikelyBetterSqlite3NativeBindingError(error: unknown): boolean {
  // Classify on the RAW message so redaction can't strip detection markers
  // (e.g. the path containing "better_sqlite3.node").
  const detail = rawErrorMessage(error);
  return (
    detail.includes("Could not locate the bindings file") ||
    detail.includes("better_sqlite3.node") ||
    (detail.includes("node-v") && detail.includes("better-sqlite3")) ||
    (detail.includes("NODE_MODULE_VERSION") && detail.includes("better-sqlite3")) ||
    detail.includes("was compiled against a different Node.js version")
  );
}

function unavailableError(error: unknown): Error {
  const detail = displayErrorDetail(error);
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

// Sanitized, user-facing error detail. This string becomes the message of the
// Error thrown by unavailableError(), which propagates to user-facing surfaces
// (HTTP error bodies, MCP tool errors — access-http.ts / access-mcp.ts return
// err.message). We must not leak server internals (CodeQL js/stack-trace-exposure):
//   - error.stack is never read.
// We deliberately surface only the error's class name and Node error code —
// never the raw message. Node module-load failures embed absolute server paths
// directly in error.message (the "Require stack:" block, and unquoted native
// loader paths that may even contain spaces), which no regex can redact
// reliably. The error code (MODULE_NOT_FOUND, ERR_DLOPEN_FAILED, …) is a stable,
// path-free identifier that, together with the native-binding hint, is enough
// for a user to act on. The full original error stays on the `cause` chain and
// is logged with its stack elsewhere.
export function displayErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.length > 0 ? `${error.name} (${code})` : error.name;
}
