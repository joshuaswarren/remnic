# Dreams: named, phased consolidation

**Dreams** is Remnic's name for the background consolidation pipeline that runs
between user-facing turns: scoring recent activity, synthesising and de-duplicating
across sessions, promoting durable findings, and migrating cold material out of the
hot working set. The pipeline is split into three named phases that mirror the
biological metaphor so operators have one mental model and one vocabulary.

**Default posture:** the three phases mirror existing lifecycle gates. **Light
sleep** runs by default (it mirrors `lifecyclePolicyEnabled`, default `true`); **REM**
is off by default (mirrors `semanticConsolidationEnabled`, default `false`); **deep
sleep** is off by default (it turns on only when nightly governance, tier migration,
or page-versioning is enabled). The separate `dreaming` **diary** surface is a
different feature and is off by default (`dreaming.enabled`, default `false`).

## The three phases

1. **Light sleep** — recent activity scoring and clustering.
2. **REM** — cross-session synthesis, supersession resolution, and semantic
   consolidation.
3. **Deep sleep** — promotion to durable memory, hot→cold tier migration,
   page-version snapshots, and archive.

Every phase is implemented by code that ships today. The phase boundaries are a
descriptive grouping over existing primitives, not new behavior.

## Enable it

Each phase reads its own gates. The unified `dreams.phases.*` block groups them and
wins over the legacy top-level keys when set:

```json
{
  "dreams": {
    "phases": {
      "lightSleep": { "enabled": true },
      "rem": { "enabled": true },
      "deepSleep": { "enabled": true }
    }
  }
}
```

**Precedence (highest to lowest):**

- `dreams.phases.lightSleep.enabled` > `lifecyclePolicyEnabled`
- `dreams.phases.rem.enabled` > `semanticConsolidationEnabled`
- `dreams.phases.deepSleep.enabled` > (no legacy top-level equivalent)

`dreams` (the consolidation pipeline) is a **different config namespace** from
`dreaming` (the diary surface). Setting `dreaming.enabled` does not turn on
consolidation, and enabling a dreams phase does not write a diary. When a value is
set under `dreams.phases.*` it wins; the legacy top-level keys still parse so
existing configs keep working.

## Naming note: three "dreams" concepts in the codebase

Remnic uses the word "dreams" for three adjacent things. The unqualified name
**"dreams"** — in this document, in the `dreams.phases.*` config block, the
`openclaw engram dreams` CLI, and the `engram.dreams_status` MCP tool — refers
exclusively to the consolidation pipeline.

| Concept | Where it lives | What it is |
|---|---|---|
| **Dreams (this document)** — consolidation pipeline | `packages/remnic-core/src/maintenance/`, `semantic-consolidation.ts`, `tier-routing.ts`, `tier-migration.ts`, `temporal-supersession.ts`, `summarizer.ts`, `summary-snapshot.ts`, `page-versioning.ts`, `hygiene.ts`, `lifecycle.ts` | The phased background process described here. |
| **Dreams diary surface** | `packages/remnic-core/src/surfaces/dreams.ts` | Markdown-fragment surface that parses `<!-- openclaw:dreaming:diary:start -->` / `<!-- openclaw:dreaming:diary:end -->` markers in MEMORY-style files. Exposes `read` / `append` / `watch`. Gated by `dreaming.enabled`. Unrelated to consolidation phases. |
| **`memoryKind: "dream"` frontmatter** | YAML frontmatter on memory files; recognised in `orchestrator.ts` and storage paths | A memory category. A single-fact tag, not a process. |

When reading code, treat `packages/remnic-core/src/surfaces/dreams.ts` as the
diary, and treat anything under `maintenance/` plus the consolidation modules above
as the pipeline.

## Phase mapping

Each named phase maps to the existing modules that implement it.

