# Retention policy

Remnic's retention substrate keeps a long-running memory store fast and small: it
value-scores every memory, migrates cold material out of the hot search path, and
gives operators explicit forget and purge surfaces. Enable it when your corpus has
grown to the point where stale facts crowd out recent ones or the index has become
slow to search.

**Default posture:** lifecycle scoring is **on by default** (`lifecyclePolicyEnabled`,
default `true` since [#686](https://github.com/joshuaswarren/remnic/issues/686)),
but hot/cold tier migration (`qmdTierMigrationEnabled`, default `false`), cold-tier
search (`qmdColdTierEnabled`, default `false`), and the recall-time stale filter
(`lifecycleFilterStaleEnabled`, default `false`) are **opt-in**. Archive-path
isolation is always on: generic recall omits `archive/` data even when those gates
are disabled. A fresh install scores memories but does not migrate, search cold
tiers, filter stale metadata, or delete data.

## Enable it

Lifecycle scoring already runs. To add value-aware hot/cold migration and cold-tier
search, set:

```json
{
  "lifecyclePolicyEnabled": true,
  "qmdTierMigrationEnabled": true,
  "qmdColdTierEnabled": true
}
```

For the OpenClaw plugin these keys live under
`plugins.entries.openclaw-remnic.config`; for the standalone server they go in the
`remnic` block of `remnic.config.json`. See
[Config reference](config-reference.md) for the full schema.

## Why retention matters

Every long-running memory store hits the same wall: the index keeps growing even
though most of the value is in a small, recently-touched subset. Without retention,
the BM25 index, the graph, and cold-tier search compound indefinitely; recall@K
erodes because relevant recent facts compete with stale chatter; cold-start probes
get slower; backups balloon.

[agentmemory](https://github.com/rohitg00/agentmemory) explicitly calls year-2
retention an unsolved problem. Remnic's answer is a value-scored two-tier substrate
plus an explicit forget surface, described below.

## The tier model

Remnic stores memories in two **physical tiers** plus an archival escape hatch:

- **Hot tier** — `<memoryDir>/{facts,procedures,reasoning-traces,corrections}/` on
  disk; indexed in the QMD collection named by `qmdCollection` (default
  `openclaw-engram`, an intentional compatibility name). This is the default search
  path.
- **Cold tier** — `<memoryDir>/cold/...` on disk; indexed in the separate QMD
  collection named by `qmdColdCollection` (default `openclaw-engram-cold`). Searched
  only when `qmdColdTierEnabled` is `true` and the recall path opts into the
  cold-fallback pipeline.
- **Archive** — `<memoryDir>/archive/...`. Not part of either active tier or
  generic recall. Use an explicit read or search surface to access archived data.

`tier-routing.ts` and `tier-migration.ts` implement the migration logic, the
value-score model, and the journaling. The cold collection is a real, separate QMD
index — not a virtual partition — so demoting a memory removes it from the live
index size accounting.

### How a memory's tier is decided

`computeTierValueScore(memory, now, signals)` aggregates several signals into a
single `[0, 1]` value:

| Signal              | Weight | Meaning                                              |
|---------------------|-------:|------------------------------------------------------|
| `confidence`        | 0.24   | Caller-asserted confidence in the fact.              |
| `access`            | 0.26   | How often the memory has been accessed recently.     |
| `recency`           | 0.20   | How recently the memory was created or accessed.     |
| `importance`        | 0.20   | Calibrated importance score from extraction.         |
| `feedback`          | 0.10   | User-feedback signal.                                |
| correction-category | +0.08  | Bonus when category is `correction`.                 |
| user-confirmed      | +0.05  | Bonus when `verificationState === "user_confirmed"`. |
| disputed-fact       | −0.50  | Heavy penalty for disputed memories.                 |

`decideTierTransition(memory, currentTier, policy, now, signals)` then applies the
policy:

- **Hot → Cold (demotion)** when `ageDays >= demotionMinAgeDays` AND
  `valueScore <= demotionValueThreshold`.
- **Cold → Hot (promotion)** when `valueScore >= promotionValueThreshold`.
- Otherwise stays put.

## What ships on by default vs opt-in

| Behavior                                                  | Status on current release |
|-----------------------------------------------------------|---------------------------|
| Lifecycle policy engine (`lifecyclePolicyEnabled`)        | default `true` (#686 PR 3/6) |
| Lifecycle metrics (`lifecycleMetricsEnabled`)             | explicit value, otherwise mirrors policy |
| Tier migration (`qmdTierMigrationEnabled`)                | default `false` (opt-in) |
| Recall queries hot tier only                              | always (PR 1/6 audit) |
| Cold-tier fallback (`qmdColdTierEnabled`)                 | default `false` (opt-in) |
| Recall-time stale filter (`lifecycleFilterStaleEnabled`)  | default `false` (opt-in) |

Lifecycle scoring and metadata run by default, but automatic hot/cold migration is
gated by `qmdTierMigrationEnabled: true`. Cold-tier search and recall-time stale
filtering are also opt-in. So a fresh install scores memories yet keeps every
memory in the hot tier and visible to recall until an operator enables migration or
filtering.

## Default-recall behavior (audit, #686 PR 1/6)

The recall path was audited and pinned with regression tests in
[#693](https://github.com/joshuaswarren/remnic/pull/693):

1. **Default recall queries the hot QMD collection only.** Every primary call to
   `fetchQmdMemoryResultsWithArtifactTopUp` outside of `applyColdFallbackPipeline`
   omits the `collection` option, so the QMD client falls through to the hot
   collection. The namespace-aware `searchAcrossNamespaces` path does the same.
2. **The cold QMD collection is opt-in.** Queried only inside
   `applyColdFallbackPipeline` and only when `qmdColdTierEnabled` is `true`. Default
   `false` — a fresh install never reaches the cold-QMD branch.
3. **The cold *directory* is not read on recall.**
   `StorageManager.collectActiveMemoryPaths` scans only the hot subtrees.
4. **Archive never enters generic recall.** Explicit read and search surfaces can
   still access archived data.

Regression tests in `tests/retrieval-cold-tier-default-excluded.test.ts` pin the
hot/cold collection boundary. Path-policy and recall-pipeline tests ensure generic
recall excludes archive records before ranking or injection.

## Bench: aged-dataset retention harness (#686 PR 2/6)

[#698](https://github.com/joshuaswarren/remnic/pull/698) shipped `@remnic/bench`'s
`retention-aged-dataset` benchmark — a hermetic synthetic corpus generator with
Pareto-distributed query frequencies, configurable age skew, and deterministic
seeds. The harness measures `recall@K`, a latency proxy, and hot/cold tier shares
for both the full-corpus baseline and the hot-only configuration.

When the optional `@remnic/bench` runtime is available to `@remnic/cli`, run it via
the standalone CLI:

```bash
remnic bench run --quick retention-aged-dataset
```

Base CLI installs that cannot load `@remnic/bench` will report
`retention-aged-dataset` as an unknown benchmark; use `remnic bench list` to
confirm availability. The bench produces a structured report including
`recall_at_5_delta` so default-tuning iterations have an objective signal.

## The forgotten tier

`openclaw engram forget <id> [--reason <text>]` soft-deletes a memory: it sets
`status: "forgotten"`, stamps `forgottenAt`, and writes an optional
`forgottenReason` into the YAML frontmatter. The file stays on disk so the act is
reversible. Forgotten memories are excluded from recall, browse, and entity
attribution by the status-allow-list filters that serve active context.

```yaml
status: forgotten
forgottenAt: 2026-04-25T18:30:00.000Z
forgottenReason: stale preference, user retracted
```

Implemented in `packages/remnic-core/src/maintenance/forget.ts`; registered as the
`forget` command in the `engram` command tree (`cli.ts`).

## Operator visibility

The OpenClaw plugin CLI surfaces give operators a window into the tier substrate
without manually walking the filesystem. Tier inspection and migration control run
through the OpenClaw-hosted `engram` command group; `doctor` is available on the
standalone `remnic` binary too.

```bash
# Migration telemetry and last-cycle summary
openclaw engram tier-status

# One bounded migration pass; dry-run by default
openclaw engram tier-migrate --dry-run --limit 50

# Tier distribution summary (hot/cold counts, status breakdown, recent migrations)
openclaw engram tier list

# Per-memory tier explain
openclaw engram tier explain <id>

# Explain the most recent recall snapshot
openclaw engram recall-explain --format json

# Standalone health check including tier distribution
remnic doctor
```

`tier-status` reports cumulative migration counters plus the latest cycle summary
(`cycles`, `scanned`, `migrated`, `promoted`, `demoted`, `errors`).

`tier-migrate` runs one bounded maintenance pass. It defaults to dry-run; pass
`--write` to apply mutations after reviewing the reported plan.

`recall-explain` reports the most recent recall snapshot (or a session selected
with `--session`) and can emit either text or JSON.

`remnic doctor` includes a `tier_distribution` check that shows hot/cold counts,
forgotten-memory count, top status breakdown, recent migrations (last 7 days from
the migration journal), and top demotion reasons — all without any mutations.

## Purge command

`openclaw engram purge` is the operator-facing hard-delete surface for year-2
retention:

```bash
# Preview what would be deleted (dry-run; no --confirm needed)
openclaw engram purge --older-than P1Y --tier cold --dry-run

# Execute: hard-delete cold memories older than 1 year
openclaw engram purge --older-than P1Y --tier cold --confirm yes

# Hard-delete only forgotten memories across all tiers older than 90 days
openclaw engram purge --older-than P90D --tier all --forgotten-only --confirm yes
```

`--older-than` accepts ISO 8601 durations (`P1Y`, `P90D`, `P6M`) or plain days
(`365`, `90`).

`--tier` defaults to `cold`. Use `--tier all` to target hot, cold, and archived
memories.

`--confirm yes` is required to execute mutations; any other value (or omitting the
flag) forces dry-run. The literal string `"yes"` is the only accepted value — no
substitutes.

All purges are logged to `<memoryDir>/state/observation-ledger/purge-audit.jsonl`
before the function returns. The QMD index is updated after each deletion so the
search index stays consistent.

Implemented in `packages/remnic-core/src/maintenance/purge.ts`.

## Doctor tier section

`remnic doctor` includes a `tier_distribution` section that calls
`summarizeTiers()` from `maintenance/tier-stats.ts`. It shows:

- Hot and cold memory counts
- Forgotten memory count
- Per-status breakdown (active, archived, superseded, forgotten, …)
- Recent migrations in the last 7 days (from the tier-migration journal)
- Top demotion reasons from the journal

The check is always `ok` — it is informational, never a gate.

## First-start migration

When `lifecyclePolicyEnabled: true` and `qmdTierMigrationEnabled: true` are set for
the first time on a memoryDir that has never been touched by the lifecycle policy,
a one-time rate-limited demotion sweep runs automatically during orchestrator
deferred initialization.

The sweep is capped at 50 demotions per run (`FIRST_START_DEMOTION_CAP = 50`) so a
large pre-existing corpus does not stall startup. It is resumable: a state marker
file `<memoryDir>/state/.lifecycle-init-done` is written after all mutations
succeed. Subsequent starts see the marker and skip the sweep.

The sweep is idempotent and safe to run multiple times (as long as the marker is
absent): it only demotes hot memories that already score below the configured
demotion threshold and meet the minimum age requirement.

Implemented in `packages/remnic-core/src/maintenance/first-start-migration.ts`;
hooked into `orchestrator.ts:deferredInitialize()`.

## Cold QMD opt-in

To search the cold QMD collection on hot misses:

```json
{
  "qmdColdTierEnabled": true
}
```

When enabled, `applyColdFallbackPipeline` queries the cold QMD collection only
after the hot-tier search returns no results. If cold QMD is disabled or returns no
hits, generic recall does not read archive records. Default off because the
long-tail rarely contributes a recall worth the latency.

## Configuration knobs

| Key                                       | Default                | Purpose                                       |
|-------------------------------------------|-----------------------:|-----------------------------------------------|
| `lifecyclePolicyEnabled`                  | `true`                 | Enable lifecycle scoring (on since #686).     |
| `lifecyclePromoteHeatThreshold`           | `0.55`                 | Heat threshold for validated/active transitions. |
| `lifecycleStaleDecayThreshold`            | `0.65`                 | Decay threshold for the stale state.          |
| `lifecycleArchiveDecayThreshold`          | `0.85`                 | Decay threshold for the archived state.       |
| `lifecycleProtectedCategories`            | (5 categories)         | Categories never demoted automatically.       |
| `lifecycleMetricsEnabled`                 | mirrors policy         | Emit lifecycle metrics for inspection.        |
| `lifecycleFilterStaleEnabled`             | `false`                | Filter stale lifecycle memories from recall.  |
| `qmdTierMigrationEnabled`                 | `false`                | Enable value-aware hot/cold tier migration.   |
| `qmdTierDemotionMinAgeDays`               | `14`                   | Minimum age before hot→cold demotion.         |
| `qmdTierDemotionValueThreshold`           | `0.35`                 | Value score threshold for hot→cold demotion.  |
| `qmdTierPromotionValueThreshold`          | `0.7`                  | Value score threshold for cold→hot promotion. |
| `qmdColdTierEnabled`                      | `false`                | Query cold QMD after hot misses.              |
| `qmdColdCollection`                       | `openclaw-engram-cold` | QMD collection name for the cold tier.        |

See [Config reference](config-reference.md) for the full schema.

## Auditing the substrate

Three signals together let an operator confirm the policy is doing the right thing:

1. `openclaw engram tier-status` — are migration cycles running and moving the
   expected counts?
2. `openclaw engram tier-migrate --dry-run --limit 50` — what would the next
   bounded migration pass move?
3. `openclaw engram recall-explain --format json` — for a surprising recall, which
   snapshot and tier signals were recorded?

When the answer is "the policy is right but the threshold is wrong," tune the
`lifecycle*` and `qmdTier*` config knobs and re-run the aged-dataset bench to
verify.

## Caveats

- Migration only runs when you opt in. Turning on `lifecyclePolicyEnabled` alone
  scores memories but never demotes them; you also need `qmdTierMigrationEnabled`.
- Cold-tier search adds latency on hot misses. Leave `qmdColdTierEnabled` off
  unless recall is genuinely missing long-tail facts.
- `purge` is a hard delete. Always run with `--dry-run` first; only
  `--confirm yes` executes.
- A dedicated soft-delete restore surface (to reverse `openclaw engram forget`
  within the retention window) remains future work on this branch.

## Provenance

This document tracks issue
[#686 — Year-2 retention: scaling decay, index pruning, and forgetting at scale](https://github.com/joshuaswarren/remnic/issues/686),
delivered across six PRs: recall-path audit + cold-tier exclusion test (#693,
merged), the aged-dataset bench harness (#698, merged), the lifecycle-default and
migration-gate follow-up (#707), the forgotten-tier soft-delete surface (#708), the
operator-visibility CLI (#709), plus the purge CLI, doctor tier section, and
first-start migration.
