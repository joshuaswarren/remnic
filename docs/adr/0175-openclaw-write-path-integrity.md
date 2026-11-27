# OpenClaw shared-context writes pass a single server-derived origin gate and re-read rotated files before overwrite

Status: accepted

## Context
OpenClaw and Remnic both touch shared-context files: tool-surface writes need trustworthy provenance, and OpenClaw can recreate or append to the flush-plan file while Remnic is cleaning up a rotated snapshot.

## Decision
OpenClaw shared-context tool registrations are exposed through a single write-side gate. Provenance is server-derived from the host runtime agent; a mismatching origin value supplied by the caller is rejected, never used as the origin. When overwriting the flush-plan file, re-read it at the last possible point so the overwrite merges fresh appends instead of writing from the stale earlier snapshot.

## Consequences
Clients cannot assert their own origin, and an extra read precedes every overwrite of the shared file.

## Origin comments
- `src/openclaw-flush-plan-lifecycle.ts:419` — "OpenClaw can recreate or append to this file while Remnic is cleaning up a"
- `src/openclaw-flush-plan-lifecycle.ts:420` — "rotated snapshot. Re-read at the last possible point so the overwrite merges"
- `src/openclaw-flush-plan-lifecycle.ts:421` — "fresh appends instead of writing from the stale snapshot above."
- `src/shared-context-tools.ts:1` — "OpenClaw shared-context tool registrations (issue #2920)... single write-side gate."
- `src/shared-context-tools.ts:36` — "Provenance is server-derived from the host runtime agent; a"
- `src/shared-context-tools.ts:37` — "mismatching value here is rejected, never used as the origin."
- `src/tool-write-origin.ts:1` — "Write origin for OpenClaw tool-surface shared-context writes (issue #1957...)"
