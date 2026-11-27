# Import pipelines refuse unsafe bundle inputs and fail loudly with real exit codes

Status: accepted

## Context
Takeout bundles come from untrusted filesystems: symlinks can point anywhere, export formats are ambiguous, and automation consumes exit codes. A quietly-skipped privacy-relevant path, or a partial walk reported as success, silently loses data.

## Decision
- Symlinks are never treated as directories or as regular files: the walker refuses to follow them, a bundle root that is itself a symlink is rejected, and a symlink named like a known store file is not followed. Walk depth accommodates nested takeout bundles several levels deep. Top-level readability is validated with a descriptive error; per-entry errors inside a walk do not abort it, and the failure count is reflected in the exit code so automation sees the partial failure.
- ChatGPT and Claude exports are disambiguated by inspecting the first element of the conversations file. Bundle routing happens in detection order before per-adapter handling, and bundle mode rejects combination with per-adapter flags loudly. A per-file include hint (conversations files) wins over defaults.
- Value flags claim their values before boolean flags are consumed, so a boolean cannot eat a following value token; a bundle flag without its value raises its specific error message.
- Dry-run never boots the orchestrator, never resolves or mutates a destination from configuration, and writes nothing. Write-target disposal runs only when target construction actually started, tracked by memoization.
- The lossless-claw parser stays side-effect-free and dependency-free; file paths are rejected as directory arguments while not-yet-existing directories are permitted; tilde is expanded at parse time; dry-run does not mutate destination storage. LCM migration is a separate command from the generic import path, because its data model (turns plus a summary DAG) and its destination store differ structurally from fact-based memory.
- Import command tests reset process exit state between cases so one case's failure cannot leak into the next.

## Consequences
Symlinked stores are not importable in place — copy a real tree first. Partial bundle failures exit non-zero even though the walk continued and most files imported.

## Origin comments
- `packages/remnic-cli/src/import-bundle-detect.test.ts:41` — "// Codex review on PR #610 — symlinks never report as directories OR // as regular files, so the walker refuses to fol"
- `packages/remnic-cli/src/import-bundle-detect.test.ts:180` — "// Codex review on PR #610 — a bundle containing a symlink named // memory.json / projects.json must NOT be followed, "
- `packages/remnic-cli/src/import-bundle-detect.ts:72` — "// Codex review on PR #610 — when callers inject readdir/isDirectory"
- `packages/remnic-cli/src/import-bundle-detect.ts:87` — "// Codex review on PR #610 — reject a bundle root that is itself a"
- `packages/remnic-cli/src/import-bundle-detect.ts:143` — "// Takeout bundles nest ≥3 levels (Takeout/Gemini/…)"
- `packages/remnic-cli/src/import-bundle-detect.ts:151` — "// Validate top-level readability with a descriptive error; inner"
- `packages/remnic-cli/src/import-bundle-detect.ts:178` — "// Codex review on PR #610 — reject symlink files as well as"
- `packages/remnic-cli/src/import-bundle-detect.ts:210` — "// ChatGPT vs Claude disambiguation: peek at the first element. ChatGPT"
- `packages/remnic-cli/src/import-bundle-detect.ts:255` — "// Use lstatSync so symlinks never report as directories — we refuse"
- `packages/remnic-cli/src/import-bundle-detect.ts:269` — "// Use lstatSync so symlinks never report as regular files. Codex"
- `packages/remnic-cli/src/import-dispatch.test.ts:414` — "// `cmdImport` sets process.exitCode when the adapter load fails (install"
- `packages/remnic-cli/src/import-dispatch.test.ts:657` — "// Failure count must reflect the one that threw — this is what"
- `packages/remnic-cli/src/import-dispatch.ts:284` — "// Dry-run must never boot the orchestrator — callers of"
- `packages/remnic-cli/src/import-dispatch.ts:349` — "// Bundle mode cannot combine with per-adapter flags — reject them loudly"
- `packages/remnic-cli/src/import-dispatch.ts:445` — "// The per-file hint wins (e.g. conversations.json → true) but the"
- `packages/remnic-cli/src/import-dispatch.ts:504` — "// Slice 7: `--all-from-bundle <dir>` routes to the bundle pipeline"
- `packages/remnic-cli/src/import-dispatch.ts:531` — "// Track whether `getWriteTarget` was actually called so dispose runs after"
- `packages/remnic-cli/src/import-dispatch.ts:568` — "// Signal partial failure to automation. The walk kept going on"
- `packages/remnic-cli/src/import-dispatch.ts:589` — "// Only dispose when write target construction actually started. Checking"
- `packages/remnic-cli/src/import-lossless-claw-args.ts:4` — "// Kept side-effect-free and dependency-free (no @remnic/core import) so the"
- `packages/remnic-cli/src/import-lossless-claw-cmd.ts:100` — "// Dry-run must not mutate destination storage (Codex P2). The dest"
- `packages/remnic-cli/src/index.ts:13184` — "// SQLite→SQLite migration of a lossless-claw LCM database into"
- `packages/remnic-cli/src/index.ts:13185` — "// Remnic's LCM mode. Distinct from `remnic import` because the data"
- `packages/remnic-cli/src/index.ts:13186` — "// model is structurally different (turns + summary DAG, not facts)"
- `packages/remnic-cli/src/index.ts:13187` — "// and the destination is the LCM SQLite store, not the orchestrator."