| Phase | What runs | Existing modules |
|---|---|---|
| **light sleep** | Recent activity scoring and clustering — assigns a value score to each candidate memory based on hits, recency, and lifecycle signals; emits an observation-ledger entry; updates the recent buffer state. | `tier-routing.ts` (`computeTierValueScore`, `decideTierTransition`), `lifecycle.ts` (heat / decay thresholds), `maintenance/observation-ledger-utils.ts`, `maintenance/rebuild-observations.ts`, buffer state in `buffer.ts`. |
| **REM** | Cross-session synthesis: cluster similar facts, resolve supersessions where a newer fact replaces an older one, and run semantic consolidation (SPLIT / MERGE / UPDATE) over the clusters. Emits summary snapshots. | `semantic-consolidation.ts` (`findSimilarClusters`, `buildConsolidationPrompt`, `chooseConsolidationOperator`, `parseOperatorAwareConsolidationResponse`), `temporal-supersession.ts` (`computeSupersessionKey`, `shouldSupersedeExisting`), `summarizer.ts`, `summary-snapshot.ts`, `consolidation-operator.ts`, `consolidation-provenance-check.ts`. |
| **deep sleep** | Promotion to durable memory, hot→cold tier migration, page-version snapshotting on every overwrite, and archive of stale or low-value entries. | `tier-migration.ts` (`migrateMemory`, hot↔cold journal), `page-versioning.ts` (snapshot/prune by `maxVersionsPerPage`), `hygiene.ts` (file size / archive triggers), `maintenance/archive-observations.ts`, `maintenance/memory-governance.ts`, `maintenance/memory-governance-cron.ts` (the `engram-nightly-governance` cron that orchestrates the deep-sleep run). |

## Config gates per phase

The `dreams.phases.*` block groups these existing keys; the legacy top-level keys
remain readable for backward compatibility.

### Light sleep gates

- `lifecyclePolicyEnabled` — master switch for value-score driven routing. Default
  `true`.
- `lifecycleFilterStaleEnabled` — filter stale entries out of recall. Default
  `false`.
- `lifecyclePromoteHeatThreshold` — value score above which a memory is treated as
  hot.
- `lifecycleStaleDecayThreshold` — value score below which a memory starts to decay.
- `lifecycleArchiveDecayThreshold` — value score below which a memory is eligible
  for archive.
- `lifecycleProtectedCategories` — categories that bypass decay / archive even when
  their score drops.

### REM gates

- `temporalSupersessionEnabled` — supersession resolution at write / consolidation
  time. Default `true`.
- `temporalSupersessionIncludeInRecall` — whether superseded memories surface in
  recall. Default `false`.
- `semanticConsolidationEnabled` — turn on the cluster→merge / split / update LLM
  consolidator. Default `false`.
- `semanticConsolidationModel` — model used for the consolidation call. Falls back
  to the platform default.
- `semanticConsolidationThreshold` — cosine-similarity threshold for cluster
  membership. Default `0.8`.
- `semanticConsolidationMinClusterSize` — minimum cluster size before consolidation
  runs. Default `2` (clamped lower bound).
- `semanticConsolidationExcludeCategories` — categories REM skips entirely.
- `semanticConsolidationIntervalHours` — how often the REM pass runs.
- `semanticConsolidationMaxPerRun` — cap on cluster operations per run, to bound
  cost.
- `consolidationMinIntervalMs` — global minimum gap between consolidation passes
  (default ~10 minutes).
- `consolidationRequireNonZeroExtraction` — only consolidate when the recent
  extraction has produced at least one fact. Default `true`.

`summaryRecallHours` and `summaryModel` are *not* REM-phase gates — they configure
the recall-summaries path in `orchestrator.ts`, not `runSemanticConsolidation`.
Summary snapshots are written from a separate flow
(`HourlySummarizer.saveSummary` / `runHourly` in `summarizer.ts`) that is not gated
by the `semanticConsolidation*` keys; tuning REM settings does not change snapshot
behavior.

### Deep sleep gates

- The `fileHygiene` block (`fileHygiene.enabled`, `fileHygiene.archiveDir`,
  `fileHygiene.lintBudgetBytes`, `fileHygiene.rotateEnabled`,
  `fileHygiene.rotateMaxBytes`, `fileHygiene.warningsLogPath`, …) — drives archive
  and warning emission for files that exceed size thresholds.
- `versioningEnabled` (default `false`) — master switch for page-version snapshots.
  `StorageManager.snapshotBeforeWrite` exits early when this flag is not set, so
  deep-sleep snapshotting is a no-op without it. Enable this *before* tuning the
  retention key below.
- `versioningMaxPerPage` (consumed by `page-versioning.ts` as `maxVersionsPerPage`)
  — retention for the snapshot history that every memory file overwrite produces
  once `versioningEnabled` is `true`. `0` disables pruning.
- The `engram-nightly-governance` cron (`maintenance/memory-governance-cron.ts`) —
  orchestrates the deep-sleep pass on a schedule. That module registers exactly four
  crons: `engram-day-summary`, `engram-nightly-governance`,
  `engram-procedural-mining`, and `engram-contradiction-scan`. Light sleep and REM
  are *not* cron-scheduled — they run inside the orchestrator maintenance pass via
  `runLifecyclePolicyPass` (light sleep) and `runSemanticConsolidation` (REM).
  Per-phase telemetry is wired through both code paths (cron and orchestrator pass)
  so the named-phase view stays consistent regardless of which trigger ran the work.

