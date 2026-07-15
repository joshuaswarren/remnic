# QMD 2.0 Integration Decision

> Decision record (historical) — 2026-03-11. Describes the QMD adapter architecture still in use today.

Issue: `#231`  
Date: 2026-03-11

## Decision

Remnic will stay on the current QMD adapter architecture for now:

- shared stdio MCP session as the warm primary path
- CLI subprocess fallback for fail-open recovery
- backend abstraction preserved so QMD is not the only long-term search option

Remnic will adopt the low-risk QMD 2.0 / late 1.1.x improvements that fit that architecture:

- pass inferred recall intent into unified `query` when explicitly enabled
- request QMD explain traces when explicitly enabled
- persist a bounded `last_qmd_recall.json` snapshot plus a `memory_qmd_debug` operator tool

Remnic will not migrate to the QMD SDK in this issue.

## Comparison

### SDK / library mode

Pros:

- Direct access to `createStore`, unified `search()`, `getDocumentBody()`, and collection helpers
- Cleaner typed boundary than shelling out
- Easier long-term removal of custom glue if Remnic ever becomes QMD-only

Cons:

- Changes Remnic's runtime contract substantially
- Increases coupling to QMD's in-process SQLite, model, and Node/runtime assumptions
- Raises rollback risk for namespace-scoped routing, fail-open behavior, and multi-instance operator workflows
- Requires a larger mocking/test harness shift than this issue needs

Decision: defer.

### MCP mode

Pros:

- Keeps models warm and is already integrated
- Preserves process isolation around QMD internals
- Gives a stable tool boundary without forcing Remnic into QMD's SDK lifecycle

Cons:

- Still needs adapter code for result normalization and recovery
- Not every QMD capability is automatically surfaced unless Remnic plumbs it through

Decision: keep as warm primary path.

### CLI subprocess mode

Pros:

- Strong fail-open and portability characteristics
- Simple rollback path
- Easy to probe and reason about operationally

Cons:

- Highest startup and repeated-call cost
- More shell glue than ideal

Decision: keep as compatibility fallback.

### Hybrid MCP + CLI

Pros:

- Preserves Remnic's current reliability model
- Lets Remnic adopt QMD 2.0 query features without a full architecture rewrite
- Lowest migration risk for current roadmap needs

Cons:

- Some custom adapter code remains
- Does not reduce glue as aggressively as a full SDK migration

Decision: selected architecture.

## Criteria Summary

| Criterion | SDK | MCP | CLI | Selected hybrid |
| --- | --- | --- | --- | --- |
| Retrieval quality | High | High | High | High |
| Warm-path latency | Medium | Best | Worst | Best available |
| Failure recovery | Medium | Good | Best | Best overall |
| Portability | Medium | Good | Best | Good |
| Testing/mocking | Medium | Good | Good | Good |
| Rollback safety | Low | High | High | High |
| Operator debuggability | Medium | High | High | High |

## Feature Review

### Stable SDK / `createStore`

Useful, but not enough to justify the migration cost yet. Defer.

### Unified `search()`

Adopt indirectly. Remnic now forwards intent only through unified `query` and avoids its own hybrid top-up when that intent hint is active, so QMD's own query expansion/rerank path stays authoritative.

### `intent`

Adopt behind `qmdIntentHintsEnabled`.

### `explain`

Adopt behind `qmdExplainEnabled`, but only into operator/debug snapshots, not user prompt injection.

### `getDocumentBody()`

Reviewed, but deferred. Current recall still uses bounded snippets because that keeps token behavior predictable and avoids a larger provenance/injection refactor in this issue.

### Collection/default collection helpers

Reviewed, but no change in this issue. Remnic's namespace-derived collection naming stays in place.

### MCP server boundary changes

Accepted implicitly by continuing the shared stdio MCP path. No transport rewrite.

### Runtime/bin wrapper compatibility

Accepted via the existing CLI probe and fallback path. No new dependency surface added.

## Rollout and Rollback

### Added flags

- `qmdIntentHintsEnabled`
- `qmdExplainEnabled`

Both default to `false`.

### Rollback

Disable the flags. Remnic reverts to the previous behavior:

- no QMD-native intent hinting
- no QMD explain capture
- normal hybrid top-up behavior

No data migration is required. `state/last_qmd_recall.json` is debug-only and disposable.

## Why not remove more glue now?

Because this issue is about revisiting QMD 2.0 from first principles, not forcing a rewrite. The selected changes improve retrieval quality and observability now, while preserving Remnic's broader backend abstraction and low-risk fallback model.
