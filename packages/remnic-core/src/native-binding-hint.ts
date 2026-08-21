/**
 * Actionable recovery hint for a missing or ABI-mismatched better-sqlite3
 * native binding (issue #2719).
 *
 * `better-sqlite3` publishes prebuilds for LTS Node only, so a newer runtime
 * installs the package with no loadable binding and every SQLite-backed path
 * fails with a bindings-resolution error. The raw error names neither the
 * running ABI nor the command that fixes it, so operators saw only
 * "Could not locate the bindings file" at first use.
 *
 * The repair itself lives in the `@remnic/core` postinstall script — an
 * OpenClaw plugin package may not ship a child-process-spawning file, so the
 * host-facing packages surface this hint instead of re-implementing a rebuild.
 */

/** Substrings that identify a native-binding load failure, lowercased. */
const BINDING_ERROR_MARKERS = [
  "could not locate the bindings file",
  "was compiled against a different node.js version",
  "node_module_version",
  "invalid elf header",
  "better_sqlite3.node",
];

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

/** True when the error is a better-sqlite3 native-binding load failure. */
export function isNativeBindingError(error: unknown): boolean {
  const message = messageOf(error).toLowerCase();
  if (message.length === 0) return false;
  return BINDING_ERROR_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Suffix naming the running Node ABI and the exact rebuild command, or an
 * empty string when the error is unrelated. Callers append it to their own
 * message so an unrelated failure reads exactly as before.
 */
export function nativeBindingRecoveryHint(error: unknown): string {
  if (!isNativeBindingError(error)) return "";
  const major = process.versions.node.split(".")[0] ?? process.versions.node;
  return (
    ` — better-sqlite3 has no loadable native binding for Node ${major}` +
    ` (ABI ${process.versions.modules}); rebuild it with` +
    " `npm rebuild better-sqlite3 --build-from-source`"
  );
}
