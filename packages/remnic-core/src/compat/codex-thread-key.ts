/**
 * Deprecated alias subpath `@remnic/core/codex-thread-key`.
 *
 * PR #1638 renamed `src/codex-thread-key.ts` -> `src/thread-key.ts` to
 * graduate the host-prefixed name per CLAUDE.md rule 31. This thin re-export
 * keeps the old subpath resolving during the compat window so external
 * consumers importing `@remnic/core/codex-thread-key` do not hit
 * ERR_PACKAGE_PATH_NOT_EXPORTED. It forwards every export to the canonical
 * module -- no logic is duplicated.
 *
 * Removal timeline: v10.0.0 (see issue #1643).
 * Import from `@remnic/core/thread-key` instead.
 */
export * from "../thread-key.js";

process.emitWarning(
  "@remnic/core/codex-thread-key is a deprecated alias; import from @remnic/core/thread-key instead. Removed in v10.0.0 (issue #1643).",
  {
    type: "DeprecationWarning",
    code: "REMNIC_DEP_CORE_SUBPATH_CODEX_THREAD_KEY",
    detail: "PR #1638 renamed codex-thread-key.ts to thread-key.ts.",
  },
);
