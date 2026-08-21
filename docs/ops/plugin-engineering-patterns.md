# Engram Plugin Engineering Patterns

These patterns are generalized from PR #11 review churn and apply to all future retrieval/intent/cache work in this plugin.

## 1) Contract-First Behavior

Treat runtime behavior as API contract, not implementation detail:

- config flags are contracts (`enabled=false` disables full effect)
- numeric limits are contracts (`0` means disabled, not "minimum 1")
- mode labels are contracts (`no_recall`, `minimal`, `full`, `graph_mode`)

## 2) Deterministic Recall Pipeline

Keep recall assembly in this strict order:

1. Retrieve candidate headroom
2. Apply policy filters (namespace/status/path/type)
3. Apply boosts/reranking
4. Cap to final budget
5. Format and inject

Never cap before the final filter stage.

## 3) Policy Parity Across Paths

Primary retrieval and fallback retrieval must enforce the same policy constraints.
If you add a filter/rule to one path, mirror it in every fallback path.

## 4) Isolation of Data Planes

Avoid category bleed:

- artifact documents should not appear in generic memory recall
- dedicated sections (e.g., verbatim artifacts) should have dedicated filters and validation rules

## 5) Cache Design for Real Runtime

Caches must assume:

- concurrent reads/writes
- multi-instance access to same memory directory
- stale/missing references

Required patterns:

- shared per-dir versioning for invalidation where cross-instance writes occur
- rebuild timestamps set on completion, not start
- guard against torn rebuild snapshots
- negative-result caching when repeated misses are expected

## 6) Heuristic Classifier Discipline

Regex/heuristic classification should be treated as production logic:

- include common morphology/variants ("decided", "decision", "chose", "chosen")
- avoid malformed stems/pattern typos
- add explicit precedence tests for overlapping intents

## 7) Reachability + Safety Tests

For any planner/route change, tests must prove:

- each mode/path is reachable
- each mode/path enforces its constraints
- disabled modes do not leak through fallbacks

## 8) Batch-by-Subsystem Review Fixing

When review comments target one subsystem, fix all related edges in one patch:

- identify affected invariants
- patch all coupled branches
- run full verification once
- push once

This reduces serial review churn and second-order regressions.
