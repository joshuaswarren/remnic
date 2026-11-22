# The CLI loads optional packages lazily through computed-specifier dynamic imports with install-hint-only swallowing, and runCli swaps process globals once per invocation behind a re-entry guard

Status: accepted

## Context
The CLI is installed à la carte: users who only need memory features should not have to install benchmark or import tooling, so optional companion packages ship separately. Optional packages must not appear in the CLI's runtime dependencies or the bundler's noExternal list, or bundlers statically resolve the imports and break optional installation. A missing optional package must produce an actionable hint, while a broken one (syntax error, init throw, transitive miss) must not masquerade as "not installed". Optional packages may not be linked when the CLI type-checks, so types cannot come from `typeof import(...)`. runCli swaps process-wide globals (stdout, stderr, env, working directory) to run one invocation; concurrent or nested invocations would interleave streams, and a logger initialized before the swap pins the console backend and misses the swapped streams. Config files carry several generations of block ids (legacy shim installs alongside the canonical entry), and remote diagnosis must target the session the caller actually ran.

## Decision
1. Every optional companion package (bench, the per-source importers, weclone export, lossless-claw) is an optional peer dependency loaded lazily via computed-specifier dynamic imports, so the bundler cannot statically resolve the specifier (the CLAUDE.md invariant: optional packages stay out of runtime dependencies and the bundled noExternal list). The bundler config keeps optional packages external. Type shapes are declared manually so the CLI type-checks even when the package is not linked into node_modules.
2. Loaders return the module or throw a user-facing install hint that includes the package name and an install command the user can actually run — never a raw MODULE_NOT_FOUND. ONLY the "this package isn't installed" error is swallowed; syntax errors, init throws, and ERR_MODULE_NOT_FOUND from a transitive miss inside the optional package all surface, so broken releases are diagnosable instead of producing a misleading install hint. The specifier-matching logic lives in one shared helper.
3. Importer adapters are accepted under the canonical `adapter` export or a `<name>Adapter` alias, keeping the contract flexible for slice authoring.
4. runCli is guarded against module-level re-entry, because it swaps process-wide globals. Everything overridden is snapshotted and restored in `finally`; the replacements are minimal Writable instances providing only what the CLI needs (`.write`); the working directory is changed with `process.chdir` (not a cwd shim) so filesystem operations follow; and logger binding is late — runCli re-binds so core-logger lines emitted INSIDE the run go through the swapped streams, because an argument-less logger init otherwise pins the console backend; format argument handling matches util.format semantics.
5. Config id resolution follows delegate slot → preferredId → canonical → legacy through the generic helper so all config loaders stay in sync; legacy shim installs pass their own preferredId so they target their own config block instead of falling through to the canonical entry.
6. `--session` is forwarded to the remote daemon, otherwise self-diagnosis would resolve against the wrong session's history.
7. Core declarations build with tsc rather than the single-pass declaration plugin, which could not handle the repo's declaration graph. (merged build-tooling neighbour)

## Consequences
Optional features fail with actionable install hints; genuinely broken optional packages surface their real errors. One CLI invocation at a time per process, and the global-swap snapshot/restore must stay complete or state leaks across invocations. Config readers must go through the shared helper or id generations drift apart.

