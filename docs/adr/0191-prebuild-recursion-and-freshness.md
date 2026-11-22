# Prebuild dependency scripts are guarded against recursion and seed a freshness fingerprint

Status: accepted

## Context
Workspace packages (@remnic/bench, @remnic/bench-ui, @remnic/cli) depend on dist artifacts of @remnic/core and @remnic/coding-graph. In a fresh workspace the documented dev/check-types/build commands fail before doing any work, and naive prebuild wiring causes infinite recursion or concurrent dist corruption.

## Decision
Prebuild scripts ensure dependency dist builds before their own builds (bench ensures @remnic/coding-graph's dist before its tsup DTS generation, mirroring the @remnic/core call; bench-ui prepares @remnic/bench the same way @remnic/cli does, and bench's prebuild first ensures core and coding-graph), each guarded against recursion (coding-graph's own prebuild calls the same ensure script, so without the guard building coding-graph would trigger itself infinitely). Builds must seed the freshness marker the recursive wave's prebuilds check: a plain `pnpm --filter @remnic/core build` writes dist without the fingerprint sidecar, so the first prebuild inside `pnpm -r` treats core as stale, rebuilds it (cleaning dist), and a sibling package's concurrent tsup DTS worker reads the half-cleaned dist and fails with TS2307/TS7016.

## Consequences
Release builds must go through the seeding path; the fingerprint contract couples the ensure scripts to each other.

## Origin comments
- `scripts/ensure-bench-build-deps.mjs:19` — "#1557: bench now depends on @remnic/coding-graph for the coding-graph"
- `scripts/ensure-bench-build-deps.mjs:20` — "benchmark harness. Ensure its dist is built before bench's tsup DTS"
- `scripts/ensure-bench-build-deps.mjs:21` — "generation runs, mirroring the @remnic/core call above."
- `scripts/ensure-bench-build-deps.mjs:23` — "Guard against recursion: @remnic/coding-graph's own prebuild script calls"
- `scripts/ensure-bench-build-deps.mjs:24` — "this file. Without the guard, building coding-graph would trigger building"
- `scripts/ensure-bench-build-deps.mjs:25` — "coding-graph again (infinite loop)."
- `scripts/ensure-bench-ui-build-deps.mjs:7` — "@remnic/bench-ui resolves @remnic/bench through the dependency's dist"
- `scripts/ensure-bench-ui-build-deps.mjs:8` — "types/import exports; only its test script opts into the remnic-source"
- `scripts/ensure-bench-ui-build-deps.mjs:9` — "condition. In a fresh workspace with no packages/bench/dist, the"
- `scripts/ensure-bench-ui-build-deps.mjs:10` — "documented dev/check-types/build commands fail before doing any work,"
- `scripts/ensure-bench-ui-build-deps.mjs:11` — "so prepare the dependency build the same way @remnic/cli does via"
- `scripts/ensure-bench-ui-build-deps.mjs:12` — "ensure-cli-bench-build-deps.mjs. Building @remnic/bench runs its own"
- `scripts/ensure-bench-ui-build-deps.mjs:13` — "prebuild, which first ensures @remnic/core and @remnic/coding-graph."
- `scripts/ensure-core-build.mjs:8` — "Release builds must seed the same freshness marker the recursive wave's"
- `scripts/ensure-core-build.mjs:9` — "prebuilds check (scripts/ensure-bench-build-deps.mjs). A plain"
- `scripts/ensure-core-build.mjs:10` — "`pnpm --filter @remnic/core build` writes dist without the fingerprint"
- `scripts/ensure-core-build.mjs:11` — "sidecar, so the first prebuild inside `pnpm -r` treats core as stale,"
- `scripts/ensure-core-build.mjs:12` — "rebuilds it (cleaning dist), and a sibling package's concurrent tsup DTS"
- `scripts/ensure-core-build.mjs:13` — "worker reads the half-cleaned dist and fails with TS2307/TS7016"
- `scripts/ensure-core-build.mjs:14` — "(\"Cannot find module '@remnic/core'\")."
