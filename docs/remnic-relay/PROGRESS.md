# Remnic Relay progress

Last updated: 2026-07-17

## Overall

- [x] Epic and scoped child issues created (#1965–#1969).
- [x] Persistent completion goal created with the winning-worthiness gate.
- [x] Dedicated Relay worktree created from current `origin/main`.
- [ ] Phase 1: mission contract and receipt API (#1966).
- [ ] Phase 2: Mission Control UI (#1967).
- [ ] Phase 3: isolated Codex runner and replay (#1968).
- [ ] Phase 4: hardening, evidence, and submission package (#1969).

## Phase 1 checklist

- [x] Versioned strict event and snapshot schemas.
- [x] Symlink-safe, serialized, idempotent append-only mission store.
- [x] Deterministic bounded reducer with explicit evidence completeness.
- [x] Namespace-authorized access operations and HTTP routes.
- [x] Deterministic synthetic fixture and failure-path tests.
- [x] Focused checks and repository preflight.
- [ ] PR loop reports current-head `MERGE_READY`.
- [ ] PR manually merged and `origin/main` verified.

## Evidence discipline

All Relay demo inputs and outputs must live under freshly provisioned synthetic
roots. No production Remnic memory, shared context, or Codex home may be read or
written. A visible receipt may claim only what a fixture event, captured model
output, source file, memory record, recall audit, or executed test proves.