## Origin comments
- `packages/remnic-cli/src/oauth.test.ts:523` — "// placeholder; the real env token must not be shadowed by it."
- `packages/remnic-cli/src/oauth.test.ts:557` — "// The daemon merges REMNIC_HOST/REMNIC_PORT over the file, so the CLI"
- `packages/remnic-cli/src/oauth.test.ts:558` — "// must target the same endpoint or it hits the wrong port."
- `packages/remnic-cli/src/optional-bench.ts:1` — "// Lazy loader for the optional @remnic/bench package."
- `packages/remnic-cli/src/optional-bench.ts:2` — "//"
- `packages/remnic-cli/src/optional-bench.ts:3` — "// Remnic's CLI is installed à la carte: users who only need memory features"
- `packages/remnic-cli/src/optional-bench.ts:4` — "// should not have to install benchmark tooling, so @remnic/bench is an"
- `packages/remnic-cli/src/optional-bench.ts:5` — "// optional peer dependency, not a bundled dependency. Any command that"
- `packages/remnic-cli/src/optional-bench.ts:6` — "// actually needs benchmark code calls loadBenchModule() lazily; the loader"
- `packages/remnic-cli/src/optional-bench.ts:7` — "// either returns the module or throws a user-facing install hint."
- `packages/remnic-cli/src/optional-bench.ts:9` — "// The specifier is computed so the bundler leaves the dynamic import as a"
- `packages/remnic-cli/src/optional-bench.ts:10` — "// runtime call (see also core/cli.ts:ensureBuiltInBulkImportAdapters for the"
- `packages/remnic-cli/src/optional-bench.ts:11` — "// same pattern). Mirrors CLAUDE.md invariant: "CLI and plugins MUST load"
- `packages/remnic-cli/src/optional-bench.ts:12` — "// optional workspace packages via computed-specifier dynamic imports.""
- `packages/remnic-cli/src/optional-bench.ts:113` — "// Only swallow "this package isn't installed" errors. Syntax"
- `packages/remnic-cli/src/optional-bench.ts:114` — "// errors, init throws, or ERR_MODULE_NOT_FOUND from a transitive"
- `packages/remnic-cli/src/optional-bench.ts:115` — "// miss inside @remnic/bench must all surface so broken releases"
- `packages/remnic-cli/src/optional-bench.ts:116` — "// are diagnosable instead of producing a misleading install hint."
- `packages/remnic-cli/src/optional-import-lossless-claw.ts:1` — "// Lazy loader for the optional @remnic/import-lossless-claw package."
- `packages/remnic-cli/src/optional-import-lossless-claw.ts:2` — "//"
- `packages/remnic-cli/src/optional-import-lossless-claw.ts:3` — "// CLAUDE.md à-la-carte invariant: optional packages MUST be loaded via"
- `packages/remnic-cli/src/optional-import-lossless-claw.ts:4` — "// computed-specifier dynamic imports so bundlers cannot statically resolve"
- `packages/remnic-cli/src/optional-import-lossless-claw.ts:5` — "// them. Mirrors optional-bench.ts / optional-weclone-export.ts."
- `packages/remnic-cli/src/optional-import-lossless-claw.ts:7` — "// Type-shape declared manually (not via `typeof import(...)`) so the CLI"
- `packages/remnic-cli/src/optional-import-lossless-claw.ts:8` — "// type-checks even when the optional package is not yet linked into"
- `packages/remnic-cli/src/optional-import-lossless-claw.ts:9` — "// node_modules — same pattern as optional-importer.ts."
- `packages/remnic-cli/src/optional-importer.test.ts:64` — "// Install hint must include the package name and an install"
- `packages/remnic-cli/src/optional-importer.test.ts:65` — "// command the user can actually run — not a raw MODULE_NOT_FOUND."
- `packages/remnic-cli/src/optional-importer.ts:1` — "// Lazy loader for optional @remnic/import-<source> packages (issue #568)."
- `packages/remnic-cli/src/optional-importer.ts:2` — "//"
- `packages/remnic-cli/src/optional-importer.ts:3` — "// Each supported source (chatgpt, claude, gemini, mem0, supermemory) ships as"
- `packages/remnic-cli/src/optional-importer.ts:4` — "// its own optional workspace package so the CLI stays à la carte — users who only"
- `packages/remnic-cli/src/optional-importer.ts:5` — "// need one importer should not have to install the others. Loading goes"
- `packages/remnic-cli/src/optional-importer.ts:6` — "// through this helper so the bundler cannot statically resolve the specifier"
- `packages/remnic-cli/src/optional-importer.ts:7` — "// (computed-string-concatenation import) and so every importer gets the same"
- `packages/remnic-cli/src/optional-importer.ts:8` — "// "install hint on miss, re-throw on every other error" treatment as the"
- `packages/remnic-cli/src/optional-importer.ts:9` — "// existing bench / weclone-export loaders."
- `packages/remnic-cli/src/optional-importer.ts:34` — "/** * The canonical list of importer sources slice-2+ will land. Slice-1 ships * the infrastructure only — so `remnic im"
- `packages/remnic-cli/src/optional-importer.ts:74` — "// Computed specifier so the bundler cannot statically resolve the"
- `packages/remnic-cli/src/optional-importer.ts:75` — "// dependency. CLAUDE.md rule 57: optional packages must not be present in"
- `packages/remnic-cli/src/optional-importer.ts:76` — "// the CLI's runtime `dependencies` or bundled `noExternal` list."
- `packages/remnic-cli/src/optional-importer.ts:80` — "// Some packages export the adapter under a name-prefixed export; we"
- `packages/remnic-cli/src/optional-importer.ts:81` — "// accept either the canonical `adapter` export or a `<name>Adapter`"
- `packages/remnic-cli/src/optional-importer.ts:82` — "// alias to keep the contract flexible for slice-authoring ergonomics."
- `packages/remnic-cli/src/optional-module-loader.ts:1` — "// Shared helpers for the CLI's optional-package dynamic-import loaders."
- `packages/remnic-cli/src/optional-module-loader.ts:2` — "//"
- `packages/remnic-cli/src/optional-module-loader.ts:3` — "// Every optional @remnic/* companion package uses the same "swallow only"
- `packages/remnic-cli/src/optional-module-loader.ts:4` — "// when this specific package is missing, otherwise re-throw" pattern, so"
- `packages/remnic-cli/src/optional-module-loader.ts:5` — "// extracting the check here removes the duplication between"
- `packages/remnic-cli/src/optional-module-loader.ts:6` — "// optional-bench.ts and optional-weclone-export.ts (Cursor review"
- `packages/remnic-cli/src/optional-module-loader.ts:7` — "// feedback on PR #545) and gives us one place to get the specifier-"
- `packages/remnic-cli/src/optional-module-loader.ts:8` — "// matching logic right."
- `packages/remnic-cli/src/optional-weclone-export.ts:1` — "// Lazy loader for the optional @remnic/export-weclone package."
- `packages/remnic-cli/src/optional-weclone-export.ts:2` — "//"
- `packages/remnic-cli/src/optional-weclone-export.ts:3` — "// See optional-bench.ts for the full rationale — the CLI is installed à la"
- `packages/remnic-cli/src/optional-weclone-export.ts:4` — "// carte, and weclone export tooling is only used by the `training:export`"
- `packages/remnic-cli/src/optional-weclone-export.ts:5` — "// surface. Users who don't use that surface should not need the adapter"
- `packages/remnic-cli/src/optional-weclone-export.ts:6` — "// installed."
- `packages/remnic-cli/src/optional-weclone-export.ts:20` — "// Only swallow the specific "this package isn't installed" case —"
- `packages/remnic-cli/src/optional-weclone-export.ts:21` — "// see optional-bench.ts for the same guard. A syntax or transitive-"
- `packages/remnic-cli/src/optional-weclone-export.ts:22` — "// dependency error inside the weclone package should bubble up."
- `packages/remnic-cli/src/remote-daemon.ts:399` — "// `--session` must reach the daemon: dropping it here would diagnose a"
- `packages/remnic-cli/src/run-cli.test.ts:227` — "// Regression for the #1613 review thread on logger pre-binding"
- `packages/remnic-cli/src/run-cli.test.ts:236` — "// initLogger() with no args pins _backend to CONSOLE_LOGGER. Under"
- `packages/remnic-cli/src/run-cli.test.ts:244` — "// Emit a core-logger line from INSIDE the run — runCli has"
- `packages/remnic-cli/src/run-cli.test.ts:265` — "// Regression for the #1613 review thread on concurrent invocation"
- `packages/remnic-cli/src/run-cli.test.ts:288` — "// Regression for the #1613 review thread on formatConsoleArgs"
- `packages/remnic-cli/src/run-cli.ts:133` — "/** * Module-level re-entry guard. runCli swaps process-wide globals * (`process.stdout` / `process.stderr` / `process.e"
- `packages/remnic-cli/src/run-cli.ts:197` — "// ── Snapshot everything we override so `finally` can restore it. ──"
- `packages/remnic-cli/src/run-cli.ts:222` — "// Build minimal Writable replacements. We need `.write()` for the CLI's"
- `packages/remnic-cli/src/run-cli.ts:274` — "// Use process.chdir (not process.cwd = () => ...) so that filesystem"
- `packages/remnic-cli/tsup.config.ts:3` — "// Keep optional @remnic packages external so the CLI remains à la carte."
- `packages/remnic-core/scripts/build-with-heap.mjs:4` — "// History: tsup emitted declarations through rollup-plugin-dts, which runs ONE"
- `packages/remnic-core/src/access-cli.ts:492` — "// Delegate slot → preferredId → canonical → legacy resolution to the"
- `packages/remnic-core/src/access-cli.ts:493` — "// generic helper so all config loaders stay in sync (#403). Shim CLI"
- `packages/remnic-core/src/access-cli.ts:494` — "// callers pass `preferredId: "openclaw-engram"` so legacy shim installs"
- `packages/remnic-core/src/access-cli.ts:495` — "// target their own config block instead of falling through to the canonical"
- `packages/remnic-core/src/access-cli.ts:496` — "// "openclaw-remnic" entry."
