# H6 Failure Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and run the controlled H6 experiment comparing failure-memory timing and matched failure-versus-success content for coding agents.

**Architecture:** Extend the canonical causal-trajectory store with typed coding/action identity and its own revision, then add a host-neutral deterministic gate. Build a generated offline TypeScript trap suite and a resumable multi-arm benchmark around the gate. Keep production host activation separate because current Claude Code, Codex, OpenClaw, Pi, and Hermes hooks cannot provide advisory-before-action model replanning without blocking the pending action.

**Tech Stack:** TypeScript, Node.js 22.13+, node:test, Git, OpenAI Responses API for the controlled coding-agent loop, Remnic core/bench/CLI packages.

---

## Delivery slices

1. **Core contract PR:** typed trajectory identity, atomic trajectory revision, deterministic gate, config, exports.
2. **Benchmark PR:** generated fixture suite, row store, driver, grouped stats, CLI, preregistration, deterministic and baseline receipts.
3. **Host adapter PR:** only after an upstream host exposes non-blocking model replanning. Do not substitute post-action context or hard blocking.

### Task 1: Typed causal-trajectory identity and revision

**Files:**
- Modify: `packages/remnic-core/src/causal-trajectory.ts`
- Modify: `tests/causal-trajectory.test.ts`

**Steps:**
1. Add failing tests for legacy-record acceptance; typed `projectId`, branch, fingerprint version/value, strategy ID, and action summary round-trip; unreadable-store distinction; atomic publication; and revision bump only after committed writes.
2. Run `NODE_OPTIONS="--conditions=remnic-source" pnpm exec tsx --test tests/causal-trajectory.test.ts` and confirm the new tests fail.
3. Add optional typed coding/action fields to the canonical record validator. Legacy records stay readable but cannot match the gate.
4. Replace direct publication with temp-write then rename. Add a causal-only revision sentinel/API; do not bump the memory corpus version.
5. Return a strict read result or expose a strict loader so empty and failed reads remain distinct.
6. Re-run the focused test to zero failures and commit the core storage slice.

### Task 2: Versioned deterministic pre-action gate

**Files:**
- Create: `packages/remnic-core/src/coding/pre-action-gate.ts`
- Create: `packages/remnic-core/src/coding/pre-action-gate.test.ts`
- Modify: `packages/remnic-core/src/index.ts`
- Modify: `packages/remnic-core/package.json`

**Steps:**
1. Write failing tests for command/edit normalization, known typed slots, repo-relative slash normalization, closed strategy IDs, project isolation, failure-only filtering, version miss, fixed advisory text, deadline, thrown read, cache dimensions, revision invalidation, revision change during scan, late-result suppression, bounded eviction, and secret/path exclusion.
2. Run the new test and confirm RED.
3. Define `PRE_ACTION_FINGERPRINT_VERSION`, `PRE_ACTION_WARNING_VERSION`, typed command/edit intents, closed strategies, normalized fingerprint payload, and `NO_MATCH | MATCH_WARN | ERROR_FAIL_OPEN` results.
4. Implement `PreActionFailureGate` with injected strict loader/revision reader/clock for tests. Exact project match precedes action comparison. Branch and session scope the cache, not historical matching. The gate never blocks or predicts failure.
5. Hash only normalized, bounded fields. Keep absolute root paths transient.
6. Export the API through the root barrel and package subpath, run focused tests, typecheck/build core, and commit.

### Task 3: Default-off configuration contract

**Files:**
- Modify: `packages/remnic-core/src/types.ts`
- Modify: `packages/remnic-core/src/coding/coding-knowledge-config.ts`
- Modify: `packages/remnic-core/src/config.test.ts`
- Modify: `packages/plugin-openclaw/openclaw.plugin.json`
- Regenerate: `openclaw.plugin.json`
- Regenerate: `packages/shim-openclaw-engram/openclaw.plugin.json`
- Modify: `docs/config-reference.md`
- Regenerate: `scripts/config-contract/parsed-keys.snapshot.json`

