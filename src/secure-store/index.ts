// Stub re-export so tests + downstream consumers can resolve the
// secure-store surface via the conventional `src/` root used elsewhere
// in this monorepo. Mirrors the pattern in `src/cli.ts`,
// `src/access-cli.ts`, etc.
export * from "@remnic/core/secure-store/index";
// `export *` does NOT re-export namespace bindings (`export * as
// keyring from ...`). Re-export those explicitly so the test surface
// matches the package surface.
export { keyring } from "@remnic/core/secure-store/index";
