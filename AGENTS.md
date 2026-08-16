# Remnic - Agent Guide

> **PUBLIC, OPEN-SOURCE REPOSITORY.** Remnic is a public open-source project.
> Everything pushed to GitHub — commits, issues, PRs, review comments — is
> world-readable. Never include PII or operator-specific infrastructure details
> (hostnames, internal IPs, usernames/home paths, client or project names,
> memory IDs or memory content, links to private repos/docs). Write issues and
> PRs for the general case: describe the reproducing deployment *shape* and
> design fixes that benefit all users, not one operator's setup. Full rules:
> "PUBLIC REPOSITORY — Privacy Policy" below.

## Architecture Boundaries (Non-Negotiable)

Remnic is a multi-platform memory system. Keep these boundaries intact on every change:

1. `@remnic/core`, `@remnic/server`, and `@remnic/cli` own Remnic's core behavior.
   Core memory semantics, storage, retrieval, extraction, governance, and standalone operation must live there.
2. Core and standalone paths must not depend on OpenClaw, Hermes, or any future host.
   Host integrations may consume core. Core must not reach back into host SDKs, config shapes, or runtime lifecycles.
3. Platform-specific behavior belongs in platform adapters only.
   OpenClaw-specific code belongs in `packages/plugin-openclaw` plus the current root `src/` compatibility wiring that still hosts OpenClaw runtime entrypoints today. Hermes-specific code belongs in `packages/plugin-hermes`. Keep host logic thin and translation-focused.
4. Do not reinvent host-native features.
   If OpenClaw, Hermes, or another platform already provides a runtime capability, plugin hook, command surface, or extension primitive, use that real upstream contract instead of recreating a parallel Remnic abstraction.
5. Verify host behavior against current upstream source and docs before implementing it.
   Issue text, old local docs, or remembered APIs are not enough for host-facing work.
