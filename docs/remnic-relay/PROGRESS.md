# Remnic Relay progress

Last updated: 2026-07-17

## Overall

- [x] Epic and scoped child issues created (#1965–#1969).
- [x] Persistent completion goal created with the winning-worthiness gate.
- [x] Dedicated Relay worktree created from current `origin/main`.
- [x] Phase 1: mission contract and receipt API (#1966, merged via #1970).
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
- [x] PR loop reported current-head `MERGE_READY`.
- [x] PR manually merged and `origin/main` verified at `98e83cc1`.

## Phase 2 checklist

- [x] Dedicated editorial Mission Control design contract.
- [x] Reducer-generated, integrity-checked 12-frame replay.
- [x] Three data-derived agent cards and belief lineage transformation.
- [x] Confirm-gated replay and authenticated, idempotent live approval flow.
- [x] Provenance X-ray with historical versus fresh-inspection labels.
- [x] Loading, empty, partial, conflict, offline, replay, and recovered states.
- [x] Exact Remnic/Engram static route allow-list and release artifact checks.
- [x] Desktop and narrow screenshots plus keyboard/reduced-motion browser audit.
- [x] Focused reducer/model and HTTP surface tests.
- [x] Repository preflight and local adversarial review.
- [ ] PR loop reports current-head `MERGE_READY`.
- [ ] PR manually merged and `origin/main` verified.

## Evidence discipline

All Relay demo inputs and outputs must live under freshly provisioned synthetic
roots. No production Remnic memory, shared context, or Codex home may be read or
written. A visible receipt may claim only what a fixture event, captured model
output, source file, memory record, recall audit, or executed test proves.