## Per-phase telemetry

Every phase run — whether triggered by a cron, the orchestrator maintenance pass,
or the `openclaw engram dreams run` CLI — appends one JSONL entry to
`<memoryDir>/state/dreams-ledger.jsonl`:

```jsonc
{
  "schemaVersion": 1,
  "startedAt":     "2026-04-27T02:00:00.000Z",   // ISO-8601
  "completedAt":   "2026-04-27T02:00:05.123Z",
  "durationMs":    5123,
  "phase":         "lightSleep",                  // "lightSleep" | "rem" | "deepSleep"
  "itemsProcessed": 42,
  "dryRun":        false,
  "trigger":       "scheduled",                   // "scheduled" | "manual"
  "notes":         "scored 42 recent observation entries"
}
```

Older ledger entries that predate this schema simply lack the field; the aggregator
treats missing entries as zero runs, so no backfill is required.

## CLI, HTTP, and MCP surfaces

Dreams inspection and manual invocation are hosted by the OpenClaw plugin runtime
under the `engram` command group.

### `openclaw engram dreams status`

```bash
openclaw engram dreams status [--window-hours <n>] [--format text|json|markdown]
```

Reads the dreams ledger and prints a per-phase summary for the last N hours
(default 24). Example text output:

```text
Dreams status (last 24h):
  Window: 2026-04-26T12:00:00.000Z → 2026-04-27T12:00:00.000Z

  Light Sleep:
    Runs:            3
    Total duration:  4521ms
    Items processed: 127
    Last run:        2026-04-27T09:15:00.000Z

  REM:
    Runs:            1
    Total duration:  12450ms
    Items processed: 94
    Last run:        2026-04-27T03:00:00.000Z

  Deep Sleep:
    Runs:            1
    Total duration:  32100ms
    Items processed: 500
    Last run:        2026-04-27T02:23:00.000Z
```

### `openclaw engram dreams run`

`dreams run` triggers a single phase without waiting for the cron — useful for
debugging a phase or verifying that a config change had the expected effect.

```bash
openclaw engram dreams run --phase <phase> [--dry-run] [--format text|json]
```

`--phase` accepts kebab-case (`light-sleep`, `rem`, `deep-sleep`) or camelCase
(`lightSleep`, `rem`, `deepSleep`). `--dry-run` reports what would happen without
committing writes, and does not write a ledger entry so the status surface stays
clean.

```text
$ openclaw engram dreams run --phase light-sleep --dry-run
Dreams run: Light Sleep (dry-run)
  Duration:   12ms
  Items:      84
  Notes:      dry-run: would score 84 observation entries
```

### HTTP

```text
GET  /engram/v1/dreams/status?windowHours=24
POST /engram/v1/dreams/run          { "phase": "lightSleep", "dryRun": true }
```

The status response returns per-phase aggregates:

```jsonc
{
  "windowStart": "2026-04-26T12:00:00.000Z",
  "windowEnd":   "2026-04-27T12:00:00.000Z",
  "phases": {
    "lightSleep": {
      "phase": "lightSleep",
      "runCount": 3,
      "totalDurationMs": 4521,
      "totalItemsProcessed": 127,
      "lastRunAt": "2026-04-27T09:15:00.000Z",
      "lastDurationMs": 1200
    },
    "rem": { },
    "deepSleep": { }
  }
}
```

### MCP tools

`engram.dreams_status` / `remnic.dreams_status` and `engram.dreams_run` /
`remnic.dreams_run` return the same shapes as the HTTP endpoints. `dreams_run`
accepts `{ "phase": "...", "dryRun": true }`; valid phases are `lightSleep`, `rem`,
`deepSleep`.

## Caveats

- The named phases are a grouping over existing lifecycle primitives, not a new
  scheduler. Turning on a phase enables the underlying gates it maps to.
- Deep sleep has no single top-level legacy toggle; it activates through nightly
  governance, tier migration, or page-versioning being enabled.
- `dreams` (consolidation) and `dreaming` (diary) are distinct config namespaces;
  do not conflate them.

## See also

- [Retention policy](retention-policy.md) — value-score model, hot/cold tier
  substrate, and the forget/tier surfaces that deep sleep shares infrastructure
  with.
- [Operations](operations.md) — backup, export, and CLI surfaces that consume the
  same observation ledger as dreams.

## Provenance

The named-phase model and the `dreams.phases.*` config block, telemetry ledger,
CLI, HTTP, and MCP surfaces track issue
[#678](https://github.com/joshuaswarren/remnic/issues/678).
