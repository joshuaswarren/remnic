# Extracted config keys are snapshotted with line-independent identities and written atomically

Status: accepted

## Context
The parser-walking key extractor derives the authoritative set of accepted config keys, and its snapshot is diffed in CI. File:line identities break on any unrelated edit above a construct, and redirecting stdout onto the snapshot can empty it when an extract fails.

## Decision
Constructs are identified by construct text + reason (`<relFile>#<hash(scope + reason + normalized...))` — never file:line — so an unrelated edit above a construct does not create churn, and unparseable constructs are recorded loudly with that stable, line-independent id. The snapshot is replaced atomically via `--write` (`npx tsx scripts/config-contract/extract-parsed-keys.ts --write`); never redirect stdout onto the snapshot, because a failed extract would empty the file.

## Consequences
Snapshot diffs reflect real semantic changes only; the write path must go through the CLI's atomic replace.

## Origin comments
- `scripts/config-contract/extract-parsed-keys.ts:1` — "check-config-contract v2 — parser-walking key extractor (issue #1990 PR1)... Derives the AUTHORITATIVE set of ac..."
- `scripts/config-contract/extract-parsed-keys.ts:41` — "Stable identity keyed by construct text + reason, NOT file:line — so an unrelated edit above the construct does..."
- `scripts/config-contract/extract-parsed-keys.ts:162` — "Record a loud unparseable construct with a stable, line-independent id (`<relFile>#<hash(scope + reason + normal..."
- `scripts/config-contract/extract-parsed-keys.ts:1184` — "CLI: print JSON, or `npx tsx scripts/config-contract/extract-parsed-keys.ts --write`"
- `scripts/config-contract/extract-parsed-keys.ts:1185` — "to replace the snapshot atomically. Never redirect stdout onto the snapshot —"
- `scripts/config-contract/extract-parsed-keys.ts:1186` — "a failed extract would empty the file (this run, 8d64a716a)."