**Steps:**
1. Add failing default, explicit true, string-false, invalid-value, manifest, and docs parity tests for `codingKnowledge.preActionGate`.
2. Add `preActionGate: false` to `CodingKnowledgeConfig`, its delegated strict parser, and all three manifests. Effective activation requires both `codingKnowledge.enabled` and the child flag plus attached coding context; it remains independent of turn-start causal recall.
3. Sync manifests and parsed-key snapshot through existing scripts; add no grandfather exception.
4. Run config tests and `pnpm run check-config-contract`; commit.

### Task 4: Trap taxonomy, schemas, and deterministic repo generator

**Files:**
- Create: `packages/bench/src/coding-graph/repo-gen/{types,index,templates,validate}.ts`
- Create: `packages/bench/src/coding-graph/repo-gen/repo-gen.test.ts`
- Create: `packages/bench/fixtures/h6-failure-gate/trap-taxonomy.json`
- Create: `packages/bench/fixtures/h6-failure-gate/schema/*.json`
- Create: `packages/bench/fixtures/h6-failure-gate/decision-rule.json`
- Create: `packages/bench/fixtures/h6-failure-gate/generator/regenerate.ts`
- Modify: `packages/bench/src/coding-graph/index.ts`
- Modify: `packages/bench/src/index.ts`
- Modify: `packages/bench/package.json`
- Modify: `scripts/check-dataset-hygiene.mjs`

**Steps:**
1. Write failing determinism, taxonomy, state, variation, fresh-materialization, similarity, counterfactual-import, network-ban, split, and containment tests.
2. Define the six required trap types first: flaky-looking-test, misleading-error-message, wrong-layer-fix, hidden-invariant, stale-cache-illusion, config-shadowing.
3. Implement generated TypeScript source repos with 8-15 files, invented domains from drift-gen pools, vendored fictional APIs, offline tests, fixed Git metadata, clean/trap/correct/no-trap revisions, and three cosmetic distances.
4. Store committed sources/patches and revision metadata, never nested `.git` directories. Materialize every check in a fresh temp repo.
5. Generate 30 base tasks at seed 81, at least five per trap type, plus 90 variants and no-trap controls. Freeze dev/pilot/main IDs.
6. Prove UNFIXED, TRAPPED, FIXED, and no-trap states; reject any semantic drift. Enforce pairwise file similarity ≤40%, pure-local tests, and reserved fictional imports.
7. Add the fixture tree to package publication and dataset hygiene roots. Run generator tests, `verify-all` for 120/120, and hygiene; commit generated source and manifests in the same generator-version commit.

### Task 5: Durable repeated-failure protocol and arm isolation

**Files:**
- Create: `packages/bench/src/coding-graph/repeated-failure-suite.ts`
- Create: `packages/bench/src/coding-graph/repeated-failure-store.ts`
- Create: `packages/bench/src/coding-graph/repeated-failure-suite.test.ts`
- Create: `packages/bench/src/coding-graph/repeated-failure-store.test.ts`
- Create: `packages/bench/fixtures/h6-failure-gate/arms/*.json`

**Steps:**
1. Write failing tests for frozen arm names, stable row keys, matched fact-pair cuts, immutable episode-1 history, distinct repo/memory/scope/codegraph/chat/session/cache identities, start hashes, resume, retries, invalidation, trace completeness, and deterministic JSONL compilation.
2. Define only `NO_MEMORY`, `TURN_START_FAILURE`, `TURN_START_SUCCESS`, `PRE_ACTION_FAILURE`, and `BOTH`. Timing arms receive the same fact/citation/token budget; content arms receive validated target/twin pairs.
3. Define an injected tool-active `RepeatedFailureAgentDriver`; do not reuse tool-free completion providers.
4. Persist each try atomically under a stable key over suite/task/variant/model/seed/arm. Retry only host/API faults, at most twice. A real task result is terminal.
5. Mark start drift, trace gaps, vague checks, mixed state, unmatched facts, and wait faults `INVALID` before statistics.
6. Compile sorted `episodes.jsonl` and a standard `BenchmarkResult` summary. Extend the existing repro manifest with supplemental artifact inventory rather than a second hashing framework.
7. Run focused tests and commit.

### Task 6: Grouped statistics and hypothesis decisions

**Files:**
- Create: `packages/bench/src/coding-graph/repeated-failure-stats.ts`
- Create: `packages/bench/src/coding-graph/repeated-failure-stats.test.ts`

