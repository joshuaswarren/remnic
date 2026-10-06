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
  the required CI checks, and the Review Prevention Checklist
  ([`docs/review-checklist.md`](docs/review-checklist.md)). What this
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
   - Re-scan unresolved comments with `node scripts/pr-threads.mjs <pr-number>` (canonical thread intake: id, author, isResolved, full body). Default is unresolved only; `--all` includes resolved; `--json` emits an array. Fix the whole subsystem, run verification once, then push once.
   - Avoid serial micro-pushes that only expose the next adjacent invariant.

4. Run the local hardening gate before claiming review-clean.
   - Always run `npm run preflight:quick`.
   - **Before every push, run `npm run check:pre-push`** (~1 min). It is the
     subset of CI's `checks` job that needs no build, type-check, or test run:
     structural ratchets, regex safety, the envelope belt, the config contract
     (including parsed-keys snapshot drift), and lifecycle-matrix coverage. It
     adds no policy — CI already enforces every one of them — it just makes the
     cheap half runnable in seconds. This exists because a parallel batch where
     each implementer ran only its focused test produced one red CI run per
     branch, each for a DIFFERENT cheap check nobody had run. `preflight:quick`
     remains the gate before requesting review; this is the gate before `git push`.
   - A file **exactly at** its `fileSizeGrandfather` ceiling fails the moment you
     add a line — and CI measures the MERGE commit, so merging `main` can push it
     over on its own even when your branch tip is clean. `check-ratchets` now ends
     with an explicit `WARNING` block naming the at-ceiling files you touched
     (scoped by `REMNIC_RATCHET_CHANGED_FILES_PATH`, which `check:pre-push` and CI
     both set). If your branch is behind `main`, merge it before trusting a green
     local ratchet run.
   - If you touch `orchestrator.ts`, `storage.ts`, `intent.ts`, `memory-cache.ts`,
     `entity-retrieval.ts`, `config.ts`, or any file under `storage/` or `orchestration/`
     in `src/` or `packages/remnic-core/src/`, also run `npm run test:entity-hardening`.
   - `npm run check:regex-safety` (also part of `preflight:quick`) flags new regex literals on changed `.ts`/`.mts` lines that match the ReDoS shapes CodeQL repeatedly flagged — `[\s\S]*?`/lazy `.*?`, unbounded `[^>]*` with an alternative branch, `\s*` chains around captures, nested quantifiers like `(a+)+`. Prefer bounded quantifiers or `indexOf`/loop scans (issue #2439).
   - If Cursor CLI is available, run `npm run review:cursor` before requesting external AI review.

5. Treat external AI review as stale unless it matches the current head.
   - Do not call a PR clean if the latest positive AI verdict targets an older commit.
   - A merge-ready PR needs green checks, zero unresolved review threads, and a fresh positive AI verdict on the current head.
   - Use `scripts/pr-wait-settled.sh <pr-number>` to block until the current head has terminal required checks, current reviewer results, and zero unresolved threads.
   - Exact `Review rate limited` and empty-body results count as terminal neutral evidence. Pending reviewers remain blocking unless `--reviewer-timeout S` is set; expiry downgrades them to neutral with a warning.
6. Fetch `origin/main` (or `github/main`) before creating a worktree.
   Use `scripts/dev-worktree.sh`, which now defaults to that remote SHA.
   Do not copy a stale local `main`.
7. Before growing a file listed under `fileSizeGrandfather` in
   `scripts/ratchet-baseline.json`, extract the addition to a sibling
   module. Growing past the ceiling fails the required `checks` job.
8. Parallel multi-issue batches stay parallel.
   Spawn one implementer per isolated worktree and keep it running.
   A short clean `git status` is not a stall. Do not cancel the set and
   serialize the work onto the orchestrator. Fan each PR-loop to its own
   subagent.
9. Before picking an open issue, grep the named symbol on `github/main`.
   If the change already landed, close the issue. Do not open a duplicate PR.
10. Merge with REST `PUT /repos/{owner}/{repo}/pulls/{n}/merge` when checks
    and test shards are green. An older `ai-reviewers` failure or cancellation
    on the same head is not a product defect.
11. Check closed-issue claims before review. A PR whose body claims
    `Fixes #N` for an issue that is already closed, with a base ≥15 commits
    behind main, is a revert bomb: the three-dot diff looks like the fix, but
    a two-dot diff against current main deletes every commit that landed after
    the issue closed. The `closed-issue-base` job in `review-thread-guard.yml`
    fails such PRs — rebase onto main and re-verify the issue before
    requesting review.
12. Stagger PR creates in a parallel batch. Opening several PRs at once trips
    GitHub 429/502/503. Use `scripts/gh-pr-create-stagger.sh` (lock + 65s gap
    via TMPDIR) instead of a bare `gh pr create`.



Reference workflow:
`docs/ops/pr-review-hardening-playbook.md`

## Release channels (issue #3032)

`main` publishes to the npm `alpha` dist-tag on every merge; `beta` and
`latest` are dist-tag moves onto an already-published version.
[docs/releases.md](docs/releases.md) is the canonical process — read it before
adding a config flag, writing a changeset, or promoting a release. The four
rules that bind every PR:

1. A diff that changes published-package behavior needs a changeset with a
   `Stability: alpha|beta|stable` line. Doc-only and CI-only diffs are exempt.
2. Alpha/beta behavior ships default-off behind a flag registered in
   `scripts/flag-graduation.json`. Stable work adds no default-off gate.
3. Graduation is its own PR: flip the default, delete the registry entry, carry
   `Stability: stable`, link the evidence.
4. Never run `npm publish` or `npm dist-tag` by hand. Releases happen only
   through `release-and-publish.yml` (alpha) and `release-promote.yml`
   (beta/stable).

Enforced by `scripts/check-release-discipline.mjs`, a step of the
`changelog-guard` workflow: rules 1 and 2, the flip-plus-registry-deletion
symmetry in rule 3, and the requirement that the registry never outlives the
code. The evidence link in rule 3 and the whole of rule 4 are review
conventions — no check reads an agent's shell. Run the gate locally with
`node scripts/check-release-discipline.mjs --base "$(git merge-base HEAD github/main)"`.

## Agent / automation contributors

Use `scripts/dev-worktree.sh <worktree-path> <branch> [base]` to create an
isolated, installed worktree with a core type-check smoke check.
- **Subagent worktree discipline.** Verify `pwd` before every write; use absolute paths rooted at this worktree; NEVER write to the main checkout or sibling worktrees; agent file tools may ignore cwd.
- **Checkpoint after each milestone.** After a commit is pushed, a PR is opened, or threads are resolved, run `node scripts/agent-checkpoint.mjs write --note "<milestone>"` so a coordinator can resume after a crash.

Run pnpm through the pinned package manager wrapper:

```bash
node scripts/pnpm.mjs <command>
```

The launcher uses `scripts/pnpm.sh` on POSIX and `npm exec --yes pnpm@10.32.1` on Windows.

Set command deadlines before you start long checks:

| Command | Timeout |
| --- | ---: |
| `npm run preflight:quick` | 900s |
| `npm run test:entity-hardening` | 900s |
| `npm run test:file <path>` | 300s |
| Full test suites | 1800s |
| Builds | 1800s |

Use `npm run test:file <path>` for targeted testing without running the full root suite.

Merge with `gh pr merge <number> --squash`. Do not add `--delete-branch` when
`main` is checked out in another worktree. Delete the remote branch explicitly:

```bash
git push origin --delete <branch>
```

For the whole end-of-review sequence in one command, run
`scripts/pr-merge-ready.sh <pr-number>` (issue #2440): it verifies the head
SHA's check-run conclusions and the GraphQL unresolved-thread count, prints an
evidence block (head SHA, per-gate conclusion, thread count), dismisses
`CHANGES_REQUESTED` reviews that target a superseded head with a reason string,
merges `--squash` — retrying once with `--admin` only when every verified
precondition held and the head is unchanged (GitHub can leave mergeStateStatus
BLOCKED after a dismissal even with head checks green) — and deletes the remote
branch only after polling confirms `state=MERGED`, because deleting before the
merge confirms auto-closes the PR (hit on #2434). `--check` prints the plan
without acting. A `CHANGES_REQUESTED` verdict on the current head blocks the
merge rather than being dismissed.

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
4. Open at most one PR per minute when landing a batch. Five PRs at once
   429 action downloads and 404 brand-new PR node IDs. The AI review and
   scope-budget gates retry those lookups; do not treat the first red
   run as a product defect.
5. A positive CodeRabbit review on the current head satisfies
   `ai-reviewers` when Cursor never starts. Cursor remains accepted.
   When NO required reviewer posts anything at all on a head, the gate now
   concludes `success` with the title `Reviewers never posted — gate waived`
   instead of `neutral`. That is deliberate: the ruleset requires this context
   and does not accept `neutral`, so the old escape hatch left such PRs blocked
   and the only way forward was an admin merge — which bypasses EVERY required
   check at once. Waiving this one gate explicitly keeps `checks`, the test
   shards, and `unresolved-review-threads` enforced. A posted
   `CHANGES_REQUESTED` still fails the gate; only reviewer *absence* is waived.
6. Rulesets evaluate the LATEST check-run per required context, not the best
   one. A `neutral` check-run posted after a `success` on the same head keeps
   `mergeable_state: blocked` indefinitely — the gate reads red even though a
   real positive verdict exists on that SHA. Before concluding a PR is stuck on
   its own code, group the head's check-runs by name and take the newest
   `completed_at` per name: `gh api repos/<o>/<r>/commits/<sha>/check-runs
   --paginate`. If the only non-success entry is a bookkeeping `neutral` newer
   than the covering success, that is the scheduling artifact (issue #2711), not
   a defect in the PR.
7. Poll with REST, resolve threads with GraphQL. The two share no rate-limit
   budget, and per-PR GraphQL polling exhausts the hourly GraphQL allowance —
   after which `resolveReviewThread` (GraphQL-only) becomes impossible and the
   `unresolved-review-threads` gate cannot be cleared at all. Use
   `/commits/{sha}/check-runs`, `/pulls/{n}`, and `PUT /pulls/{n}/merge` for the
   loop; reserve GraphQL for reading and resolving threads.
8. Check conclusions are lowercase over REST (`success`, `failure`, `neutral`,
   `skipped`) and UPPERCASE in the `gh pr view --json statusCheckRollup`
   projection. A filter written for the wrong casing reports zero failures on a
   red PR, which reads as "CI is green but merge is blocked" and sends the loop
   chasing a nonexistent policy problem.


### Transactional review rounds (issues #1992, #2442)

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
- The ledger also counts **fix rounds** per PR (the first push landing in an
  open round is that round's batched fix; later micro-pushes coalesce into it).

The **round-budget ledger is enforcing** (issue #2442): at fix round 3 it posts
a one-time warning reply citing the decline policy above, and at fix round 4 it
automatically files ONE GitHub issue listing every still-open non-critical
thread with permalinks (the decline rule's required backlog artifact), labels
the PR `review-round:cap`, and links the issue from the ledger comment. These
actions never fail a check, never block merge, and never resolve or hide a
thread — the `unresolved-review-threads` guard stays the merge gate (a reasoned
decline satisfies it exactly as much as a fix). Reviewer *dispatch* remains
shadow (`REVIEW_ROUND_ENFORCE: 'false'`): the dispatch flip and the guard's
round-scoped pending state are a later step, gated on shadow data (umbrella
#1988 decision D), and the guard's missing concurrency group (that
`check-unsticker` depends on) is preserved.

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


## Tooling & Automation Guidance (Fleet Learnings)

Established from multi-issue batch runs. Each row documents a repeatable friction with the preferred resolution.

| Friction | Resolution |
|---|---|
| `omp` hangs at startup blocking on stdin | Use `bash scripts/omp-print.sh` (redirects stdin from `/dev/null`). Bare `omp --mode text` / hub-started omp with a pipe never EOFs: `readPipedInput` blocks indefinitely |
| `task` subagents fail with `403 Access denied` for the model | The default subagent model may not have quota; override via explicit model selection in the spawner |
| Background omp processes killed by shell job control | Use `setsid` + `disown` (or `nohup setsid`) to detach from the shell process group. Bare `&` does not survive the bash tool's job-reaping |
| GraphQL rate limit exhausted by `gh issue edit` / `gh issue view --json` / `gh pr view --json` | Prefer REST: `gh api repos/.../issues/<n>`, `gh api repos/.../pulls/<n>/reviews`, `gh api repos/.../pulls/<n>/comments`. REST has a separate 5000-requests/hour budget |
| `scripts/dev-worktree.sh` is a shell script | Invoke as `bash scripts/dev-worktree.sh`, never `node scripts/dev-worktree.sh` |
| Sync daemon health probes hang against a local HTTP stub | The probe uses `Atomics.wait` on the calling thread. The stub must run on a worker; a main-thread `http.createServer` never accepts |
| `pr-merge-ready --check` reports BLOCKED while shards are still running | Verdict is `WAITING` (exit 3) when remaining required checks are `in_progress`/`queued`/`pending`. `BLOCKED` is failed checks, unresolved threads, thread-read failures, or current-head `CHANGES_REQUESTED` |


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

The full checklist (48 items) is
[`docs/review-checklist.md`](docs/review-checklist.md). It is still binding
on every PR. Numbered citations — `checklist §N`, `checklist #N`, and
`AGENTS.md` pattern N — resolve to the `###` headings in that file.

Items 1–5 are inlined here because they apply to almost every change. They
do not replace items 6–48.

This is a **public repo**. Issue and PR text must follow the
"PUBLIC REPOSITORY — Privacy Policy" section below.

### 1. Input Validation — Reject Invalid Inputs Explicitly

Never silently accept and reinterpret bad values.

- **CLI flags must validate their argument exists** — `--format json` where
  `--format` has no value must throw, not silently default.
- **Enum/config values must be validated against an explicit allow-list** — when
  adding a new accepted value, add it to the validation schema AND the config
  parser.
- **Numeric inputs must be type-checked** — port values must be finite integers
  in [1, 65535]; reject `"abc"` and `3.7` rather than truncating.
- **Date/timestamp parsing must guard overflow** — reject inputs that would
  overflow `Date` bounds instead of producing `Invalid Date`.

### 2. Rename Completeness — Always Add Legacy Fallbacks

- **Search the entire codebase when renaming anything** — docs, tests, lock
  files, changesets, hooks, and CI configs.
- **Always add a legacy fallback chain** — env vars: `REMNIC_FOO` → `ENGRAM_FOO`;
  config keys: try the `remnic` block first, fall back to the `engram` block.
- **Update lock files when changing workspace dependencies** — changing
  `workspace:*` specifiers or package names without running `pnpm install`
  breaks the lock file.
- **Changeset files must reference current package names.**
- **Hook scripts must use the current plugin name** in error messages and paths.

### 3. Security — Sanitize at System Boundaries

- **Never interpolate unsanitized values into shell commands** — pass host/port
  via environment variables, never via string interpolation into script strings.
- **Restrict file permissions on auth tokens** — config files containing tokens
  should use `0600` permissions.
- **Block symlink traversal in directory scans** — reject symlinks that resolve
  outside the allowed root. Reject symlinked root directories entirely.
- **Validate external inputs at system boundaries** — profile values, connector
  IDs, and config paths must be sanitized before filesystem operations.

### 4. Error Handling — Never Let Side Effects Crash the Main Flow

- **Wrap token/external-service operations in try-catch** — a token-store or
  daemon failure must not block the primary install, remove, or config flow.
- **Write rollback manifests BEFORE migration markers** — if rollback metadata
  write fails, the system must not think migration succeeded.
- **Use AbortController for timeout-able async operations** — a timed-out
  `before_reset` flush must abort the in-flight extraction before the buffer
  is cleared.
- **Guard refcount operations against double-decrement** — track whether the
  increment happened before decrementing.

### 5. State Scoping — Don't Share What Shouldn't Be Shared

- **Scope singletons per plugin ID** — runtime orchestrator mirrors, CLI dedupe
  guards, and capability caches must be keyed by `serviceId`, not stored as
  bare globals.
- **Scope extraction deduplication by session/buffer key** — fingerprint
  `bufferKey + normalizedTurnText`, not turn text alone.
- **Cache writes and reads must use consistent formats** — a hook path that
  writes `{version, data}` and a section path that reads `data` directly will
  diverge.

Items 6–48, with the original reviewer notes and examples, are in
[`docs/review-checklist.md`](docs/review-checklist.md).

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


## Implementer agent PR-report receipt contract (issue #3012 process hit, this batch)

Every implementer agent's task report MUST include a JSON block with these exact fields; the parent treats missing fields as a flag to re-verify independently rather than trust the agent:

- `branch`: the pushed branch name
- `pushedSha`: the exact commit SHA on the remote
- `fail_before`: the failing command + output snippet (or path to a fail-before fixture test)
- `pass_after`: the passing command + output snippet (test name + counts)
- `tsc`: `npx tsc --noEmit -p <pkg>` exit code (must be 0 for touched packages)
- `ratchets`: `node scripts/check-ratchets.mjs` summary line
- `files`: array of changed files relative to repo root
- `remaining_layers` or `remaining`: deferred work that future PRs/batches will land

Implementer reports that omit any of these fields have to be re-verified before merge. A thin report that just says "done" with no receipts is treated as untrustworthy.

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
20. **Search ALL code when changing function signatures** — when changing `addTurn(role, content)` to `addTurn(sessionId, turn)`, search `tests/`, and `packages/*/` — not just `src/`. Missed call sites in adapters were a recurring source of post-merge fixes.
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
