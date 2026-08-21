// Shared helpers for the CLI's optional-package dynamic-import loaders.
//
// Every optional @remnic/* companion package uses the same "swallow only
// when this specific package is missing, otherwise re-throw" pattern, so
// extracting the check here removes the duplication between
// optional-bench.ts and optional-weclone-export.ts (Cursor review
// feedback on PR #545) and gives us one place to get the specifier-
// matching logic right.

/**
 * Return true when `err` is a module-not-found failure for exactly the
 * `specifier` we were trying to import.
 *
 * Node's ESM loader raises `ERR_MODULE_NOT_FOUND` both when the
 * top-level package is missing and when the package is installed but one
 * of its transitive dependencies can't be resolved. The latter is a
 * broken release, not an "optional package not installed" situation,
 * and emitting the install hint for it sends users chasing the wrong
 * problem. We therefore require the error message / URL to reference
 * the specifier we actually requested before treating it as "missing".
 */
export function isSpecifierNotFoundError(err: unknown, specifier: string): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }

  // Node's "Cannot find package 'x' imported from y" / CJS
  // "Cannot find module 'x'" messages both embed the failing specifier.
  // A transitive miss embeds the *inner* specifier, not ours — so we
  // only treat this as a miss for our package when the message names
  // our specifier specifically.
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    if (message.includes(`'${specifier}'`)) return true;
    if (message.includes(`"${specifier}"`)) return true;
    // Some runtimes emit the specifier unquoted; guard the boundary so
    // "@remnic/bench" doesn't match "@remnic/bench-ui".
    const boundaryRegex = new RegExp(
      `(?:^|[\\s"'\`\\(])${escapeRegex(specifier)}(?:[\\s"'\`\\)]|$)`,
    );
    if (boundaryRegex.test(message)) return true;
  }

  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