**Steps:**
1. Write failing tests proving task-group resampling, task-group label swaps, deterministic 10,000 draws, Holm monotonicity, zero-risk handling, completeness cuts, RRR intervals, paired task-pass analysis, and ±2-point timidity equivalence logic.
2. Implement task-level aggregation, grouped paired bootstrap, grouped paired shuffle, Holm adjustment across exactly two primaries, effect estimates, and fixed decision rules.
3. Keep mixed logistic output descriptive only; do not add it as a support rule.
4. Run focused tests and commit.

### Task 7: First-class CLI and controlled agent loop

**Files:**
- Modify: `packages/remnic-cli/src/bench-args.ts`
- Modify: `packages/remnic-cli/src/bench-flags.ts`
- Modify: `packages/remnic-cli/src/bench-args-research.ts`
- Modify: `packages/remnic-cli/src/bench-research-commands.ts`
- Modify: `packages/remnic-cli/src/bench-usage.ts`
- Modify: `packages/remnic-cli/src/index.ts`
- Modify: `packages/remnic-cli/src/bench-args.test.ts`
- Modify: `packages/remnic-cli/src/cli-command-surface.test.ts`
- Modify: `tests/remnic-cli-bench-surface.test.ts`
- Modify: `packages/remnic-cli/README.md`
- Modify: `packages/bench/src/coding-graph/repeated-failure-suite.ts`

**Steps:**
1. Add failing parser and surface tests for `bench coding repo-gen`, `repo-gen verify-all`, `repeated-failure`, resume, stats, strict subcommands, `--seeds`, invalid values, help, and optional-package dispatch.
2. Make `coding` a first-class `BenchAction`; keep its strict flags in the central allow-list and its execution behind `loadBenchModule()`.
3. Implement the controlled Responses-API agent driver with explicit local tools and a warning/replan turn before matched execution. The benchmark contract must record whether the model resubmits, changes, or abandons the pending act; never describe this as a shipped host hook.
4. Add stats replay from frozen JSONL with zero model calls and byte-stable output.
5. Run CLI tests, package typechecks/builds, and commit.

### Task 8: Preregistration and deterministic pre-run gates

**Files:**
- Create: `docs/research/failure-gate/preregistration.md`
- Create: `docs/research/failure-gate/report.md`
- Create: `docs/research/data/pre-action-gate/` run artifacts after sanitization

**Steps:**
1. Freeze task splits, models/profiles, seeds, arm order, match thresholds, warning, time/token/step caps, cuts, retry policy, grouped analysis, support rules, and no-trap equivalence plan before real measured runs.
2. Record the host-capability limitation precisely: no production adapter currently supports advisory-before-action replanning.
3. Run the fake-agent smoke twice and require byte-identical row order, classifications, and hashes.
4. Run all offline repo checks, matched fact-pair audits, scope/hash isolation checks, and no-memory trap checks for each fixed model.
5. Run pilot only on frozen pilot IDs. Use its base rate and intratask correlation for power; add independent tasks if needed rather than extra seeds.
6. Commit the preregistration and deterministic receipts before the main run.

### Task 9: Main experiment, report, and verification

**Files:**
- Update: `docs/research/failure-gate/report.md`
- Add: `docs/research/data/pre-action-gate/*` sanitized manifests, JSONL, tables, and plot data

**Steps:**
1. Run 30 main tasks × variants × 5 seeds × 2 models × 5 arms with frozen contracts, or the larger task count required by pilot power.
2. Replay statistics from JSONL, produce timing/content effects, task-pass effects, warning precision/recall, false warnings, timidity, costs, distance curves, model/trap groups, faults, cuts, and null/bad results.
3. Generate every report table/plot from committed data with no hand edits. Scope claims to fixed pre-act notes on synthetic local coding tasks.
4. Run focused core/bench/CLI tests, `npm run test:entity-hardening` if triggered, `npm run preflight:quick`, package builds, and a clean-clone full reproduction.
5. Run an adversarial full-diff review, fix all valid findings, open subsystem PRs, loop each until current-head checks/reviews/threads are clean, merge normally, and post issue receipts. Keep #1963 open if the upstream host primitive is still absent; close only when every acceptance item, including production host wiring, is real.
