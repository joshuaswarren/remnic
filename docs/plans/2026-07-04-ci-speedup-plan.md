# CI + AI-Review Speedup Plan

Date: 2026-07-04
Status: Phase 1 implemented in this PR; Phases 2-3 are infra/process follow-ups.

## Problem

PR merge latency is dominated by CI wall-clock and AI-reviewer gating, not by
reviewer quality. Measured on the last 100 workflow runs and 30 merged PRs:

| Fact | Measurement |
|---|---|
| `quality` job wall-clock | ~11 min (Tests 7.25 m, Typecheck 2.45 m, serial) |
| `@remnic/core` tsup build repeats | 3× per quality job (check-types, test, build each prepend it) |
| Root suite | 895 test files in ONE `tsx --test` process, no sharding |
| AI Review Gate | fixed `sleep 180` per fire; fires 2-4× per push (34 of last 100 runs) |
| Cursor Bugbot actual latency | starts ≤0.5 min after push, finishes in 0.8-2.1 min |
| Heavy-PR round trips | 5-9 push→review→push cycles (#1591: 28 commits, 82 reviews; #1593: 5 labeled "round-N" commits) |
| Per-push always-on CI | ~28-34 runner-minutes across 10+ workflows |

Cost reality check (changes the optimization target):

- `joshuaswarren/remnic` is a **public repo** → standard `ubuntu-latest`
  minutes are **$0**. All 20 jobs use `ubuntu-latest`.
- Bugbot is on a **flat subscription** → per-review cost is $0.
- Therefore remnic's problem is **pure wall-clock latency** (plus free-tier
  concurrency contention across the account's repos). Money savings apply to
  **private/client repos** (see "Generalizing to private repos" below).

## Phase 1 — implemented in this PR (no infra required)

1. **AI Review Gate: poll instead of sleep.**
   `sleep 180` removed. The gate now evaluates immediately and re-polls every
   20 s (7 min deadline) with early exit the moment every required reviewer
   has positive current-head activity. Explicit negative verdicts still fail
   immediately. Since Bugbot finishes in ~2 min, gate-green latency drops
   from ~3.2+ min to ~Bugbot-actual. A per-PR `concurrency` group with
   `cancel-in-progress` collapses the 2-4× multi-fire stampede to one live
   evaluation per PR.

2. **`quality` split into parallel jobs.**
   `checks` (lint + typecheck + review-patterns + ratchets), `tests`
   (2-way shard), and `build-artifacts` now run in parallel; a tiny `quality`
   aggregator preserves the required status-check context without touching
   the branch ruleset. Aggregator fails unless every dependency reports
   `success` (skipped/cancelled are failures — no silenced gates).

3. **Test sharding.**
   `scripts/run-root-tests.mjs --group <root|packages|misc>` selects pattern
   groups. `TEST_PATTERN_GROUPS` is an exact partition of `TEST_PATTERNS`,
   enforced by a test, so shards can never silently drop coverage. CI runs
   `root+misc` and `packages` shards concurrently (~518 vs ~377 files).

4. **Superseded-push cancellation.**
   `ci.yml` gets a per-PR concurrency group (`cancel-in-progress` for PR
   events only, never for pushes to `main`). Rapid agent push loops stop
   queueing stale runs behind fresh ones.

Expected merge-critical path per push: **~11 min → ~6-7 min** on hosted
runners (setup + longest test shard + aggregator), and the gate goes green
~1-3 min after Bugbot instead of 3-6+.

## Phase 2 — homelab runners (infra, ~1 day)

`~/src/homelab-infra` already runs **~15 GitHub Actions runner LXCs** across
the Proxmox cluster with nightly-prune/weekly-restart/telemetry automation
(`scripts/ci-runner-*`), currently serving Deckard CI. Findings:

- proxmox2/3/4/5/z1 are documented as I/O- or capacity-saturated ("do not add
  workers"); the primary proxmox node has modest headroom.
- **jarvis** (EPYC 7443P 24C/48T, 256 GB ECC, 3.5 TiB free local-lvm, dual
  10 GbE) is the only node with real capacity; the ML VM leaves ~60 GB +
  spare cores on the host.

Rollout (follows existing conventions in `homelab-infra`):

1. Create 1-2 Debian-12 unprivileged LXCs on **jarvis** (6-8 vCPU, 16-24 GB,
   rootfs on jarvis `local-lvm` — never QNAP NFS/iSCSI), standard runner
   feature set (`nesting=1,keyctl=1,fuse=1`, `onboot=1`), one runner per CT,
   registered to `joshuaswarren/remnic` with labels
   `[self-hosted, remnic]` and `--no-default-labels`.
2. Enroll jarvis in Tailscale (currently `NeedsLogin`) and wire the existing
   `ci-runner-nightly-maintenance` + Gatus health checks.
3. Flip `runs-on` for the `tests` shards (and optionally `checks`) to
   `[self-hosted, remnic]`. With 8 vCPU/shard, `node:test` concurrency
   doubles vs the 4-vCPU hosted runner → tests ~2-3 min; a warm pnpm store
   and prebuilt better-sqlite3 remove another ~1 min of setup.
4. Keep one shard runnable on `ubuntu-latest` as fallback if jarvis reboots
   (labels are per-job; a manual `workflow_dispatch` input can switch).

**Security (public repo — non-negotiable):**

- Repo → Settings → Actions: set fork-PR workflow approval to
  **"Require approval for all outside collaborators"**.
- `runs-on` expression gate in `ci.yml`: the `remnic` pool only serves pushes
  and same-repo PRs; fork PRs run on GitHub-hosted runners even after a
  maintainer approves their workflows. External code never executes on
  homelab hardware.
- Dedicated remnic runner CTs only. **Never** share runners between remnic
  (public) and Deckard/client repos (private) — a malicious fork PR on the
  public repo must have nothing to steal. No secrets on the runner beyond
  its registration token; runners are outbound-HTTPS-only (fits the
  locked-down MikroTik posture).
- Existing weekly-restart + nightly-prune automation approximates ephemeral
  hygiene; move to true ephemeral (JIT registration, `--ephemeral`) if
  outside contributions grow.

## Phase 3 — review round-trip reduction (process + settings)

The dominant residual cost is 5-9 push→review→push cycles per heavy PR.
Levers, in order of effort:

1. **Cursor dashboard: enable incremental re-review** ("only review what's
   new since the last review", June 2026 Bugbot update). Kills re-flagging
   of already-reviewed code that drives rounds 4+.
2. **Draft-first agent workflow.** CI (`quality`) and both gates already
   skip drafts. Agents should open PRs as drafts, iterate against local
   preflight (`npm run preflight:quick` + `review:cursor`), and flip to
   ready once — collapsing N review rounds into 1-2. Candidate enforcement:
   a `pr-loop` skill update instructing agents to use `gh pr create --draft`.
3. **Reviewer context files.** `.cursor/BUGBOT.md` extended in this PR with
   packaging/docs-contract/CI-workflow rules and a "don't re-flag unchanged
   code" note. Codex reviews already consume `AGENTS.md`.
4. **Batch-fix discipline** is already mandated
   (`docs/ops/pr-review-hardening-playbook.md`); the draft-first workflow is
   what makes it cheap to follow.

Not viable: GitHub **merge queue** — org-owned repos only; remnic is
user-owned. Revisit if the repo ever moves into an org.

## Generalizing to private/client repos (e.g. Blend)

Private repos pay real money per minute, so the same playbook has direct
dollar ROI there — with different constraints:

1. **Self-hosted runners are SAFER on private repos** (no fork-PR exposure)
   and eliminate per-minute billing entirely. Blend CI could run on a
   dedicated LXC pool (the Deckard pattern: one-runner-per-CT, labeled, with
   the existing `ci-runner-*` maintenance) — **but check the client
   contract/data-handling terms before running client code on homelab
   hardware.** If client governance forbids it, use a SOC2 managed runner
   service (Blacksmith/WarpBuild/Namespace/Depot, ~50-70% cheaper per minute
   than GitHub-hosted and ~2× faster; drop-in `runs-on` change) or RunsOn
   inside the client's own AWS account (~90% cheaper, stays in their
   security perimeter).
2. **The workflow patterns port as-is:** kill fixed sleeps (poll with early
   exit), per-PR `concurrency` + `cancel-in-progress`, split serial mega-jobs
   into parallel jobs behind a required-check aggregator, shard tests, dedupe
   repeated builds, path-filter expensive suites.
3. **The review patterns port as-is:** repo-level `BUGBOT.md` (+ per-dir
   files for big repos), draft-first iteration, batch-fix rounds, local
   pre-push AI review. On metered Bugbot/Codex plans these also cut review
   spend directly.
4. **Order of operations for any client repo:** measure first (`gh run list`
   + job timings), kill pure-waste minutes (sleeps, redundant builds,
   unconditioned triggers), then parallelize, then move compute off GitHub
   only if the bill still matters.

## Measurements to watch after merge

- `gh run list --workflow CI --json createdAt,updatedAt` — expect quality
  aggregate ≤7 min per push.
- AI Review Gate runs per push should drop to ~1 live run (cancelled runs
  are expected and free-ish); gate-green should track Bugbot completion
  within ~30 s.
- Heavy-PR wall-clock open→merge; target: halve #1591-class PRs.
