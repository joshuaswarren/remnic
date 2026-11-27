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

export interface BetterSqlite3DriverProbe {
  /** true when the native binding loaded successfully under this process. */
  ok: boolean;
  /** Path-free detail string (class + code) from `displayErrorDetail`; "" when ok. */
  detail: string;
  /** true when the failure is classified as a native-binding ABI mismatch. */
  nativeBindingMismatch: boolean;
}

/**
 * Attempt to load the better-sqlite3 native driver under the running process
 * WITHOUT opening a database. Used by the server startup check (issue #1829)
 * to surface a wrong-ABI build loudly instead of letting each memory browse
 * silently fall back to a full-corpus scan. Never throws — callers log the
 * result. A successful probe also warms the ctor cache for later opens.
 */
export function probeBetterSqlite3Driver(): BetterSqlite3DriverProbe {
  try {
    loadBetterSqlite3();
    return { ok: true, detail: "", nativeBindingMismatch: false };
  } catch (error) {
    return {
      ok: false,
      detail: displayErrorDetail(error),
      nativeBindingMismatch: isLikelyBetterSqlite3NativeBindingError(error),
    };
  }
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

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Iterate an error and every node reachable along its `cause` chain and any
 * `AggregateError.errors` siblings (depth-first), cycle-safe via a visited set.
 *
 * Native-binding failures thrown from openBetterSqlite3 /
 * probeBetterSqlite3Driver are caught and re-thrown as a sanitized
 * `unavailableError` WRAPPER: the wrapper's message drops the ABI markers
 * (NODE_MODULE_VERSION, better_sqlite3.node, …) that live on the ORIGINAL
 * error. So classification must walk `.cause` (and aggregate siblings) instead
 * of inspecting only the top wrapper's message — otherwise startup logs, browse
 * warnings, and the memory_projection doctor check all MISS the native-binding
 * hint (issue #1848).
 */
function* errorChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined) continue;
    if (typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    yield node;
    // Narrow with `in` (not a cast) so the property access is compiler-checked.
    if ("cause" in node) {
      const cause = node.cause;
      if (cause !== null && cause !== undefined) stack.push(cause);
    }
    if ("errors" in node) {
      const errors = node.errors;
      if (Array.isArray(errors)) {
        for (const member of errors) {
          if (member !== null && member !== undefined) stack.push(member);
        }
      }
    }
  }
}

function messageHasNativeBindingMarker(error: unknown): boolean {
  const detail = rawErrorMessage(error);
  return (
    detail.includes("Could not locate the bindings file") ||
    detail.includes("better_sqlite3.node") ||
    (detail.includes("node-v") && detail.includes("better-sqlite3")) ||
    (detail.includes("NODE_MODULE_VERSION") && detail.includes("better-sqlite3")) ||
    detail.includes("was compiled against a different Node.js version")
  );
}

export function isLikelyBetterSqlite3NativeBindingError(error: unknown): boolean {
  for (const node of errorChain(error)) {
    if (messageHasNativeBindingMarker(node)) return true;
  }
  return false;
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

export function displayErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.length > 0 ? `${error.name} (${code})` : error.name;
}
