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

Background + anti-patterns: [`docs/agent-guide/stateful-pr-churn.md`](docs/agent-guide/stateful-pr-churn.md). Read before lifecycle/stateful PR work.

## Tooling & Automation Guidance (Fleet Learnings)

Established from multi-issue batch runs. Each row documents a repeatable friction with the preferred resolution.

| Friction | Resolution |
|---|---|
| `omp` hangs at startup blocking on stdin | Route input from `/dev/null` — `omp --mode text < /dev/null`. The CLI's `readPipedInput` blocks on piped stdin indefinitely |
| `task` subagents fail with `403 Access denied` for the model | The default subagent model may not have quota; override via explicit model selection in the spawner |
| Background omp processes killed by shell job control | Use `setsid` + `disown` (or `nohup setsid`) to detach from the shell process group. Bare `&` does not survive the bash tool's job-reaping |
| GraphQL rate limit exhausted by `gh issue edit` / `gh issue view --json` / `gh pr view --json` | Prefer REST: `gh api repos/.../issues/<n>`, `gh api repos/.../pulls/<n>/reviews`, `gh api repos/.../pulls/<n>/comments`. REST has a separate 5000-requests/hour budget |
| `scripts/dev-worktree.sh` is a shell script | Invoke as `bash scripts/dev-worktree.sh`, never `node scripts/dev-worktree.sh` |


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

Full checklist (items 1–48 + examples): [`docs/agent-guide/review-prevention-checklist.md`](docs/agent-guide/review-prevention-checklist.md).

**Open that file before every Remnic PR.** Do not rely on a summarized subset — the linked doc is authoritative. Root `AGENTS.md` keeps only this pointer so advisor-router prompts fit the 49k studio cap.

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

Tree + memory file formats: [`docs/agent-guide/file-structure.md`](docs/agent-guide/file-structure.md).

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

Deep architecture notes: [`docs/agent-guide/architecture-notes.md`](docs/agent-guide/architecture-notes.md). Keep Architecture Boundaries (above) as the binding summary.

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
