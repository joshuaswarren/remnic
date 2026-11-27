# Extension and skills materialization is atomic: stale tmp is swept first, replaces are rename-based with backup, and staged renames are per-file

Status: accepted

## Context
Extension installs and skills materialization replace live directories under the user's store. A crash mid-install can leave `.remnic.tmp-*` debris; concurrent installs could delete each other's in-flight tmp directory; and a failed directory rename could permanently destroy the old extension. Skills bundles may also contain invalid or duplicate slugs that would leave a second rename with no source.

## Decision
- Before creating a new tmp directory, sweep stale `.remnic-tmp-*` entries in the extensions root; per-entry sweep errors are swallowed so one bad entry does not abort the rest.
- Only provably stale tmp dirs (older than the staleness threshold) are removed — younger ones may belong to a concurrent install and deleting them would corrupt the other process's atomic rename.
- Replacement is atomic: rename the old directory to a timestamped backup, rename the tmp dir into place; if the second rename fails, restore from backup so the old extension is never permanently lost. The backup stays alive until the caller commits, allowing rollback if a later step (e.g. config write) fails.
- Skills materialization drops invalid or duplicate slugs up front so two bundles can never target one folder, then renames each staged SKILL.md per-file (never a directory rename) into place after removing retired folders.
- The materializer's managed sub-directories are contained: extraction writes stay inside the designated roots.

## Consequences
Crashed installs leave recoverable state rather than corruption, at the cost of keeping a backup directory alive until commit. Concurrent installs are safe only because of the staleness threshold — a threshold shorter than a legitimate install duration would still race. Per-file renames mean a mid-materialization failure can leave a partially updated skills tree; dedupe up front bounds the damage to rename-order issues only.


## Origin comments
- `packages/remnic-core/src/connectors/index.ts:3666` — "// Clean any stale tmp from a previous crashed run by scanning the"
- `packages/remnic-core/src/connectors/index.ts:3667` — "// extensions root for any `.remnic.tmp-*` prefixed entry. We must do this"
- `packages/remnic-core/src/connectors/index.ts:3668` — "// BEFORE creating the new tmp directory. Per-entry errors are swallowed so"
- `packages/remnic-core/src/connectors/index.ts:3669` — "// one bad entry doesn't abort cleanup of the rest."
- `packages/remnic-core/src/connectors/index.ts:3671` — "// Finding 2: only remove tmp dirs that are provably stale (older than"
- `packages/remnic-core/src/connectors/index.ts:3672` — "// STALE_TMP_THRESHOLD_MS). Dirs younger than the threshold belong to a"
- `packages/remnic-core/src/connectors/index.ts:3673` — "// concurrent install that is still in progress; deleting them would corrupt"
- `packages/remnic-core/src/connectors/index.ts:3674` — "// the other process's atomic rename."
- `packages/remnic-core/src/connectors/index.ts:3687` — "// Too recent — leave it alone; another install is likely still running."
- `packages/remnic-core/src/connectors/index.ts:3708` — "// Atomic replace: rename old remnic/ to a timestamped backup, then rename"
- `packages/remnic-core/src/connectors/index.ts:3709` — "// the tmp dir into place. If the second rename fails, restore from backup"
- `packages/remnic-core/src/connectors/index.ts:3710` — "// so the old extension is never permanently lost."
- `packages/remnic-core/src/connectors/index.ts:3729` — "// The new extension is in place. We intentionally keep the backup alive"
- `packages/remnic-core/src/connectors/index.ts:3730` — "// until the caller calls commit(). This gives the caller a chance to roll"
- `packages/remnic-core/src/connectors/index.ts:3731` — "// back to the prior state if a subsequent operation (e.g. config write) fails."
- `packages/remnic-core/src/connectors/materialize-paths.ts:1` — "/** * materialize-paths.ts — containment guard for the materializer's managed * sub-directories (`rollout_summaries/`"
- `packages/remnic-core/src/connectors/materialize-skills.ts:1` — "/** * materialize-skills.ts — the `skills/` section of the Codex materializer * (issue #2369). * * Extracted from cod"
- `packages/remnic-core/src/connectors/materialize-skills.ts:51` — "// Invalid or duplicate slugs are dropped so two bundles can never target"
- `packages/remnic-core/src/connectors/materialize-skills.ts:52` — "// one folder and leave the second rename with no source (§37)."
- `packages/remnic-core/src/connectors/materialize-skills.ts:92` — "/** * Remove retired folders, then rename each staged SKILL.md into place. Per-file * renames (never directory rename"