6. Desktop-capture subsystems obey the same split: `packages/remnic-core/src/activity/` and `packages/remnic-core/src/meetings/` are host-agnostic **core subsystems**, while the capture packages (`@remnic/capture-audio`, `@remnic/capture-screen`) and the meeting/wearable connectors (`@remnic/connector-*`) are optional **adapters** that consume core and never the reverse (umbrella #1896).

## Upstream References

Use these as the canonical starting points for adapter work:

- OpenClaw repository: <https://github.com/openclaw/openclaw>
- OpenClaw plugin docs: <https://github.com/openclaw/openclaw/tree/main/docs/plugins>
- OpenClaw SDK overview: <https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-overview.md>
- OpenClaw SDK entrypoints: <https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-entrypoints.md>
- Hermes Agent repository: <https://github.com/NousResearch/hermes-agent>
- Hermes Agent docs/site: <https://hermes-agent.nousresearch.com>

## Adapter Implementation Rules

- Start from the host's current upstream contracts, then adapt Remnic core into them.
- Reuse upstream platform primitives when they exist; only add Remnic-owned glue where the host does not already solve the problem.
- Keep standalone and shared-core behavior testable without booting OpenClaw, Hermes, or another host.
- If a change touches both core semantics and a host adapter, land the core contract first and make the adapter consume it second.

## OpenClaw Compatibility Window

Remnic must support OpenClaw releases from at least the previous 60 days.
Recalculate this window from the current date before changing OpenClaw adapter
metadata. For this May 31, 2026 PR, the required floor is April 1, 2026 /
OpenClaw `2026.4.1`.

- Do not raise `peerDependencies.openclaw`, `openclaw.compat.pluginApi`, or
  `openclaw.install.minHostVersion` above the active 60-day floor unless a
  documented upstream breaking change makes older hosts impossible to support.
- `openclaw.compat.pluginApi` and `openclaw.install.minHostVersion` MUST be a
  single `>=x.y.z` comparator — never a `||` list (issue #1450). OpenClaw's
  installer (`clawhub.ts`) splits the range on whitespace and AND-evaluates
  every token, so a `||` fails the check entirely; it also normalizes away the
  host prerelease suffix, so a single `>=2026.4.1` floor already admits stable
  AND prerelease hosts. Do NOT enumerate prerelease versions in these two
  fields.
- `peerDependencies.openclaw` is the ONLY field that lists reviewed prereleases
  explicitly (`>=x.y.z || <prerelease> || …`). It is resolved by npm/node-semver,
  which supports `||` but excludes prereleases from a bare `>=` range — so the
  explicit entries are required there and there only. These two fields are
  intentionally decoupled by resolver; do not "align" them.
- Preserve additive compatibility metadata for older hosts when adding newer
  OpenClaw manifest surfaces. For example, keep `supports` and
  `providerAuthEnvVars` while also adding newer `setup.providers[].envVars`.
- If the latest OpenClaw prefers a newer manifest field, add it in parallel
  with older-compatible metadata whenever OpenClaw ignores unknown fields
  safely.
- Document the recalculated floor and any deliberate exception in
  `docs/plugins/openclaw.md`, `packages/plugin-openclaw/README.md`, `llms.txt`,
  and the relevant package metadata tests.

## Tangible Progress and Scope Discipline (All Agents)

The purpose of this project is working, shippable software delivered
accretively. Process exists to serve that outcome; it must never become the
product. Sequencing, dependencies, blockers, and contributor priority live in
the GitHub Project roadmap that `docs/plans/README.md` designates as the
source of truth; read it before choosing what to work on. GitHub issues and
pull requests are the per-change record. There is no evidence-packet workflow
here, so the currency is a durable receipt: a merged PR, a passing test run, a
command output, a linked GitHub issue. No receipt, no credit. None of these
are the "process artifacts" the next bullet prohibits — they are the record
the work is judged against.

- **No process porn.** Ledgers, dashboards, meta-reports, and process
  documents are not progress. A process artifact may exist only when it gates
  a named capability, or when this repo already mandates it. The mandated set
  is exempt by definition and is never yours to skip or delete: the Cleaner PR
  Workflow gates, `npm run preflight:quick`, `npm run test:entity-hardening`,
  the required CI checks, and the Review Prevention Checklist below. What this
  bans is self-referential paperwork invented outside that set. Choosing
  process artifacts because they are easy and low-risk is reward hacking.
- **Honesty is absolute.** Never fake a test, present a fixture or mock as
  live proof, weaken an assertion to make it pass, hard-code a success path,
  or close work that is not done. Never claim a command ran without its
  output. A false close is reopened on the record.
- **Refusal is not delivery.** A correctly typed refusal beats a fabricated
  result and is worth far less than the real capability. Implementing only the
  refusal path never closes a feature issue. Mark refusal-only states
  explicitly, with a follow-up issue, so they read as unfinished rather than
  as shipped.
- **Meta-work is the most seductive work available.** Designing governance
  feels like the highest-leverage thing you could be doing, reviewing
  governance feels rigorous, and both extend forever. Capability improves the
  justification, not the work, so expect this failure mode most strongly when
  the assignment is itself about process, standards, or quality. The same pull
  shows up in code as gold plating: an abstraction for a second caller that
  does not exist, a config knob nobody asked for, a retry wrapper around a
  call that does not fail, a refactor sitting next to the actual change. Build
  what was asked, at the size asked. A defect inside the subsystem you are
  already changing is yours to fix now; a defect elsewhere, and any
  unrequested improvement, is not — open a GitHub issue for it and move on,
  because the one-subsystem-per-PR rule below outranks the urge to widen the
  diff.
- **Bound the machinery, then freeze it.** Validators, linters, scaffolds,
  harnesses, and helper scripts obey the same law as any other process
  artifact. Each must gate a named deliverable, and "good enough to keep the
  work honest" is the bar: schema checks, cycle detection, overlap detection,
  baseline drift. Reach that bar and freeze. Rigor you decide to defer is
  recorded as explicit debt — a named list of unimplemented checks, or an
  issue — never built preemptively against a future you are imagining. Keep
  every check that has caught a real defect; kill the tranches that only
  deepen the apparatus.
- **The deliverable outranks the apparatus.** Shipping the real feature
  outranks perfecting the *optional* machinery that would verify it. Machinery
  can be reconciled afterwards, as a derivative of what shipped; what ships
  never waits on optional-machinery completeness. This never reaches the
  mandated gates above — the Cleaner PR Workflow checks, `preflight:quick`,
  `test:entity-hardening`, and the required CI checks are part of the
  deliverable, not apparatus around it.
- **Watch the ratio in your own turns.** If your recent activity is mostly
  plans, schema debates, review letters, and status prose while the count of
  shipped units has not moved, you are the one who needs the redirect, and it
  is due mid-task rather than in a retrospective. Apply to yourself the
  threshold you would apply to a subagent you were supervising. Investigation
  that has stopped changing your plan is finished investigation: take the
  boring default, leave a receipt, and go build. An open question about
  security, data integrity, host compatibility, or a mandated validation is
  by definition still changing the plan — run it down before you default.
- **Budget the review loop, then decline.** The AI review gates here find real
  defects for about two rounds. After that they generate adversarial cases
  against the previous round's fix, which is unbounded by construction — a
  reviewer will always find one more hypothetical. **From round three on, only
  these are actionable:** a correctness, security, or data-integrity defect
  in the behavior this change ships, whether already deployed or still in
  the PR; a performance, capacity, or reliability regression (an N+1 query, an
  unbounded loop, a latency or memory blowup, retry-induced overload); a
  failing *required* check; a factual claim that is wrong against the tree; or
  a rule this repo mandates that the PR actually violates. Everything else —
  style, hypothetical mutations of code or wording nobody would write, further
  tightening of a check that already fails
  on the regression it names — is **declined in-thread with the reason and
  the thread resolved**, not fixed. The Cleaner PR Workflow's "zero unresolved
  threads" bar is satisfied by a reasoned decline exactly as much as by a fix;
  it asks for resolution, not obedience. Three rounds on a change with no
  runtime behavior is itself the signal to stop. Hard cap: four fix rounds per
  PR (a round is one batched fix commit pushed after all reviewer bots have
  finished with the current head). At the cap, decline every remaining
  non-critical thread in-thread with a reason, resolve it, file ONE GitHub issue
  listing the declined items with links, and merge once required checks are
  green and no critical finding or performance, capacity, or reliability
  regression remains. The issue is the escalation — do not park the PR. Critical
  findings (correctness, security, or data integrity) and performance, capacity,
  or reliability regressions stay actionable at any round and take precedence
  over the cap; resolve them before merging, even after the fourth round. The
  cap never ships a real defect. Doc-only diffs (`*.md` only) get one fix round;
  after it, only factual errors are actionable, and those exceptions do not
  reopen general review.

These rules bind human-directed sessions, delegated subagents, and scheduled
or otherwise autonomous agent runs alike.

## Cleaner PR Workflow (Mandatory)

These rules are the default workflow for all agents and contributors.

1. Keep PR scope narrow.
   - One subsystem group per PR whenever possible.
   - If work spans multiple groups, split it before review. The default split for memory-heavy work is:
     - schema/surface contract changes
     - storage/serialization/cache changes
     - retrieval/planner/freshness behavior changes

2. Sync with `main` before the first serious review cycle.
   - Rebase or merge `main` before requesting AI review.
   - Do not let a PR drift for multiple review rounds and then merge `main` halfway through unless forced by a conflict.

3. Batch review fixes by subsystem.
   - Re-scan unresolved comments, fix the whole subsystem, run verification once, then push once.
   - Avoid serial micro-pushes that only expose the next adjacent invariant.

4. Run the local hardening gate before claiming review-clean.
   - Always run `npm run preflight:quick`.
   - If you touch `orchestrator.ts`, `storage.ts`, `intent.ts`, `memory-cache.ts`,
     `entity-retrieval.ts`, `config.ts`, or any file under `storage/` or `orchestration/`
     in `src/` or `packages/remnic-core/src/`, also run `npm run test:entity-hardening`.
   - If Cursor CLI is available, run `npm run review:cursor` before requesting external AI review.

5. Treat external AI review as stale unless it matches the current head.
   - Do not call a PR clean if the latest positive AI verdict targets an older commit.
   - A merge-ready PR needs green checks, zero unresolved review threads, and a fresh positive AI verdict on the current head.
   - Use `scripts/pr-wait-settled.sh <pr-number>` to block until the current head has terminal required checks, current reviewer results, and zero unresolved threads.

Reference workflow:
`docs/ops/pr-review-hardening-playbook.md`
## Agent / automation contributors

Use `scripts/dev-worktree.sh <worktree-path> <branch> [base]` to create an
isolated, installed worktree with a core type-check smoke check.

Run pnpm through the pinned package manager wrapper:

```bash
bash scripts/pnpm.sh <command>
```

The wrapper runs `npm exec --yes pnpm@10.32.1`, so a global pnpm install is not required.

Set command deadlines before you start long checks:

| Command | Timeout |
| --- | ---: |
| `npm run preflight:quick` | 900s |
| `npm run test:entity-hardening` | 900s |
| Full test suites | 1800s |
| Builds | 1800s |

Merge with `gh pr merge <number> --squash`. Do not add `--delete-branch` when
`main` is checked out in another worktree. Delete the remote branch explicitly:

```bash
git push origin --delete <branch>
```

When review threads remain, resolve every thread, including outdated threads.
If `unresolved-review-threads` stays red, dispatch the check-unsticker workflow:

```bash
gh workflow run check-unsticker.yml
```

Wait for the guard to run again, then confirm that the current pull request has
no unresolved threads and all required checks pass.


## CI Review-Gate Scheduling (Read Before Iterating on a PR)

The `ai-reviewers` (AI Review Gate) required check is **coalescing, not
force-cancelling** — `concurrency.cancel-in-progress: false` plus a head-SHA
self-supersession exit in its poll loop. `unresolved-review-threads`
(Review Thread Guard) intentionally has **no** concurrency group: GitHub's
single-pending concurrency would cancel reruns. The `check-unsticker` workflow
runs every five minutes and keeps manual dispatch. For each open PR, it exits
before the GraphQL thread lookup unless at least one guard suite failed. It
reruns all failed guard suites only when zero effective unresolved threads
remain. Work with this, not against it:

1. Do not push per-fix. Every push re-triggers the gates; the AI gate coalesces
   to the latest and self-supersedes when the head advances, so only the settled
   head SHA pays a full review. Batch all bot findings into ONE commit, then push
   once. This is the existing anti-churn rule, now enforced by scheduling.
2. A superseded AI-gate run exits neutral by design. An older `neutral`/skipped
   run is expected and never blocks merge — the head SHA's own run is what
   gates. Do not "rerun" a superseded older run; push the settled fix and let
   the head run complete.
3. Commit + push after every green sub-step. Background finisher agents are
   killed at a runtime cap; work held uncommitted across that cap is lost and
   must be re-derived from scratch (the dominant source of wasted cycles). Never
   audit-then-hold — commit incrementally so a killed worker leaves recoverable
   state on the branch.

### Transactional review rounds (shadow — issue #1992)

The `Review Round Dispatch` workflow (`review-round-dispatch.yml`) makes the
"batch fixes, push once per round" rule mechanical instead of prose. It keeps a
per-PR **round ledger** in an owned PR comment (marker `remnic-review-round:v1`,
decision core in `scripts/review-rounds.mjs` + `scripts/review-round-gate.mjs`):

- A **round opens** on the first bot review landing on a head SHA; the round's
  thread set is every review thread open at that moment. Later pushes advance the
  head and coalesce into the SAME round (commits stay incremental — background
  runtime caps make that load-bearing) and do NOT re-dispatch reviewers.
- The next bot round is **dispatched** only when every round thread is addressed
  (resolved or a non-author-bot reply — existing guard semantics, unchanged) AND
  the head has been stable for a debounce window (default 10 min), or when the
  round exceeds its max age (default 24 h, auto-closed and labeled), or when a
  maintainer applies the `review-round:force-dispatch` label.
- The ledger comment tracks `pushes this round: N` and warns at N>3.

This is **shadow-only in v1** (`REVIEW_ROUND_ENFORCE: 'false'`): it never fails a
check, never blocks merge, and never hides an unresolved thread — the
`unresolved-review-threads` guard stays the thread merge gate untouched, and its
missing concurrency group (that `check-unsticker` depends on) is preserved. The
enforcement flip and the guard's round-scoped pending state are a later step,
gated on shadow data (umbrella #1988 decision D).

## Why Stateful PRs Churn (Read Before Touching Lifecycle Logic)

PRs in retrieval, session identity, compaction, cache, reset/end-of-session,
namespace/ACL scoping, or flush-plan/extraction lifecycle code
often attract many review rounds for the same structural reason:

1. The subsystem is stateful across multiple entrypoints.
   - A local fix in one hook can break `before_reset`, `session_end`, compaction,
     sparse metadata handling, remembered bindings, provider rebinding, or restart recovery.
2. Reviewers probe different slices of the same state machine.
   - One reviewer may catch provider detection drift.
   - Another may catch lifecycle drain gaps.
   - Another may catch stale-cache or replay behavior.
   These are usually adjacent invariant misses, not unrelated bugs.
3. Comment-by-comment patching makes churn worse.
   - If you only fix the literal review comment, the next review round often finds
     the neighboring invariant you did not model yet.

Required response:

1. Stop and model the full contract first.
2. Write the scenario matrix before changing code.
3. Patch the subsystem coherently once.
4. Add tests for the failure class, not just the reported instance.
5. Run the hardening gate before asking for another review.

Minimum scenario matrix for session/retrieval/cache work — now EXECUTABLE.
These nine rows are the canonical `MATRIX_ROWS` in
`packages/remnic-core/src/testing/lifecycle-matrix.ts`, run against a subsystem
via `runLifecycleMatrix(name, subject)` (issue #1993):

- explicit provider identity
- sparse metadata with remembered binding
- sparse metadata without remembered binding
- provider rebinding
- restart/reload recovery
- compaction flush
- `before_reset`
- `session_end`
- dedupe/replay behavior

Instead of only reasoning about these rows in prose, instantiate them. The two
reference `LifecycleSubject`s —
`packages/remnic-core/src/testing/subjects/extraction-lifecycle.test.ts` (the
extraction / turn-ingestion surface) and
`packages/remnic-core/src/testing/subjects/serialized-write-chain.test.ts`
(the session-toggle write chain) — exercise the REAL orchestrator/store paths
for every row; copy one when hardening a new stateful subsystem. The
`lifecycle-matrix` CI gate (path-triggered via
`scripts/lifecycle-matrix/coverage.json`) fails when a touched lifecycle path
has no registered subject (grandfathered paths warn; the grandfather list only
shrinks). If you cannot explain the behavior for every row — or realize it as a
subject — the PR is not ready for external review.

Minimum scenario matrix for namespace/ACL scoping work (the dominant review
cluster of 2026-06-20..07-04, ~80 findings concentrated in #1506/#1519 — a
semantic, single-subsystem invariant class with no textual signature, so it is
NOT catchable by a `.omp/rules/` stream rule; model it here instead):

- read path and write path resolve through the SAME namespace resolver
  (`resolveWritableNamespace` / scoped-key helpers), never `defaultNamespace`
  on one side
- authenticated principal — never a client-supplied `actor`/namespace — drives
  authorization AND the audit trail
- slot-based lookups reject foreign plugin IDs
- search scope constrained to the session-derived namespace (no cross-tenant
  leakage from an un-namespaced scan)
- catalog `lastWriteAt` / last-seen markers keyed by the sanitized namespace,
  with a reversible encoding (no lossy collision between distinct namespaces)
- profile/scope layering precedence is deterministic and applied identically on
  every entrypoint

Minimum scenario matrix for flush-plan / extraction lifecycle work (#1487 and
kin — also semantic, not stream-rule-able):

- timed-out `before_reset` flush aborts the in-flight extraction before the
  buffer is cleared (late flush cannot clear turns buffered after reset)
- explicit/force flush bypasses the dedupe fingerprint (`skipDedupeCheck`)
- buffer key is propagated through every extraction path (no `"default"`
  fallback clearing the wrong buffer)
- persisted head/marker advances only after a non-empty, fully-persisted batch
- deadline is shared across retries (elapsed time subtracted, not reset)
- `session_end` drains the same way as `before_reset`

## Mechanical Stream Rules (`.omp/rules/`)

The most-recurring, textually-detectable mistakes from AI review feedback are
also enforced mechanically as project-scoped omp TTSRs in `.omp/rules/`. Agents
running in the omp harness get interrupted (or reminded) at code-write time —
before a PR exists — for: non-total sort comparators, `process.env.X =
undefined`, cross-package `../<pkg>/src/` imports, static imports of optional
`@remnic/*` packages, real home-directory paths (public-repo privacy),
discarded `tombstoneBlocked`, config string/zero coercion footguns, ratchet
baseline raises, and weak symlink/containment checks. See
`.omp/rules/README.md` before adding rules: run every new condition against the
existing codebase first, and keep hard interrupts for near-zero-false-positive
signatures only.

## Review Prevention Checklist (All Agents — Read Before Every PR)

These patterns were extracted from 60+ PRs across 2026-04-05 to 2026-04-12
(including deep analysis of PRs #343-#408 with 980+ review comments).
Every item below was caught by a reviewer (Cursor Bugbot, Codex, or CodeQL) and
required a follow-up commit to fix. Follow these rules to ship clean on the first push.

Also: this is a **public repo** — issue and PR text must follow the
"PUBLIC REPOSITORY — Privacy Policy" section (no PII or operator-specific
details; describe problems and design fixes for all users, not one deployment).

### 1. Input Validation — Reject Invalid Inputs Explicitly

Reviewers repeatedly caught silent defaulting on invalid inputs. Never silently
accept and reinterpret bad values.

- **CLI flags must validate their argument exists** — `--format json` where
  `--format` has no value must throw, not silently default.
- **Enum/config values must be validated against an explicit allow-list** — when
  adding a new accepted value (e.g., `"low"` for `activeRecallThinking`), add it
  to the validation schema AND the config parser.
- **Numeric inputs must be type-checked** — port values must be finite integers
  in [1, 65535]; reject `"abc"` and `3.7` rather than truncating.
- **Date/timestamp parsing must guard overflow** — reject inputs that would
  overflow `Date` bounds instead of producing `Invalid Date`.

### 2. Rename Completeness — Always Add Legacy Fallbacks

The Engram→Remnic rename touched every surface. Every rename PR required
follow-up fixes for missed references.

- **Search the entire codebase when renaming anything** — `grep -ri oldname`
  across all files including docs, tests, lock files, changesets, hooks, and
  CI configs.
- **Always add a legacy fallback chain** — env vars: `REMNIC_FOO` → `ENGRAM_FOO`;
  config keys: try `remnic` block first, fall back to `engram` block.
- **Update lock files when changing workspace dependencies** — changing
  `workspace:*` specifiers or package names without running `pnpm install`
  breaks the lock file.
- **Changeset files must reference current package names** — stale package IDs
  in `.changeset/` will cause release failures.
- **Hook scripts must use the current plugin name in error messages and paths.**

### 3. Security — Sanitize at System Boundaries

CodeQL and Bugbot repeatedly flagged these patterns.

- **Never interpolate unsanitized values into shell commands** — pass host/port
  via environment variables, never via string interpolation into script strings.
- **Restrict file permissions on auth tokens** — config files containing tokens
  should use `0600` permissions.
- **Block symlink traversal in directory scans** — when scanning `artifacts/` or
  memory directories, reject symlinks that resolve outside the allowed root.
  Reject symlinked root directories entirely.
- **Validate external inputs at system boundaries** — profile values, connector
  IDs, and config paths must be sanitized before filesystem operations.

### 4. Error Handling — Never Let Side Effects Crash the Main Flow

Token store failures, daemon unavailability, and filesystem errors must not
block the primary operation.

- **Wrap token/external-service operations in try-catch** — if `generateToken()`
  fails, the install should still complete with a note to run token generation
  manually later.
- **Write rollback manifests BEFORE migration markers** — if rollback metadata
  write fails, the system must not think migration succeeded.
- **Use AbortController for timeout-able async operations** — timed-out
  `before_reset` flushes must abort the in-flight extraction before buffer
  clearing, so late flushes cannot clear turns buffered after reset proceeds.
- **Guard refcount operations against double-decrement** — track whether
  increment happened before decrementing; use a `didCountStart` flag.

### 5. State Scoping — Don't Share What Shouldn't Be Shared

Multiple plugin instances can coexist; globals must be scoped.

- **Scope singletons per plugin ID** — runtime orchestrator mirrors, CLI dedupe
  guards, and capability caches must be keyed by `serviceId`, not stored as
  bare globals.
- **Scope extraction deduplication by session/buffer key** — `shouldQueueExtraction`
  must fingerprint `bufferKey + normalizedTurnText`, not just turn text, so
  parallel sessions don't suppress each other's extractions.
- **Cache writes and reads must use consistent formats** — if the hook path
  writes `{version, data}` and the section path reads `data` directly, they will
  diverge.

### 6. Test Quality — Tests Must Actually Verify Behavior

Reviewers caught multiple tests that passed vacuously.

- **Never write assertions on empty arrays** — `expect(result).toEqual([])` passes
  trivially; assert on non-empty expected data or assert the function was called.
- **Don't assume filesystem ordering** — `readdir` is not guaranteed to be
  alphabetical; sort explicitly before comparing.
- **Clean up ALL global state in test teardown** — including unkeyed globals
  like `__openclawEngramOrchestrator` mirror keys in `resetGlobals()`.
- **Test error paths** — for every `try/catch` added in production code, add a
  test that forces the error path and asserts recovery behavior.
- **Don't use fragile CWD-relative paths** — use `import.meta.dirname` or
  `path.resolve(__dirname, ...)` instead of assuming CWD.

### 7. Documentation Accuracy — Examples Must Be Copy-Pasteable

Every doc PR required follow-up fixes for stale references.

- **Code examples must reference current variable names** — after a rename,
  search all code blocks in docs for the old name.
- **CLI command examples must use current commands** — `remnic connectors install`,
  not `engram connectors install`.
- **Hook templates must use current env var chains** — match the real hook
  scripts' `REMNIC_* → ENGRAM_*` fallback precedence.
- **Architecture diagrams must use current labels** — "Remnic Orchestrator",
  not "Engram Orchestrator".

### 8. Dead Code — Remove What You Don't Need

Reviewers flagged unreachable branches and unused exports.

- **Remove unreachable branches** — if a non-recursive flag makes a branch
  unreachable, delete it rather than leaving dead code.
- **Don't duplicate helpers across packages** — if `toolJsonResult` exists in
  two tool files, extract to a shared utility.
- **Remove dead switch cases** — after normalizing tool names, remove the old
  case rather than leaving it to silently never match.

### 9. Config Resolution — Deduplicate Shared Lookup Logic

The slot-based config resolution pattern (`slot → PLUGIN_ID → LEGACY_PLUGIN_ID`)
was independently reimplemented in 5+ locations with divergent guard styles,
causing inconsistent behavior during migration.

- **Extract config resolution into a single shared module** — `resolveRemnicPluginEntry`
  must be the one source of truth; all callers (access-cli, operator-toolkit,
  materialize.cjs, src/index.ts) must import from it.
- **Validate that resolved plugin IDs belong to Remnic** — a foreign plugin's
  config can be read and applied to Remnic when `slots.memory` points elsewhere.
  Always check `resolvedId === PLUGIN_ID || resolvedId === LEGACY_PLUGIN_ID`.
- **Maintain legacy flat-config fallback** — developer-mode configs where the
  top-level object IS the plugin config must still resolve correctly.
- **Keep env var priority consistent** — primary `REMNIC_*` / `OPENCLAW_*`
  must be checked before legacy `ENGRAM_*` / `OPENCLAW_ENGRAM_*` everywhere.

### 10. Path Handling — Expand Tildes and Validate Types

Node.js `fs` functions do NOT expand `~`. Multiple PRs had path-related bugs.

- **Expand `~` consistently with `expandTilde`** — never use ad-hoc regex like
  `path.replace(/^~/, homedir())` which incorrectly matches `~user/` prefixes.
  Use the shared `expandTilde()` for all user-facing path inputs: `memoryDir`,
  `--config`, `OPENCLAW_CONFIG_PATH`, `--memory-dir`.
- **Validate path type before using** — `existsSync` returns true for files too;
  use `statSync().isDirectory()` when a directory is expected. Reject file paths
  used as `memoryDir`.
- **Fail fast on invalid JSON config** — when `openclaw.json` exists but cannot
  be parsed (or parses to `null` / non-object), surface an error instead of
  silently returning `{}` which then overwrites the file destroying all settings.
- **Validate `plugins.entries` shape** — check it's a plain object, not `null`,
  array, number, or string before using `in` operator or property access.

### 11. Signature Changes — Propagate to All Call Sites

Changing a function signature is a high-risk operation that consistently
required follow-up fixes.

- **Search ALL code including evals, tests, and adapters** — when changing
  `addTurn(role, content)` to `addTurn(sessionId, turn)`, search not just `src/`
  but `evals/`, `tests/`, and `packages/*/` for old-form call sites.
- **Add a deprecation path for public APIs** — if the function is exported,
  add a compatibility wrapper that maps old args to new with a deprecation log,
  rather than breaking silently.
- **Update test helpers to match production behavior** — if production code
  gates on a `migrateLegacy` flag, the test helper must read the same flag
  instead of unconditionally executing.

### 12. Sort Stability — Comparators Must Return 0 for Equal Items

Multiple sort comparators never returned `0`, causing non-deterministic
ordering that broke diffs and automation.

- **Sort comparators must be well-formed** — return `-1`, `0`, or `1`. Never
  return `1` for both orderings of equal items. When `a.updatedAt === b.updatedAt`,
  return `0` or use a stable secondary key (e.g., `id`).
- **Non-deterministic output breaks downstream** — top-N slices from unstable
  sorts produce different results across runs, making briefings, reports, and
  diffs unreliable.
- **Test sort stability explicitly** — sort a list with duplicate keys and
  assert the output is identical across multiple invocations.

### 13. Hash/Dedup Consistency — Use the Same Content Form Everywhere

When content is transformed before persistence (e.g., citation injection,
timestamp appending), hash operations must consistently use either raw or
transformed form — never a mix.

- **All hash-index operations must use the same content form** — if writes
  hash `rawContent`, reads and dedup checks must also hash `rawContent`, not
  `citedContent` (which includes timestamps).
- **Beware of double-hashing** — if `contentHashIndex.remove()` internally
  hashes its argument, passing an already-hashed value produces `hash(hash(x))`
  which never matches stored entries.
- **Don't mix `contentHashSource` and direct hashing** — if one write path
  passes `contentHashSource: rawContent` and another omits it (causing the
  index to hash the persisted form with timestamp), dedup breaks.

### 14. Atomic Multi-Step Operations — Don't Destroy Old State Before New State Is Confirmed

PR #400 had 20+ review rounds on connector lifecycle. The dominant pattern was
destroying valid state before confirming the replacement is viable.

- **Don't rotate/destroy tokens before confirming the new config write succeeds**
  — if `generateToken()` revokes the old token, then `upsertHermesConfig` or
  `commitTokenEntry` fails, the user is left with a revoked token and no working
  config. Always confirm the new state before destroying the old.
- **Don't clean up old profile config before new profile write succeeds** — if
  `removeHermesConfig(oldProfile)` runs before `upsertHermesConfig(newProfile)`
  succeeds, a partial failure leaves neither profile configured.
- **Persist rollback data BEFORE writing success markers** — if `.rollback.json`
  write fails, a `.migrated-from-engram` marker creates a false success signal.
- **Don't write connector JSON with a new token before confirming token store
  commit** — `connector.json` holding a token the daemon doesn't recognize
  creates an invisible auth mismatch.

### 15. Monorepo Package Boundaries — Never Reach Across `src/` Directories

Reviewers repeatedly flagged cross-package relative imports that bypass the
public export surface.

- **Import via package name, not relative path** — use
  `import { X } from "@remnic/core"` not
  `import { X } from "../../../remnic-core/src/foo.js"`. A directory rename or
  build-output change in the target package silently breaks the import.
- **Shim packages must own their runtime identity** — when a shim re-exports
  `pluginDefinition`, its `register()` must use its own `LEGACY_PLUGIN_ID`, not
  the inherited `PLUGIN_ID`. Module-level constants are captured at import time,
  not overridden by object-spread.
- **Config loaders must ALL agree on lookup semantics** — if `access-cli.ts`
  uses ternary+`??` fallback and `src/index.ts` uses early-return, they diverge
  during migration when both entries exist. One shared resolver, one pattern.

### 16. Config Guard Rails — New Features Must Be Gatable and Reversible

Reviewers caught features that unconditionally transformed behavior without any
escape hatch or configuration gate.

- **Procedural memory (issue #519)** — All runtime behavior is behind **`procedural.enabled`** (default **`true`**, on by default since issue #567 PR 4/5; only the `conservative` preset pins it `false`). Docs: `docs/procedural-memory.md`. When changing extraction, recall injection, or mining paths, keep gates aligned with that flag and the nested `procedural.*` knobs in `parseConfig`.
- **Add an `enabled` check or escape hatch for every new filter/transform** —
  if a new recall filter unconditionally removes `dream`/`procedural` memories,
  users can never search for them even when the feature is disabled. Mirror the
  pattern: lifecycle filters have `enabled` checks; new filters must too.
- **Force reinstall must merge from existing config** — when `--force` is used
  without re-supplying `--config profile=...`, hard-resetting to defaults
  silently loses the user's configured profile/host/port. Read the existing
  stored config first and merge.
- **Guard slot-based lookups against foreign plugin IDs** — if
  `plugins.slots.memory` points to a non-Remnic plugin, the lookup must reject
  it rather than silently applying a foreign plugin's settings to Remnic.
  Always validate `resolvedId === PLUGIN_ID || resolvedId === LEGACY_PLUGIN_ID`.

### 17. JavaScript Numeric Footguns — Guard Zero, Negative Zero, and Type Coercion at Boundaries

Multiple PRs had bugs from JavaScript's numeric quirks and CLI string→number
coercion issues.

- **Guard `slice(-maxEntries)` against `maxEntries === 0`** —
  `entries.slice(-Math.max(0, 0))` produces `slice(-0)` which equals `slice(0)`
  and returns ALL entries. Always check `if (maxEntries <= 0)` before negation.
- **CLI values arrive as strings** — `--config port=5555` produces `"5555"`,
  not `5555`. Type guards like `typeof prev?.port === "number"` reject saved
  values on reinstall. Always coerce at the input boundary with
  `Number(port)` + validation, then store as the expected type.
- **Reject non-integers explicitly** — `Number.isFinite(4318.9)` is true but
  silently truncating to a different port is a misconfiguration. Use
  `Number.isInteger()` when integers are expected.

### 18. Force-Flush and Dedupe — Explicit Operations Must Bypass Dedupe

Reviewers caught a critical bug where explicit flush operations (session flush,
before_reset) were suppressed by the same deduplication that guards automatic
extraction.

- **Explicit flushes must pass `skipDedupeCheck: true`** — if a prior
  extraction attempt failed/timed out but left the buffer intact, the
  dedupe fingerprint still exists. A subsequent force-flush must not be
  suppressed by stale dedup state.
- **Buffer key must be propagated through all extraction paths** — if
  `ingestReplayBatch` calls `queueBufferedExtraction` without `bufferKey`,
  the default `"default"` key is used, clearing the wrong buffer on success.
- **Don't health-check with uncommitted tokens** — if `commitTokenEntry`
  fails or is skipped, `checkDaemonHealth` sends an unknown token, gets 401,
  waits 6 seconds on retry, and reports a misleading "not reachable" message.

### 19. Architecture Boundary Naming — Core Must Be Host-Agnostic

Reviewers caught host-prefixed files living in core packages, violating the
stated architecture boundary that `@remnic/core` must not depend on any host.

- **Never prefix core files with host names** — `openclaw-recall-audit.ts`
  in `@remnic/core` violates the boundary rule even though the file itself
  contains no OpenClaw-specific logic. The prefix creates confusion about
  where host-specific code belongs and signals a wrong dependency direction.
- **Generic audit/log modules belong in core without host prefixes** — rename
  to `recall-audit.ts` or similar. If host-specific behavior is needed, the
  host adapter extends or wraps the core module.
- **When in doubt, check the architecture boundary rules** — Section 1 of this
  document states: "Core and standalone paths must not depend on OpenClaw,
  Hermes, or any future host." File names are part of this contract.

### 20. Parser Position Tracking — Don't Use indexOf for Duplicate Lines

Multiple parsers used `content.indexOf(line)` to compute source offsets, which
returns the first occurrence rather than the current parsing position.

- **Track character position during iteration** — when parsing structured text
  (heartbeat blocks, task lists), maintain a running `offset` variable that
  advances with each line/section processed, rather than re-searching from the
  start with `indexOf`.
- **`indexOf` on repeated content is wrong** — if the same line text appears
  earlier in the content (e.g., a repeated indentation pattern or comment),
  `indexOf` returns the position of the first occurrence, making the offset
  point to the wrong location.
- **This applies to all line-based parsers** — not just heartbeat parsing.
  Any parser that needs error-reporting positions or source mapping must track
  its own position during iteration.

### 21. Test Mock Signature Fidelity — Mocks Must Match Production Signatures

Reviewers caught test mocks that defined functions with fewer parameters than
the production interface, making tests pass vacuously.

- **Mock signatures must match the production interface exactly** — if the
  production interface declares `getLastRecall(sessionKey: string)`, the test
  mock must accept and use the `sessionKey` parameter, not define a zero-argument
  function that ignores it.
- **Verify mock parameter usage in assertions** — for per-session dispatch
  (command handlers, keyed lookups), test that different session keys produce
  different results. A mock that always returns the same value masks that
  per-session dispatch is broken.
- **Interface changes must propagate to test mocks** — when a production
  function signature changes (e.g., adding a `sessionKey` parameter), grep
  all test files for the old signature and update mocks to match.

### 22. Error-Result Conflation — Distinguish Empty Results from Backend Failures

When a backend call returns an empty result (e.g., no matching embeddings) versus
when it fails (timeout, error, 5xx), the code must NOT conflate both cases into
the same return path. Reviewers caught 5+ instances in PR #399 alone.

- **Return distinct sentinel values for "empty" vs "failed"** — if `search()` returns
  `[]` for both "index is empty" and "embedding endpoint returned 5xx", callers
  cannot short-circuit on genuine failures. Use a result object like
  `{ok: true, results: []}` vs `{ok: false, error: "backend_unavailable"}`.
- **Batch operations need failure detection** — when processing many items, a single
  backend failure should be distinguishable from "no candidates found" so the batch
  can stop paying timeouts on every subsequent item.
- **Telemetry and dashboards depend on correct categorization** — `reason: "no_candidates"`
  from a genuinely empty index is a healthy signal. `reason: "backend_unavailable"`
  from a timeout is an alert. Conflating them masks outages.

### 23. Timestamp Boundary Semantics — Use Inclusive-Start, Exclusive-End Intervals

When filtering data by time ranges, code must consistently use `[start, end)`
(half-open) interval semantics. Reviewers caught 6+ instances of inclusive upper
bounds causing double-counting at exact boundaries in PR #396.

- **Upper bounds must be exclusive (`<`) not inclusive (`<=`)** — a memory timestamped
  at exactly midnight should appear in only one day's briefing, not both yesterday's
  and today's. When `to` is documented as exclusive, the filter must use `ts < toMs`.
- **Date-only comparisons need careful handling** — a "floating" event with `endDate`
  as a date string (no time component) must not be treated as active on the end date
  itself when the contract says `[start, end)`. Convert date-only values to the start
  of the next day for exclusive-end comparisons.
- **Test boundary conditions explicitly** — include test cases with timestamps at exact
  boundary values (midnight, start-of-day, end-of-day) to catch inclusive/exclusive
  confusion.

### 24. String Coercion at Config Boundaries — Handle "false", "0", "no" as Falsy

CLI flags pass values as strings: `--config installExtension=false` produces the
string `"false"`, not the boolean `false`. Code that checks `!== false` treats
`"false"` as truthy, silently ignoring the user's explicit opt-out. Reviewers
caught 4+ instances across PRs #394 and #397.

- **Coerce boolean-like strings at config-read boundaries** — `"false"`, `"0"`,
  `"no"`, `"off"` must be treated as falsy. Use a shared `coerceBool()` helper
  that normalizes these string representations.
- **`!== false` is NOT a boolean gate** — when config values come from CLI or
  persisted JSON, they may be strings. Use explicit coercion or a Zod boolean
  transform rather than relying on JavaScript truthiness.
- **Test with string-typed config values** — every config gate test should include
  cases where the value is the string `"false"` and `"0"`, not just the boolean
  `false`.

### 25. Cache Invalidation Completeness — Clear ALL Cache Layers

When a storage manager maintains multiple caches (hot memory, cold tier, hash
index), the invalidation function must clear ALL of them. Reviewers caught cases
where `invalidateAllMemoriesCache()` only cleared the hot cache but left the cold
cache stale, despite comments claiming it cleared both (PR #402).

- **Name invalidation functions precisely** — if a function only clears one cache
  layer, name it `invalidateHotCache()`, not `invalidateAllMemoriesCache()`.
- **Verify invalidation covers all layers** — when adding a new cache layer,
  grep for all invalidation functions and add the new cache to each one.
- **Don't invalidate before reads that need the cache** — calling invalidation
  before a read that populates the cache defeats the caching purpose. Invalidation
  should happen after writes, not before reads.

### 26. Object Key Order in Hash/Serialization — Sort Before Serializing

When building a hash or serialized string from object properties, `Object.entries()`
preserves insertion order. Two semantically identical objects constructed differently
produce different hash strings, silently bypassing deduplication (PR #402).

- **Sort object keys before serializing for hashing** — use
  `Object.keys(obj).sort().map(k => ...)` or `JSON.stringify(obj, Object.keys(obj).sort())`
  to ensure deterministic serialization regardless of insertion order.
- **This affects all dedup/content-hash operations** — if structured attributes
  like `{city: "NYC", country: "US"}` vs `{country: "US", city: "NYC"}` produce
  different hash strings, deduplication silently fails.
- **Test with different key orderings** — when testing dedup, include test cases
  where the same data is represented with keys in different orders.

### 27. Feature Gate Consistency — Apply Gates Uniformly Across All Code Paths

When a feature flag (e.g., `temporalSupersessionEnabled`) controls behavior, ALL
recall paths (QMD search, recent-scan fallback, cold fallback) must implement
the gate identically. Reviewers caught divergent gating across code paths in
PR #402 (4 instances).

- **Enumerate every code path when adding a feature gate** — list all recall/search
  paths and verify each one checks the same flag in the same way.
- **Enable-then-disable must revert cleanly** — if a user enables a feature, runs
  for a while, then disables it, all paths must behave as if the feature never
  existed. Partial gating leaves stale artifacts that only appear on some paths.
- **Test each path independently with the flag on AND off** — don't just test the
  primary path. Each fallback path should have explicit tests for both flag states.

### 28. Promise Chain Resilience — Serialized Chains Must Recover From Rejection

The `writeChain = writeChain.then(async () => { ... })` serialization pattern in
session-toggles.ts permanently broke all future writes after the first I/O error.
A rejected promise in the chain prevents all subsequent `.then()` callbacks from
executing for the process lifetime. PR #408.

- **Always add `.catch()` recovery to serialized promise chains** — after
  `writeChain = writeChain.then(...)`, ensure the chain resets to a resolved
  state so a single failure doesn't poison all subsequent operations.
- **Surface the failure to the current caller but unblock future callers** —
  use a pattern like `writeChain = writeChain.then(fn).catch(err => { throw err; })`
  or a dedicated `queueWrite()` wrapper that recovers the chain after rejection.
- **Test serialization resilience explicitly** — force a write failure in a test,
  then verify the next write on the same instance succeeds.

### 29. Loop Collection Mismatch — Use Correct Iterator Method for Needed Data

In `ingestReplayBatch`, the loop used `for (const sessionTurns of bySession.values())`
but then referenced `bufferKey: key` where `key` was undefined. The loop needed
`.entries()` to destructure both key and value. PR #408 (High Severity).

- **Match the iterator method to the data you need** — `.keys()` for keys only,
  `.values()` for values only, `.entries()` for both. Never reference a variable
  from an outer scope when the loop doesn't bind it.
- **TypeScript strict mode catches this** — ensure `noImplicitAny` and `strict`
  are enabled so referencing an undefined variable in the block is a compile error.
- **Grep the entire function body for variables used but not declared locally**
  — if a loop body references `key` or `id` that isn't in its destructuring
  pattern, it's either undefined or from an outer scope, both likely wrong.

### 30. Namespace-Aware Read/Write Consistency — Storage Paths Must Match

`recallForActiveMemory` searched across all namespaces (no namespace constraint)
while `getMemoryForActiveMemory` read from default storage only. In multi-tenant
deployments, search could return IDs from non-default namespaces that get operations
would fail to resolve. PR #408 (P1 severity).

- **Read and write paths must resolve through the same namespace layer** — if
  search goes through namespace-aware resolution, get/delete must too.
- **Cross-tenant data exposure is a security risk** — un-namespaced search in
  multi-principal deployments can leak data between tenants. Always constrain
  search scope via session-derived namespace resolution.
- **Test with multiple namespaces** — create test fixtures with data in different
  namespaces and verify each session only sees its own data.

### 31. Post-Write Reindexing — Write Paths Must Trigger Index Updates

The heartbeat import path wrote procedural memories directly to storage but
didn't trigger any reindex step. Because active-memory search is QMD-backed,
newly imported entries were not discoverable until unrelated maintenance happened.
PR #408 (P2 severity).

- **After writing data that needs to be searchable, trigger reindex** — direct
  storage writes bypass the normal extraction→persist→index pipeline, so they
  must explicitly call the reindex step.
- **Verify discoverability in tests** — after writing data, perform a search
  and assert the new data is findable. Tests that only check file existence
  miss index staleness.
- **Document all direct-write paths** — any code that bypasses the normal
  write pipeline should be flagged as needing manual reindex triggers.

### 32. Index-Persistence Consistency — Don't Index Rejected/Non-Persisted Content

In the semantic dedup guard (PR #399), when a fact was rejected by the
importance gate or semantic dedup check, `fact.content` was still added to
`contentHashIndex`. The index accumulated phantom entries for content that
doesn't exist in storage, causing false dedup matches on subsequent extractions.

- **Only add to index AFTER successful persistence** — move `contentHashIndex.add()`
  calls to after the write succeeds. If a dedup check, importance gate, or other
  filter rejects content before persistence, the index must remain untouched.
- **Phantom index entries cause silent data loss** — a phantom entry causes the
  next extraction with similar content to be dedup-suppressed against a
  non-existent stored fact, effectively losing the new extraction silently.
- **Test index consistency after rejection paths** — force a dedup/importance
  rejection in a test, then verify the index does not contain an entry for the
  rejected content.

### 33. Config Schema-Code Consistency — Schema Minimums Must Honor Documented Disable Values

In PR #399, `semanticDedupCandidates` was documented as "set to 0 to disable"
but the JSON schema had `minimum: 1` and the code clamped to `Math.max(1, ...)`.
Users following docs to disable the feature got silently overridden to minimum 1.

- **When a config value can disable a feature, schema AND code must accept 0** —
  if docs say "set `maxCandidates` to 0 to disable", the JSON schema must set
  `minimum: 0` (not `1`), and the code must handle the `0` case (typically by
  short-circuiting before the operation).
- **Zero-value semantics are a compatibility contract** — `enabled=false` and
  `0` limits are user-facing guarantees. Coercing `0` to `1` violates the
  documented contract silently. Test with the documented disable values.
- **Validate schema against documented behavior in CI** — the `check-config-contract`
  script should flag when a config property's schema `minimum` contradicts the
  documented disable value.

### 34. Template-Derived Regex Safety — Escape Literal Parts Before Building Patterns

In PR #401, `templateMatcher` built a regex from only the prefix (before first
placeholder) and suffix (after last placeholder) of a citation template. When
both were empty (a template consisting of only a placeholder), the resulting
regex matched everything. Additionally, special `$` patterns in regex replacement
strings corrupted citation output.

- **Escape all literal template parts before embedding in regex** — use
  `String.raw` or `escapeRegex()` on prefix/suffix before building the pattern.
  Never assume template parts are regex-safe.
- **Test with empty prefix/suffix** — a template like `{{tag}}` with no surrounding
  literal text must not produce a match-everything regex.
- **Escape `$` in replacement strings** — `String.replace` with a regex treats
  `$'`, `` $` ``, `$&`, `$1`, etc. as special in the replacement string. Use a
  replacement function or escape `$` → `$$` before passing to replace.

### 35. Shared Mutable State Across Connections — No Cross-Session Data Leakage

PR #347 had a single mutable `clientInfo` object shared across all MCP connections.
When one connection set its `clientInfo`, the value bled into all other active
connections. In multi-tenant deployments this is a cross-tenant data leak.

- **Each connection/session must own its mutable state** — if `resolveAdapter()`
  writes to a shared `clientInfo` object, two concurrent connections see each
  other's adapter metadata. Use per-connection instances or deep-copy before
  storing.
- **Shared state is distinct from global singletons** — pattern #5 covers
  singleton scoping by plugin ID. This pattern covers mutable objects shared
  across connections within the same plugin instance. Both are needed.
- **Test with concurrent connections** — create two sessions, set different
  adapter data on each, and verify neither sees the other's data.

### 36. Unsafe Enum Defaults — Missing Values Must Default to Least-Privileged Option

In PRs #344 and #345, a feedback decision enum silently defaulted to
`"approved"` when the value was `undefined` or missing. This means a missing
rejection is treated as approval — a security vulnerability. PR #343 had a
similar issue with `qmdDebug` passing an object instead of a string to a method
that expected a string, silently producing wrong debug output.

- **Enum defaults must be the safest option, not the most convenient** — when
  a decision/status enum value is missing or unrecognized, default to
  `"rejected"`, `"pending"`, `"disabled"`, or `"none"` — never `"approved"`,
  `"enabled"`, or `"active"`.
- **Never silently coerce unexpected types** — if `qmdDebug` receives an object
  where a string is expected, throw or log a warning. Don't silently stringify
  as `[object Object]`.
- **Test with missing/undefined enum values** — every enum parser should have
  test cases for `undefined`, `null`, `""`, and unrecognized string values, and
  each must assert the default is the least-privileged option.

### 37. Duplicate Identifiers in Batch Rename/Move Operations

In PR #392, duplicate rollout slugs caused an ENOENT crash: the first rename
moved the file, then the second rename tried to move the same (now non-existent)
source. When processing batches of file operations, duplicate identifiers in
the input cause the second operation to fail.

- **Deduplicate batch operation inputs before execution** — before processing a
  list of rename/move/delete operations, check for duplicate source or target
  identifiers. Either deduplicate (keep the last) or fail fast with a clear
  error.
- **Verify source exists before each move** — in a batch loop, `statSync` the
  source file before attempting to move it. If it was already moved by a
  duplicate entry, skip or error rather than crashing.
- **Test batch operations with duplicate inputs** — include test cases where
  the input list contains duplicate identifiers and verify the behavior is
  deterministic (not dependent on filesystem ordering).

### 38. CI Pipelines Must Not Silence Test/Type Failures

In PR #349, the Hermes Python CI workflow used patterns that hid test and type
failures, making them invisible to reviewers. Broken tests that passed CI
were caught only by manual review.

- **Never use `|| true` on test/type-check commands in CI** — if `pytest`,
  `mypy`, `tsc`, or equivalent commands fail, the CI step MUST fail. Silencing
  failures with `|| true` or missing `set -e` means broken code passes CI.
- **Each language's quality gate must be a separate CI step** — don't bundle
  `ruff check && mypy && pytest` into a single script with `set -e` at the top
  and then call it with `|| true`. Make each a distinct step so failures are
  visible in the CI UI.
- **Audit CI workflows for failure suppression** — grep all workflow files for
  `|| true`, `continue-on-error: true`, and missing `set -e` in shell scripts.
  These should only exist on intentional tolerance (like cleanup steps), never
  on quality gates.

### 39. Silent Acceptance of Invalid User Input — Reject Instead of Reinterpreting

PR #396 had 10+ instances where invalid CLI flags (`--format jsno`), MCP
parameters, briefing window tokens, and format values silently fell back to
defaults instead of being rejected. While pattern #1 covers CLI flag validation,
this pattern addresses the broader issue of accept-then-default behavior in
ALL input surfaces (CLI, MCP, config, API).

- **Invalid values must be rejected, not silently reinterpreted** — when
  `--format jsno` is provided, throw an error listing valid formats. Don't
  silently fall back to `config.briefing.defaultFormat`. The user explicitly
  chose a value; ignoring it hides configuration mistakes.
- **MCP/API surfaces must validate exactly like CLI surfaces** — when a tool
  parameter is invalid, return a clear error, not a result computed with
  default values. MCP callers (agents) cannot tell the difference between a
  valid response and a silently-defaulted response.
- **Missing flag arguments must fail, not default** — `--since` with no value
  must error, not fall back to `config.briefing.defaultWindow`. The user's
  intent is ambiguous, not "use the default".
- **Briefing window tokens must reject unrecognized values** — when `since`
  contains `garbage`, don't silently fall back to `yesterday`. The caller
  should know their input was invalid.

### 40. Validator-Implementation Consistency — Schemas Must Match Code Paths

PR #396 had 3 instances where validation accepted values that downstream code
never handled. `BRIEFING_FORMAT_ALLOWED` included `"text"` but the format
resolution only handled `"markdown"` and `"json"`. Dead switch cases after
name normalization. Legacy tool schemas inheriting updated descriptions.

- **Validation allow-lists must exactly match handled values** — if a format
  validator accepts `"text"`, `"markdown"`, and `"json"`, the downstream code
  must handle ALL three. Any value accepted by validation but unhandled in
  code produces undefined behavior (typically silent fallthrough to default).
- **Dead switch cases after normalization must be removed** — if tool names
  are normalized from `remnic.*` to `engram.*`, a `case "remnic.briefing":`
  branch is dead code that can never match. Remove it rather than leaving it
  to silently never execute.
- **Legacy wrappers must override ALL inherited fields, not just names** —
  when creating a legacy tool schema from a primary schema, override both
  `name` AND `description`. Otherwise the legacy tool advertises the new
  branding in its description while using the old name, confusing clients.
- **Test that every accepted value produces correct behavior** — for each
  value in an allow-list, write a test that passes it through the full
  pipeline and verifies the output matches the expected behavior for that
  specific value.

### 41. Exhaustive Status/State Filtering — Cover All Non-Active States

PR #396 had 3 instances where status-based filters only checked some non-active
states (e.g., filtering `superseded` and `archived` but not `quarantined`,
`rejected`, or `pending_review`). Incomplete filtering causes stale, rejected,
or quarantined data to appear in user-facing outputs like briefings.

- **When filtering by status, enumerate ALL non-active states** — if a filter
  excludes `superseded` and `archived`, it must also exclude `quarantined`,
  `rejected`, and `pending_review` unless explicitly intended. Use an
  `isActive` helper that checks a single set, not an ad-hoc exclusion list.
- **Define the "active" set explicitly, not the "inactive" set** — rather
  than listing states to exclude, define the states to include:
  `if (!ACTIVE_STATUSES.includes(memory.status)) continue;`. This prevents
  new states from accidentally flowing through.
- **Test with every known status value** — create a test fixture with memories
  in each known status and verify the filter produces the correct subset.
- **When adding a new status, update ALL filters** — grep for every status
  filter in the codebase and add the new status to the appropriate inclusion
  or exclusion set.

### 42. Non-Atomic File Replace — Write New Before Deleting Old

PR #394 had 2 instances where code deleted an existing file/directory before
writing the replacement. If the write fails after the delete succeeds (e.g.,
permissions, disk full, cross-device rename), the old data is permanently
lost with no recovery path.

- **Never `rmSync` then `renameSync` — use the reverse order** — write the
  new content to a temp location first, then rename it over the target. On
  most filesystems, `renameSync` is atomic, so the target always exists in
  a valid state. If the write to temp fails, the original remains intact.
- **Backup before destructive operations** — when replacing a config file,
  copy the old content to a `.bak` file first. If the new write fails,
  restore from backup. Clean up the backup after confirming success.
- **Verify write success before cleanup** — if you must delete old data
  (e.g., removing a temp directory after successful rename), verify the
  rename succeeded before cleaning up the source. `renameSync` can fail on
  cross-device moves.
- **Test the failure path** — mock `renameSync` to throw after `rmSync`
  succeeds and verify the error is handled and data is recoverable.

### 44. À-la-carte Packaging — Optional Packages Must Stay Optional at Every Layer

Remnic ships as a family of composable packages. The architectural contract
is that users install only what they use: `@remnic/core` alone, core plus
`@remnic/plugin-openclaw`, core plus `@remnic/export-weclone`, or all three.
A PR that forces an optional package into a base install surface breaks
this contract even if every test passes, because the breakage only shows
up at npm-install time for someone who didn't want that optional surface.

- **Load optional packages via computed-specifier dynamic imports.** Never
  do `import { X } from "@remnic/bench"` in a base install surface (CLI,
  core, plugin-openclaw). Use `await import("@remnic/" + "bench")` so the
  bundler cannot statically resolve the module and pull it into the bundle.
  Wrap in a loader helper (`loadBenchModule()`) that throws a user-facing
  install hint on miss. Canonical patterns:
  `packages/remnic-cli/src/optional-bench.ts`,
  `packages/remnic-cli/src/optional-weclone-export.ts`,
  `packages/remnic-core/src/cli.ts:ensureBuiltInBulkImportAdapters`.
- **Declare as optional peer deps, not `dependencies`.** Optional companions
  go under `peerDependencies` with `peerDependenciesMeta.<name>.optional =
  true`. If you put them under `dependencies`, npm install of the base
  package pulls them in and the à-la-carte model is gone.
- **Never add to `noExternal`.** `packages/remnic-cli/tsup.config.ts` must
  `external` any optional package (or simply omit it from `noExternal`). A
  past regression listed `@remnic/bench` and `@remnic/export-weclone` under
  `noExternal`, which bundled them into every CLI install even for users
  who never ran `remnic bench *`.
- **Publish every surface users are told to install.** Any package that
  docs, error messages, or install hints mention must actually exist on
  npm. Keeping a package `"private": true` while recommending it in a CLI
  install hint is a bug — ship it (update
  `.github/workflows/release-and-publish.yml PUBLISH_ORDER`) or stop
  recommending it.
- **Verify both paths end to end.** When you touch tsup configs, optional-
  loader modules, or the publish workflow, verify that:
  1. `npm install @remnic/cli` succeeds without the optional packages.
  2. Running an optional command without the package throws the install
     hint — not a raw `MODULE_NOT_FOUND`.
  3. Installing the optional package and rerunning the command works.

### 43. Documentation-Code Contract — Documented Behavior Must Be Implemented

PRs #397 and #398 had 3 instances where documentation claimed behavior that
the code didn't implement. Docs said `remnic.timeout` applied to daemon calls
but the provider never forwarded the timeout parameter. A publish workflow
allowed dispatching from any branch without branch protection.

- **Every documented behavior must have a corresponding test** — if docs
  say "timeout is applied to all daemon calls", write a test that verifies
  the timeout parameter reaches the daemon client constructor. Without a
  test, documentation drifts from implementation silently.
- **CI workflows must validate their trigger constraints** — if a publish
  workflow should only run on `main`, add `if: github.ref == 'refs/heads/main'`
  to the job, not just to the trigger. Manual `workflow_dispatch` can target
  any branch, bypassing branch-only triggers.
- **When adding a config property, wire it end-to-end** — adding `timeout`
  to the config schema but not passing it through the provider to the client
  means users set a value that has no effect. The `check-config-contract`
  script should flag config properties that are defined in the schema but
  never read in code.
- **Test that documented config properties are consumed** — for each config
  property in the schema, write a test that sets it and verifies it affects
  the documented behavior. Missing tests mean the property may be silently
  ignored.

---

## What This Project Does (Simple Explanation)

Remnic gives AI agents long-term memory that persists across conversations.

## PR Hardening Rule (All Agents)

If you touch retrieval/planner/cache/config logic, you must run the hardening gate in:
`docs/ops/pr-review-hardening-playbook.md`

This is mandatory before claiming a PR is review-clean.

## Retrieval/Intent/Cache Guardrails (All Agents)

Treat these as non-negotiable engineering constraints for this plugin:

1. Recall pipeline order is a contract:
   - retrieve candidate headroom
   - apply policy filters (namespace/status/path/type)
   - rerank/boost
   - cap to user-facing budget
   - format and inject
   Never cap before final filtering for the section users consume.

2. Artifact isolation:
   Artifacts must flow only through the dedicated verbatim-artifact path.
   Generic QMD/embedding memory recall must exclude `artifacts/` paths.

3. Planner mode semantics:
   `no_recall`, `minimal`, `full`, and `graph_mode` are behavioral contracts.
   - each mode must be reachable
   - `no_recall` must gate all fallback paths
   - `minimal` must actually cap retrieval size

4. Config is runtime API:
   `enabled=false` and `0` limits are compatibility guarantees, not hints.
   Never coerce `0` to non-zero. Keep write-time/read-time behavior symmetric.

5. Intent heuristics must be morphology-aware and precedence-tested:
   Regex-based intent extraction must handle common conjugations/variants and avoid accidental mismatches.
   Add tests for representative natural language variants, not only base forms.

6. Cache invariants:
   - cache versions must be shared per memory directory when multiple instances can read/write
   - cache timestamps must reflect rebuild completion time
   - cache must persist negative lookups where useful (e.g., missing IDs) to avoid rebuild loops
   - concurrent writes during rebuild must not publish stale snapshots

7. Fallback parity:
   Any retrieval-policy rule applied in primary search must be mirrored in fallback search paths.

## Mandatory Test Updates For Subsystem Changes

If you change `src/orchestrator.ts`, `src/storage.ts`, or `src/intent.ts`, include/adjust tests for all impacted invariants:

- planner reachability and gating
- zero-limit semantics
- cap-after-filter behavior
- artifact-path isolation
- cache coherence across instances and concurrent writes
- heuristic variant coverage (intent phrases/conjugations)

Think of it like a personal assistant who:
- Remembers everything you've told them
- Learns your preferences and patterns
- Can recall relevant context when you ask about something
- Never forgets, but updates outdated information

## Why This Exists

Without memory, every conversation starts fresh. Agents forget:
- Your name and preferences
- Previous decisions and context
- Projects you're working on
- People and companies you've mentioned

With Engram:
- Agents recall relevant context automatically
- Profile captures your preferences
- Facts, entities, and relationships are tracked
- Contradictions are detected and resolved

## How It Fits Into OpenClaw

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    Agent Turn                        │    │
│  │                                                      │    │
│  │   1. User sends prompt                               │    │
│  │              ↓                                       │    │
│  │   2. ENGRAM: Recall relevant memories (→ inject)     │    │
│  │              ↓                                       │    │
│  │   3. Agent processes (with memory context)           │    │
│  │              ↓                                       │    │
│  │   4. ENGRAM: Buffer turn for extraction              │    │
│  │              ↓                                       │    │
│  │   5. (Periodically) Run extraction → persist         │    │
│  │                                                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────────────────┐    │
│  │    Engram       │    │       Storage               │    │
│  │  Orchestrator   │◄──►│  facts/ entities/ profile   │    │
│  └────────┬────────┘    └─────────────────────────────┘    │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐    ┌─────────────────────────────┐    │
│  │    GPT-5.2      │    │         QMD                 │    │
│  │  (extraction)   │    │  (search: BM25 + vector)    │    │
│  └─────────────────┘    └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

The plugin:
1. **Injects memory** - On `before_prompt_build`, searches for relevant memories and adds to the system prompt
2. **Buffers turns** - On `agent_end`, captures the user/assistant exchange
3. **Extracts facts** - Uses GPT-5.2 to extract facts, entities, and profile updates
4. **Stores memories** - Persists to markdown files with YAML frontmatter
5. **Consolidates** - Periodically merges, updates, and cleans memories

## Key Concepts

### 1. Memory Types

| Type | What It Is | Storage Location |
|------|------------|------------------|
| **Fact** | A single piece of information | `facts/{date}/` |
| **Entity** | A person, place, company, or project | `entities/` |
| **Profile** | User preferences and patterns | `profile.md` |
| **Correction** | Explicit correction of a fact | `corrections/` |
| **Question** | Curiosity questions for follow-up | `questions/` |

### 2. Fact Categories

Facts are categorized by type:

| Category | Examples |
|----------|----------|
| `fact` | "OpenClaw runs on port 3000" |
| `decision` | "We decided to use PostgreSQL" |
| `preference` | "User prefers dark mode" |
| `commitment` | "I will review the PR by Friday" |
| `relationship` | "Alice works with Bob on Project X" |
| `principle` | "Always write tests before code" |
| `moment` | "Today we launched v2.0" |
| `skill` | "User knows Python and TypeScript" |

### 3. The Recall Flow

When an agent starts processing a prompt:

```
User Prompt: "What was that API rate limit issue?"
        │
        ▼
┌───────────────────┐
│   QMD Search      │ ← Hybrid search (BM25 + vector + reranking)
│   (prompt text)   │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│   Boost Results   │ ← Recency, access count, importance
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  Format Context   │ ← Profile + memories + questions
└────────┬──────────┘
         │
         ▼
Injected into system prompt:
"## Memory Context (Engram)

## User Profile
- Prefers concise responses
- Works at Company X

## Relevant Memories
[1] /facts/2026-02-01/fact-123.md (score: 0.85)
API rate limit is 1000 requests per minute..."
```

### 4. The Extraction Flow

After an agent completes a turn:

```
Agent Turn Complete
        │
        ▼
┌───────────────────┐
│  Buffer Turn      │ ← Add to smart buffer
└────────┬──────────┘
         │
    (Buffer full or forced flush?)
         │
         ▼
┌───────────────────┐
│   GPT-5.2         │ ← Extract facts, entities, profile
│   Extraction      │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  Persist to       │ ← Write markdown files
│  Storage          │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  QMD Update       │ ← Re-index for search
└─────────────────── ┘
```

### 5. Consolidation

Periodically (every N extractions), the plugin:

1. **Merges duplicates** - Combines redundant facts
2. **Invalidates stale** - Marks outdated info as superseded
3. **Updates entities** - Merges fragmented entity files
4. **Cleans expired** - Removes fulfilled commitments, TTL-expired facts
5. **Summarizes** - Compresses old memories into summaries
6. **Consolidates profile** - Keeps profile.md under 600 lines

## File Structure

The codebase is a monorepo. Core logic lives in `packages/remnic-core/`;
host adapters and CLI live in sibling packages.

```
packages/
├── remnic-core/           # Core memory engine (primary source)
├── remnic-cli/            # CLI tooling
├── remnic-server/         # Server runtime
├── plugin-openclaw/       # OpenClaw host adapter
├── plugin-claude-code/    # Claude Code host adapter
├── plugin-codex/          # Codex host adapter
├── plugin-hermes/         # Hermes host adapter
├── hermes-provider/       # Hermes provider integration
├── connector-replit/      # Replit connector
├── shim-openclaw-engram/  # Legacy engram shim
└── bench/                 # Benchmarks

packages/remnic-core/src/
│
│  ── Core pipeline ──────────────────────────────────
├── index.ts               # Plugin entry, hook registration
├── config.ts              # Config parsing with defaults
├── types.ts               # TypeScript interfaces
├── logger.ts              # Logging wrapper
├── orchestrator.ts        # Core memory coordination
├── storage.ts             # File I/O for memories
├── buffer.ts              # Smart turn buffering
├── extraction.ts          # GPT-5.2 extraction engine
├── qmd.ts                 # QMD search client
├── importance.ts          # Importance scoring
├── chunking.ts            # Large content chunking
├── threading.ts           # Conversation threading
├── topics.ts              # Topic extraction
├── tools.ts               # Agent tools
├── cli.ts                 # CLI commands
│
│  ── Recall & retrieval ─────────────────────────────
├── retrieval.ts           # Recall pipeline implementation
├── intent.ts              # Intent heuristics (morphology-aware)
├── signal.ts              # Signal-based flush triggers
├── recall-qos.ts          # Recall quality-of-service
├── recall-mmr.ts          # Maximal marginal relevance
├── recall-query-policy.ts # Query rewrite policy
├── recall-audit.ts        # Recall audit trail
├── qmd-recall-cache.ts    # QMD recall caching
├── rerank.ts              # Re-ranking pipeline
├── harmonic-retrieval.ts  # Harmonic retrieval scoring
├── verified-recall.ts     # Verified recall checks
│
│  ── Classification & scoring ───────────────────────
├── himem.ts               # Episode/Note classification (v8.0)
├── boxes.ts               # Memory Box builder + Trace Weaver (v8.0)
├── extraction-judge.ts    # LLM-as-judge fact-worthiness gate (#376)
├── semantic-chunking.ts   # Topic-boundary chunking (#368)
├── source-attribution.ts  # Citation/attribution helpers (#379)
├── relevance.ts           # Relevance scoring
├── calibration.ts         # Score calibration
│
│  ── Versioning & lifecycle ─────────────────────────
├── page-versioning.ts     # Snapshot-based version history (#371)
├── lifecycle.ts           # Memory lifecycle management
├── temporal-supersession.ts # Temporal supersession logic
├── temporal-index.ts      # Temporal indexing
│
│  ── Session & context ──────────────────────────────
├── session-integrity.ts   # Session integrity checks
├── session-toggles.ts     # Per-session feature toggles
├── session-observer-bands.ts # Observer band system
├── session-observer-state.ts # Observer state tracking
├── profiling.ts           # User profiling
├── identity-continuity.ts # Identity continuity
│
│  ── Causal reasoning ───────────────────────────────
├── causal-chain.ts        # Causal chain tracking
├── causal-behavior.ts     # Behavioral causal signals
├── causal-retrieval.ts    # Causal-aware retrieval
├── causal-consolidation.ts # Causal consolidation
├── causal-trajectory.ts   # Trajectory tracking
├── causal-trajectory-graph.ts # Trajectory graph
│
│  ── Graph & dashboard ──────────────────────────────
├── graph.ts               # Knowledge graph
├── tmt.ts                 # Tree-of-memory-traces
├── graph-dashboard-*.ts   # Dashboard rendering (diff, key, parser)
├── abstraction-nodes.ts   # Abstraction node system
│
│  ── Access & MCP ───────────────────────────────────
├── access-mcp.ts          # MCP access provider
├── access-cli.ts          # CLI access provider
├── access-http.ts         # HTTP access provider
├── access-service.ts      # Access service coordinator
├── access-schema.ts       # Access schema definitions
├── access-idempotency.ts  # Idempotent access operations
│
│  ── Utilities & support ────────────────────────────
├── sanitize.ts            # Content sanitization
├── tokens.ts              # Token counting
├── json-extract.ts        # JSON extraction helpers
├── json-store.ts          # JSON-backed storage
├── whitespace.ts          # Whitespace handling
├── bootstrap.ts           # Bootstrap/init routines
├── model-registry.ts      # LLM model registry
├── fallback-llm.ts        # LLM fallback routing
├── local-llm.ts           # Local LLM integration
│
│  ── Subdirectories ─────────────────────────────────
├── enrichment/            # External enrichment pipeline (#365)
├── binary-lifecycle/      # Binary file management (#367)
├── taxonomy/              # MECE taxonomy resolver (#366)
├── memory-extension/      # Extension publisher contract (#381, #382)
├── memory-extension-host/ # Extension host discovery (#381)
├── compat/                # Provider compatibility checks
├── adapters/              # Host adapter interfaces
├── connectors/            # External service connectors
├── conversation-index/    # Conversation indexing
├── compounding/           # Compounding memory logic
├── curation/              # Memory curation pipeline
├── dedup/                 # Deduplication engine
├── lcm/                   # Lifecycle management
├── maintenance/           # Maintenance tasks
├── migrate/               # Migration scripts
├── namespaces/            # Multi-tenant namespace logic
├── network/               # Network transport layer
├── onboarding/            # Onboarding flows
├── projection/            # Memory projections
├── replay/                # Replay/debug tooling
├── review/                # Review pipeline
├── routing/               # Routing logic
├── runtime/               # Runtime services
├── search/                # Search subsystem
├── shared-context/        # Shared context management
├── spaces/                # Memory spaces
├── surfaces/              # Surface adapters
├── sync/                  # Sync engine
├── transfer/              # Data transfer utilities
├── utils/                 # Shared utility functions
└── work/                  # Work-product tracking

~/.openclaw/workspace/memory/local/
├── profile.md             # User profile
├── facts/                 # Daily fact directories
│   ├── 2026-02-01/
│   │   ├── fact-123.md
│   │   └── decision-456.md
│   └── 2026-02-07/
│       └── ...
├── entities/              # Entity files
│   ├── person-joshua-warren.md
│   ├── company-creatuity.md
│   └── project-openclaw.md
├── corrections/           # Explicit corrections
├── questions/             # Curiosity questions
├── summaries/             # Compressed old memories
└── state/
    ├── buffer.json        # Current buffer state
    └── meta.json          # Extraction counters
```

### Memory File Format

Facts and entities use markdown with YAML frontmatter:

```markdown
---
id: fact-1770469224307-eelr
category: decision
confidence: 0.85
created: 2026-02-07T10:00:00Z
updated: 2026-02-07T10:00:00Z
tags:
  - architecture
  - database
entityRef: project-openclaw
importance:
  score: 0.7
  reason: architectural decision
status: active
---

We decided to use PostgreSQL for the main database because it handles JSON well and has excellent extension support.
```

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "openclaw-engram": {
      "openaiApiKey": "${OPENAI_API_KEY}",
      "memoryDir": "~/.openclaw/workspace/memory/local",
      "workspaceDir": "~/.openclaw/workspace",
      "qmdEnabled": true,
      "qmdCollection": "openclaw-engram",
      "consolidateEveryN": 10,
      "maxMemoryTokens": 2000,
      "debug": false
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `openaiApiKey` | string | env var | Optional OpenAI API key for direct-client paths; local/gateway fallback can run without it |
| `memoryDir` | string | see above | Where to store memories |
| `workspaceDir` | string | see above | Workspace root |
| `qmdEnabled` | boolean | `true` | Enable QMD search |
| `qmdCollection` | string | `"openclaw-engram"` | QMD collection name |
| `qmdMaxResults` | number | `10` | Max search results |
| `consolidateEveryN` | number | `10` | Consolidate every N extractions |
| `maxMemoryTokens` | number | `2000` | Max tokens in context injection |
| `identityEnabled` | boolean | `true` | Enable identity reflections |
| `injectQuestions` | boolean | `false` | Inject curiosity questions |
| `commitmentDecayDays` | number | `90` | Days before expired commitments are cleaned |
| `debug` | boolean | `false` | Enable verbose logging |

## Hooks Used

### gateway_start

Initialize the memory system on gateway startup.

```typescript
api.on("gateway_start", async () => {
  await orchestrator.initialize();
  // - Ensure directories exist
  // - Load entity aliases
  // - Probe QMD availability
  // - Load buffer state
});
```

### before_prompt_build

Inject memory context into the agent's system prompt.

```typescript
api.on("before_prompt_build", async (event, ctx) => {
  const prompt = event.prompt;
  const context = await orchestrator.recall(prompt);

  if (context) {
    return {
      prependSystemContext: `## Memory Context (Remnic)\n\n${context}`
    };
  }
});
```

### agent_end

Buffer the completed turn for later extraction.

```typescript
api.on("agent_end", async (event, ctx) => {
  if (!event.success) return;

  const messages = event.messages;
  const lastTurn = extractLastTurn(messages);

  for (const msg of lastTurn) {
    const cleaned = cleanUserMessage(msg.content);
    await orchestrator.processTurn(msg.role, cleaned, ctx.sessionKey);
  }
});
```

## The Orchestrator

The `Orchestrator` class is the heart of Engram:

### Key Methods

| Method | Purpose |
|--------|---------|
| `initialize()` | Set up storage, load aliases, probe QMD |
| `recall(prompt)` | Search and format memory context |
| `processTurn(role, content, sessionKey)` | Buffer a turn, maybe trigger extraction |
| `runExtraction(turns)` | Call GPT-5.2, persist results |
| `runConsolidation()` | Merge, update, clean memories |

### Subsystems

| Subsystem | Responsibility |
|-----------|----------------|
| `SmartBuffer` | Decides when to flush and extract |
| `ExtractionEngine` | GPT-5.2 prompts for extraction/consolidation |
| `StorageManager` | Read/write markdown files |
| `QmdClient` | Search via QMD CLI |
| `ThreadingManager` | Group memories by conversation thread |

## Common Tasks

### Manually Triggering Extraction

```bash
openclaw engram flush
```

### Searching Memories

```bash
openclaw engram search "API rate limit"
```

### Viewing Profile

```bash
cat ~/.openclaw/workspace/memory/local/profile.md
```

### Re-indexing QMD

```bash
qmd update openclaw-engram
qmd embed openclaw-engram
```

### Viewing Statistics

```bash
openclaw engram stats
```

## Footguns (Common Mistakes)

### 1. No OpenAI API Key

**Symptom**: Extraction never runs, no new memories.

**Cause**: API key not configured or not in gateway's environment.

**Fix**: Add to launchd plist:
```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENAI_API_KEY</key>
  <string>sk-...</string>
</dict>
```

### 2. QMD Not Available

**Symptom**: "QMD: not available" in logs, fallback to recent memories only.

**Cause**: `qmd` command not in PATH or not installed.

**Fix**: Install QMD and ensure it's in the gateway's PATH.

### 3. Profile Too Large

**Symptom**: Slow recall, context truncation.

**Cause**: profile.md exceeded recommended size.

**Fix**: The plugin auto-consolidates at 600 lines. You can also manually edit profile.md.

### 4. Stale QMD Index

**Symptom**: New memories not found in search.

**Cause**: QMD index not updated after extraction.

**Fix**: Run `qmd update <collection>` and `qmd embed <collection>`.

### 5. Memory Context Not Appearing

**Symptom**: Agents don't seem to know previous context.

**Cause**:
- Prompt too short (< 5 chars)
- No matching memories found
- Context trimmed due to token limit

**Fix**: Check debug logs, increase `maxMemoryTokens`.

### 6. Optional Fields in Zod Schemas

**Symptom**: OpenAI API rejects schemas with "optional" fields.

**Cause**: OpenAI Responses API requires `.optional().nullable()`, not just `.optional()`.

**Fix**: Always use `.optional().nullable()` for optional fields in Zod schemas passed to `zodTextFormat`.

### 7. Message Cleaning Not Working

**Symptom**: System metadata pollutes memories.

**Cause**: User messages contain injected context that wasn't cleaned.

**Fix**: The `cleanUserMessage()` function removes common patterns. Add new patterns if needed.

### 8. Entity Name Fragmentation

**Symptom**: Multiple entity files for the same person/project (e.g., "Josh", "Joshua", "Joshua Warren").

**Cause**: LLM used different name variants.

**Fix**: Add aliases to `storage.ts:normalizeEntityName()` function. Consolidation merges automatically.

## Testing Changes

```bash
# Build the plugin
cd ~/.openclaw/extensions/openclaw-engram
npm run build

# Full gateway restart (gateway_start hook needs this)
launchctl kickstart -k gui/501/ai.openclaw.gateway

# Or for hot reload (but gateway_start won't fire)
kill -USR1 $(pgrep openclaw-gateway)

# Trigger a conversation to test

# Check logs
grep "\[engram\]" ~/.openclaw/logs/gateway.log

# View extraction results
ls -la ~/.openclaw/workspace/memory/local/facts/$(date +%Y-%m-%d)/
```

## Debug Mode

Enable in `openclaw.json`:
```json
{
  "plugins": {
    "openclaw-engram": {
      "debug": true
    }
  }
}
```

This logs:
- Recall search results
- Buffer decisions
- Extraction prompts and results
- Consolidation actions
- QMD operations

## Advanced Features

### Access Tracking

Memories track how often they're accessed:
- `accessCount` increments on each recall
- `lastAccessed` timestamp updated
- Used for boosting frequently-accessed memories

### Importance Scoring

Each memory gets an importance score (0-1):
- Based on category, tags, and content patterns
- Higher importance = higher search ranking
- Protected from summarization

### Contradiction Detection

When a new fact conflicts with an existing one:
1. QMD finds similar memories
2. GPT-5.2 verifies contradiction
3. Old memory marked as superseded
4. Link created between old and new

### Memory Linking

Related memories are linked:
- `supports` - Provides evidence for
- `contradicts` - Conflicts with
- `elaborates` - Adds detail to
- `causes` / `caused_by` - Causal relationship

### Summarization

Old, low-importance memories are summarized:
- Triggered when memory count exceeds threshold
- Creates summary files with key facts
- Archives original memories
- Preserves important and entity-linked memories

## PUBLIC REPOSITORY — Privacy Policy

**This repository is PUBLIC on GitHub.** Every commit is visible to the world.

### Rules for ALL agents committing to this repo:

1. **NEVER commit personal data** — no names, emails, addresses, phone numbers, account IDs, or user identifiers
2. **NEVER commit API keys, tokens, or secrets** — even in comments or examples
3. **NEVER commit memory content** — the `facts/`, `entities/`, `corrections/`, `questions/`, `state/` directories contain user memories and must NEVER be committed
4. **NEVER commit IDENTITY.md or profile.md** — these contain personal behavioral profiles
5. **NEVER commit `.env` files** or any file containing credentials
6. **NEVER reference specific users, their preferences, or their data** in code comments or commit messages
7. **Config examples must use placeholders** — `${OPENAI_API_KEY}`, not actual keys
8. **Test data must be synthetic** — never use real conversation data in tests

### What IS safe to commit:
- Source code (`src/`, `scripts/`)
- Package manifests (`package.json`, `tsconfig.json`, `tsup.config.ts`)
- Plugin manifest (`openclaw.plugin.json`)
- Documentation (`README.md`)
- Build configuration
- `.gitignore`

### Before every commit, verify:
- `git diff --cached` contains NO personal information
- No hardcoded API keys, URLs with tokens, or credentials
- No references to specific users or their data

### Issues, PRs, and review comments are public too

The rules above apply to EVERYTHING pushed to GitHub, not just commits — issue
bodies, PR descriptions, review replies, and commit messages.

1. **No PII or operator-specific details** in issue/PR text: hostnames, internal
   IPs/subnets/VIP addresses, usernames or home-directory paths, client or
   project names, memory IDs, quoted memory content, or links/paths to an
   operator's private repos and docs.
2. **Describe the deployment *shape*, not the deployment** — state the config
   conditions that reproduce the behavior (e.g. "namespaces enabled, default
   namespace at the flat root, ~100k-file base collection"), never "on <host>".
   Round counts, strip identifying values from quoted logs/output, and replace
   concrete examples with placeholders or synthetic equivalents.
3. **Generalize the problem statement** — an issue must describe a defect or
   gap as it affects ANY user who meets the reproducing conditions, and
   proposed fixes must be designed for all use cases, not one operator's
   workflow. If a report only makes sense for a single deployment, it belongs
   in that operator's private notes, with a distilled general issue filed here.
4. **Audit before submitting**: re-read the issue/PR body the way a stranger
   would. `gh issue view <n> --json body` piped through a grep for your hosts,
   IPs, usernames, and org/client names is cheap — run it before and after
   posting.

## Agent Notes: Retrieval Explain Surface (issues #518, #570)

Two adjacent surfaces with similar names — both shipped on main. Do not
conflate them:

1. **`recall/explain`** (graph-path, shipped) — `POST
   /engram/v1/recall/explain` / `engram.recall_explain` MCP tool /
   `EngramAccessService.recallExplain()`. Returns a graph-path
   explanation *document* ("why these memories?" for the graph
   subsystem). Markdown formatting delegates to the shared
   `recall-explain-renderer.ts` so CLI / HTTP / MCP stay in sync.

2. **Recall xray / tier explain** (#570, shipped) — `GET
   /engram/v1/recall/xray` / `engram.recall_xray` MCP tool / `remnic
   xray` CLI / `EngramAccessService.recallXray()`. Returns a
   *structured per-result annotation* of which retrieval tier served
   the query (`direct-answer`, `hybrid`, etc.). Attached to
   `LastRecallSnapshot.tierExplain` only when
   `recallDirectAnswerEnabled: true`.

On-disk modules (all shipped):

- `packages/remnic-core/src/direct-answer.ts` — pure eligibility
  function over caller-resolved `DirectAnswerCandidate`s.
- `packages/remnic-core/src/direct-answer-wiring.ts` — source-agnostic
  `tryDirectAnswer(...)` binding invoked by the orchestrator.
- `packages/remnic-core/src/recall-xray.ts`,
  `recall-xray-renderer.ts`, `recall-xray-cli.ts` — tier-explain core,
  shared renderer, and CLI surface.
- `packages/remnic-core/src/recall-explain-renderer.ts` — shared
  markdown renderer for the legacy graph-path `/recall/explain`
  surface.
- `packages/remnic-core/src/types.ts` — `RecallTierExplain` interface,
  attached to `LastRecallSnapshot` via `recall-state.ts`.

Rule 22 applies: never fork formatting — extend the renderers. If a
shared `abort-error.ts` module is later introduced, migrate the
private `throwIfAborted(signal)` helper in `direct-answer-wiring.ts`
rather than re-implementing it per call site.

---

## Architecture and operational notes (restored from former CLAUDE.md)

These sections were unique to the former CLAUDE.md and are preserved here as the canonical AGENTS.md is the single source (CLAUDE.md is now a symlink).

## Architecture Notes

### File Structure
```
packages/remnic-core/src/
│
│ ── Core lifecycle ──────────────────────────────────────
├── index.ts                    # Plugin entry point, hook registration
├── config.ts                   # Config parsing with defaults
├── types.ts                    # TypeScript interfaces
├── logger.ts                   # Logging wrapper
├── orchestrator.ts             # Core memory coordination
├── storage.ts                  # File I/O for memories
├── buffer.ts                   # Smart turn buffering
├── lifecycle.ts                # Session and service lifecycle management
├── bootstrap.ts                # Plugin bootstrap / init sequence
│
│ ── Extraction & scoring ────────────────────────────────
├── extraction.ts               # GPT-5.2 extraction engine
├── extraction-judge.ts         # LLM-as-judge fact-worthiness gate
├── importance.ts               # Importance scoring
├── calibration.ts              # Score calibration helpers
├── topics.ts                   # Topic extraction
│
│ ── Chunking & storage format ───────────────────────────
├── chunking.ts                 # Recursive large-content chunking
├── semantic-chunking.ts        # Topic-boundary chunking (embedding-based)
├── page-versioning.ts          # Snapshot-based version history for memory files
├── citations.ts                # OAI-mem-citation block generation
│
│ ── Recall & retrieval ──────────────────────────────────
├── qmd.ts                      # QMD search client
├── qmd-recall-cache.ts         # Recall result caching
├── retrieval.ts                # Primary retrieval orchestration
├── recall-audit.ts             # Recall audit trail
├── recall-mmr.ts               # Maximal marginal relevance diversification
├── recall-qos.ts               # Recall quality-of-service enforcement
├── recall-query-policy.ts      # Query rewriting / policy
├── recall-state.ts             # Recall state tracking
├── rerank.ts                   # Result reranking
├── source-attribution.ts       # Source attribution for recalled facts
│
│ ── Dedup & consolidation ───────────────────────────────
├── dedup/                      # Semantic deduplication pipeline
├── semantic-consolidation.ts   # Embedding-aware memory merging
├── summarizer.ts               # Summary generation
├── summary-snapshot.ts         # Point-in-time summary snapshots
│
│ ── Taxonomy & classification ───────────────────────────
├── taxonomy/                   # MECE taxonomy resolver, loader, defaults
├── entity-retrieval.ts         # Entity-aware retrieval
├── entity-schema.ts            # Entity type definitions
│
│ ── Extensions & publishers ─────────────────────────────
├── memory-extension/           # Third-party extension discovery + publishers
├── memory-extension-host/      # Host-side extension rendering + discovery
│
│ ── Enrichment ──────────────────────────────────────────
├── enrichment/                 # External enrichment pipeline, provider registry
│
│ ── Binary lifecycle ────────────────────────────────────
├── binary-lifecycle/           # Mirror/redirect/clean pipeline for binary files
│
│ ── Wearables ───────────────────────────────────────────
├── wearables/                  # Wearable transcript ingestion: connector registry, cleanup, redaction, corrections, speaker registry, day store, trust-gated memory gen
│
│ ── Access surfaces ─────────────────────────────────────
├── cli.ts                      # CLI commands
├── access-mcp.ts               # MCP server surface
├── access-http.ts              # HTTP API surface
├── access-cli.ts               # CLI access helpers
├── surfaces/                   # Heartbeat, dreams, and other surface integrations
│
│ ── Maintenance & governance ────────────────────────────
├── maintenance/                # Governance crons, archive, backup, observation ledger
├── hygiene.ts                  # Memory hygiene checks
├── memory-cache.ts             # Multi-layer memory cache
│
│ ── Compatibility & migration ───────────────────────────
├── compat/                     # Provider compatibility checks (Codex, etc.)
├── migrate/                    # Legacy data migration utilities
├── sdk-compat.ts               # SDK compatibility shims
│
│ ── Session & threading ─────────────────────────────────
├── threading.ts                # Conversation threading
├── session-integrity.ts        # Session identity validation
├── session-toggles.ts          # Per-session feature toggles
├── namespaces/                 # Multi-tenant namespace resolution
│
│ ── Supporting subsystems ───────────────────────────────
├── routing/                    # Tier and model routing
├── sync/                       # Cross-device sync
├── network/                    # Network transport helpers
├── profiling.ts                # Runtime profiling
├── intent.ts                   # User intent classification
├── tokens.ts                   # Token counting utilities
└── utils/                      # Shared utility functions
```

### Key Patterns

1. **Three-phase flow** — recall (before), buffer (after), extract (periodic)
2. **Smart buffer** — decides when to flush based on content signals
3. **GPT-5.2 for extraction** — uses OpenAI Responses API (NOT Chat Completions)
4. **QMD for search** — hybrid BM25 + vector + reranking
5. **Markdown + YAML frontmatter** — human-readable storage format
6. **Consolidation** — periodic merging, cleaning, and summarization
7. **Extraction judge** — optional LLM-as-judge post-filter evaluates fact durability before writes
8. **Semantic chunking** — sentence-embedding-based topic boundary detection alternative to recursive chunking
9. **Page versioning** — every memory file overwrite saves a numbered snapshot; list/diff/revert via CLI
10. **Citation blocks** — recall responses emit `<oai-mem-citation>` blocks for Codex-compatible attribution
11. **Publisher contract** — pluggable `MemoryExtensionPublisher` interface for host-specific extension installation
12. **MECE taxonomy** — deterministic categorization via mutually exclusive, collectively exhaustive directory
13. **Enrichment pipeline** — importance-tiered external enrichment with provider registry and audit trail
14. **Binary lifecycle** — three-stage mirror/redirect/clean pipeline for binary files in memory directory
15. **Wearable connectors** — à-la-carte `@remnic/connector-limitless|bee|omi` packages feed the shared `src/wearables/` pipeline (pull → cleanup → redaction → corrections → speaker labels → day store → trust-gated memory gen). Day transcripts live at `<memoryDir>/wearables/<source>/<date>.md` — QMD-searchable but outside the memory scan roots. Memory creation defaults to `memoryMode: "review"` (pending_review). See docs/wearables.md
16. **Desktop capture — activity + meetings** — the on-screen counterpart to the wearable pipeline (umbrella #1896). `src/activity/` (#1899) is a host-agnostic core subsystem: `ActivityStore` (SQLite, idempotent on `(machine, captured_at_utc, content_hash)`, atomic base+FTS writes, validated/canonicalized capture timestamps) plus a deterministic day digest rendered to `<memoryDir>/activity/<date>.md` (per-machine dwell, DST-correct `[start, end)` day windows, JSON-encoded frontmatter machine labels). `src/meetings/` (#1900, engine #2122 + surfaces #2123) is a fully-wired host-agnostic core subsystem that retrospectively derives meetings from a day's already-ingested signals: `detectMeetings()` (app-span ∩ audio-window, audio-only, and provider paths; non-overlapping meetings with re-run-stable `mtg-<date>-<hash>` IDs anchored on the exact start instant) → `fuseMeeting()` (reuses the shared wearables `fuseCluster` — never a parallel merger — with `corroboratedBy` and a `contextDwellSeconds`-gated screen-context timeline) → a deterministic markdown record at `<ns>/meetings/<date>/<meeting-id>.md` (idempotent on `contentHash`, outside the memory scan roots, excluded from generic recall by `isGenericRecallExcludedPath`) → `MeetingsBuilder` orchestration over a `MeetingsDaySource` → `createMeetingMemoryGenerator` writing a deterministic recall-anchor episode per record plus trust-gated `summaryMode` (`off`/`review`/`smart`) summary/facts (a judge `reject` drops even in `review` mode). The `meetings.*` config gate parses and validates (see docs/config-reference.md), defaulting off. Surfaces: the `remnic meetings list/show/build` CLI, MCP tools (`engram.meetings_list`/`engram.meetings_get`/`engram.meetings_build`, with `remnic.` aliases), HTTP routes (`/engram|remnic/v1/meetings[/:id|/build]`), and a post-sync (auto **and** manual) auto-build tail-step via the wearables `onDaysSynced` and activity `onActivitySynced` hooks. Caller-derived namespace symmetry: wearable sources, meeting records, and meeting memories are caller-namespaced (`writableNamespaceFor`/`resolveReadableNamespace`), while screen activity is a machine-global store consumed only for the default/machine-owner namespace (non-default callers run audio-only). All reachable from `@remnic/core`. Capture daemons (`@remnic/capture-screen`, `@remnic/capture-audio`) and native macOS/Windows helpers that produce screen/audio input are à-la-carte, fixture-`--replay`-testable, and land in later slices. See docs/meetings.md and docs/desktop-capture.md

### Integration Points

- `api.on("gateway_start")` — initialize orchestrator
- `api.on("before_prompt_build")` — inject memory context
- `api.on("agent_end")` — buffer turn for extraction
- `api.registerTool()` — memory search, stats, etc.
- `api.registerCommand()` — CLI interface
- `api.registerService()` — service lifecycle

### Testing Locally

```bash
# Build
npm run build

# Full restart (gateway_start hook needs this)
launchctl kickstart -k gui/501/ai.openclaw.gateway

# Or for hot reload (but gateway_start won't fire)
kill -USR1 $(pgrep openclaw-gateway)

# Trigger a conversation to test

# View logs
grep "\[engram\]" ~/.openclaw/logs/gateway.log
```

### Common Gotchas

1. **OpenAI must use Responses API** — never Chat Completions (per CLAUDE.md guidelines)
2. **Zod optional fields** — must use `.optional().nullable()`, not just `.optional()`
3. **Gateway launchd env isolated** — API keys must be in plist EnvironmentVariables
4. **Config schema strict** — new properties MUST be added to `openclaw.plugin.json` configSchema
5. **SIGUSR1 doesn't fire gateway_start** — use `launchctl kickstart -k` for full restart
6. **profile.md injected everywhere** — keep under 600 lines or consolidation triggers
7. **QMD `query` is intentional** — DO NOT change the *default* from `query` to `search` or `vsearch`. The `query` command provides LLM expansion + reranking that Remnic relies on. Remnic's own reranking was disabled because `qmd query` handles it. Likewise, the daemon's `query` MCP call intentionally runs a `lex+vec+hyde` plan (full hybrid recall), not BM25-only. Both are by design, not bugs — a slower daemon path doing more inference is expected on CPU-only models, NOT 70x "overhead" (issue #1335). If you need a faster BM25-only path, it is exposed as opt-in config, never as a default change: `qmdSubprocessStrategy: "search"` (CLI fallback) and `qmdSearchStrategy: "lex"`/`"lex-vec"` (daemon plan). Defaults stay `query`/`hybrid`. See `docs/search-backends.md` → "Tuning daemon latency on CPU-only models".
8. **QMD version gates** — Remnic targets `@tobilu/qmd` 2.5.3, probes `qmd --version`, and must keep older QMD installs working by omitting unsupported flags. Use `--format json` for QMD 2.5.3+ query/search subprocess calls; keep legacy `--json` for older versions.
11. **Scope globals per plugin ID** — runtime orchestrator mirrors, CLI dedupe guards, and capability caches must be keyed by `serviceId` when multiple instances can coexist.
12. **Write rollback data before success markers** — if a migration writes `.migrated-from-engram`, the `.rollback.json` must be written first so failures don't leave a false success marker.
13. **Wrap external service calls in try-catch** — token generation, daemon health probes, and filesystem writes must not crash the primary install/remove/config flow. Fail gracefully and surface a user-facing note instead.
20. **Search ALL code when changing function signatures** — when changing `addTurn(role, content)` to `addTurn(sessionId, turn)`, search `evals/`, `tests/`, and `packages/*/` — not just `src/`. Missed call sites in adapters/evals were a recurring source of post-merge fixes.
21. **Interactive prompts must gate actual mutations** — if a migration prompt asks "migrate legacy config?" and the user says "no", the code must skip the actual config mutations, not just print different console messages while still writing the new config.
23. **Hash operations must use consistent content form** — if writes hash `rawContent`, reads and dedup checks must also hash `rawContent`, not the timestamped `citedContent`. Mixing forms silently breaks dedup.
25. **Don't destroy old state before confirming new state succeeds** — rotate tokens AFTER config write succeeds, clean up old profiles AFTER new profile is confirmed. PR #400 had 20+ review rounds on this pattern alone.
34. **Distinguish empty results from backend failures** — `search()` returning `[]` for both "index is empty" and "endpoint returned 5xx" prevents callers from short-circuiting on genuine failures. Use distinct result shapes: `{ok: true, results: []}` vs `{ok: false, error: "backend_unavailable"}`.
43. **Direct-write paths must trigger reindex** — bypassing the normal extraction→persist→index pipeline (e.g., heartbeat import writing directly to storage) leaves data undiscoverable until unrelated maintenance. After direct writes, explicitly call the reindex step.
49. **Deduplicate batch operation inputs before executing** — duplicate rollout slugs in a batch rename cause ENOENT crash when the second rename tries to move an already-moved file. Check for duplicates before processing, or verify source exists before each move. PR #392.

50. **Use canonical validation script names** — the root package exposes `check:ratchets` (plural) and `check-types`; `@remnic/core` exposes only `check-types`. Neither defines a `typecheck` script. Verify `package.json` before invoking scripts. Twenty fleet notes in one week came from guessed names.
51. **Use Biome for formatting** — the root package pins `@biomejs/biome` 1.9.4. Prettier is not installed anywhere in the workspace: `pnpm exec prettier` fails, and `npx prettier` may download Prettier and prompt for confirmation — use the pinned Biome binary instead. Do not run whole-file formatting on baseline-unformatted legacy files; format changed lines only. Six incidents caused whole-file churn.
52. **Keep napkins per worktree** — copy or create `.claude/napkin.md` in every worktree. Per-worktree napkins prevent concurrent writer clobbering.
- **GitHub PR review-comment API routes (agent-notes: 2026-08-14):** read a review comment with `repos/{owner}/{repo}/pulls/comments/{comment_id}` (no PR number in the path); reply with `repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies` (PR number required). The owner is `joshuaswarren` — read it from `git remote -v`, never guess. Five route-guessing failures on 2026-08-13/14.

## Sealed memory-write envelope (issue #1989)

How memory writes work since the #1989 series landed — this DESCRIBES the
mechanism (decision A); the enforced gate is `scripts/check-envelope-belt.mjs`
in CI's checks job.

- Every production memory write composes a `SealedMemoryEnvelope` via
  `composeMemoryEnvelope(input, ctx, opts?)` in
  `packages/remnic-core/src/write-envelope.ts` and persists through
  `storage.writeSealedMemory(envelope, extras)`. `StorageManager.writeMemory`
  remains the single persistence engine — `writeSealedMemory` delegates
  through the exported `sealedWriteToLegacyArgs` mapper, which test doubles
  also use so stub behavior cannot drift (§21).
- **Strict vs salvage:** operator/system-built input composes STRICT (an
  invalid value is a caller bug that must surface — explicit capture,
  coding surfaces, audit trails). Machine-generated or replayed-from-store
  input composes with `{ salvage: true }` (extraction, wearables,
  consolidation, promotions, corrections, admin replays): invalid OPTIONAL
  fields drop with notes on `envelope.salvageNotes`, which callers warn-log —
  visible, never silent. Content/category/source/validAt stay fatal in both
  modes.
- **Adding a cross-cutting field is a ONE-MODULE change:** add it to
  `MemoryWriteInput`/`SealedMemoryEnvelope` with normalization in the
  composer, classify it in exactly one of `WRITE_FINGERPRINT_FIELDS`
  (identity) or `FINGERPRINT_EXEMPT_FIELDS` (provenance), and map it in
  `sealedWriteToLegacyArgs`. Compile-time assertions refuse unclassified or
  doubly-classified fields, and `UncoveredAccessFingerprintField` forces an
  explicit access-surface fingerprint decision.
  `write-envelope.extension.test.ts` is the living demonstration.
- **Idempotency fingerprints:** the access surfaces' stored hashes are
  load-bearing state (no TTL). Their payloads build through the per-surface
  builders in write-envelope.ts (`buildAccessWriteRequestFingerprint`,
  `buildObserveRequestFingerprint`) which reproduce the historical shapes
  byte-for-byte; `access-fingerprint-parity.test.ts` is the safety net.
  Unifying onto the versioned `buildWriteIdempotencyPayload` shape requires
  an explicit stored-state migration.

## À-la-carte packaging

Remnic ships as a family of packages that compose. Every install surface must respect this contract:

- **Core always works alone.** `@remnic/core` is the only install most users need.
- **Optional packages never piggyback on the base install.** `@remnic/bench`, `@remnic/export-weclone`, `@remnic/import-weclone`, `@remnic/plugin-openclaw`, etc. must be separately `npm install`-able and must never be bundled, noExternal'd, or declared as a runtime `dependencies` entry on a base package.
- **Load optional packages lazily.** Use a computed-specifier dynamic import (`await import("@remnic/" + "bench")`) so bundlers cannot statically resolve the module. Wrap in a loader helper that throws a user-facing install hint on miss. Canonical implementations: `packages/remnic-cli/src/optional-bench.ts`, `packages/remnic-cli/src/optional-weclone-export.ts`, `packages/remnic-core/src/cli.ts:ensureBuiltInBulkImportAdapters`.
- **Declare as optional peer deps.** In the consuming package's `package.json`, list optional companions under `peerDependencies` and mark each as optional via `peerDependenciesMeta.<name>.optional = true`. Do not list them under `dependencies`.
- **Never add to `noExternal`.** In tsup configs, optional packages must be `external` (or simply omitted from `noExternal`). Adding them to `noExternal` bundles them into the base install and breaks à-la-carte.
- **Publish everything.** Any package that end users are expected to install (even as an extension) must be published to npm. If it's `"private": true` and you recommend it, that's a bug — ship it or remove the recommendation. The publish order in `.github/workflows/release-and-publish.yml` is the source of truth; keep it topologically sorted.

When you touch any of these files — tsup configs, CLI/plugin package.json `dependencies`, or dynamic-import loaders — re-verify the contract end to end: does `npm install @remnic/cli` still work without the optional packages present? Does the CLI throw a clean install hint instead of a `MODULE_NOT_FOUND`?


## Why Review Churn Happens

See "Why Stateful PRs Churn (Read Before Touching Lifecycle Logic)" above — it
owns the failure mode, the required response, and the now-executable scenario
matrix (`runLifecycleMatrix`, issue #1993). This heading is retained only as a
pointer so links to it still resolve; do not re-add the prose matrix here.
