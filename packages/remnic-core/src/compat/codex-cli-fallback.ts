/**
 * Deprecated alias subpath `@remnic/core/codex-cli-fallback`.
 *
 * PR #1638 renamed `src/codex-cli-fallback.ts` -> `src/cli-fallback.ts` to
 * graduate the host-prefixed name per CLAUDE.md rule 31 (generic @remnic/core
 * modules must not carry a host prefix). This thin re-export keeps the old
 * subpath resolving during the compat window so external consumers importing
 * `@remnic/core/codex-cli-fallback` do not hit ERR_PACKAGE_PATH_NOT_EXPORTED.
 * It forwards every export to the canonical module -- no logic is duplicated.
 *
 * Removal timeline: v10.0.0 (see issue #1643).
 * Import from `@remnic/core/cli-fallback` instead.
 */
export * from "../cli-fallback.js";

process.emitWarning(
  "@remnic/core/codex-cli-fallback is a deprecated alias; import from @remnic/core/cli-fallback instead. Removed in v10.0.0 (issue #1643).",
  {
    type: "DeprecationWarning",
    code: "REMNIC_DEP_CORE_SUBPATH_CODEX_CLI_FALLBACK",
    detail: "PR #1638 renamed codex-cli-fallback.ts to cli-fallback.ts.",
  },
);
