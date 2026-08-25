# Procedural memory

Procedural memories are first-class **`category: procedure`** items stored under `memoryDir/procedures/YYYY-MM-DD/` as markdown (same persistence path as other memories via `StorageManager.writeMemory`). They capture ordered **steps** (human-editable in the body) plus YAML frontmatter for lifecycle, provenance, and review state.

This feature tracks [issue #519](https://github.com/joshuaswarren/remnic/issues/519).

Also indexed from the repo [README](../README.md) (Features + Configuration), [Getting started](getting-started.md) (Next steps), and [Config reference](config-reference.md) (Procedural memory section) so operators and agents see the **`procedural.enabled`** gate without opening this page first.

## Enablement

Everything behavioral is gated by plugin config **`procedural.enabled`** (default **`true`** since issue #567 PR 4/5; previously `false`). When explicitly disabled (`false`, `"0"`, `"no"`, or `"off"`):

- Direct extraction does not emit new procedure memories.
- Intent-gated recall does not inject a procedure section.
- The nightly miner MCP entry returns without writing files.

Operators who want to stay opt-out must set `procedural.enabled: false` explicitly, or select the **conservative** memory-OS preset, which pins `procedural.enabled: false` against the default-on flip. Mirror the same keys under `openclaw.plugin.json` / host config as for other Remnic toggles.

### Migration from default-off

If you are upgrading from a Remnic build where procedural memory shipped disabled (pre-#567), no action is required — existing memories and trajectory records continue to work. Fresh installs and any config that omits `procedural.enabled` now enable the feature using the safer-by-default thresholds from slice 3 (`successFloor=0.75`, `lookbackDays=14`, `recallMaxProcedures=2`). The lift number justifying the flip is documented in [`docs/benchmarks/procedural-recall.md`](./benchmarks/procedural-recall.md) and captured in the committed `packages/bench/baselines/procedural-recall-baseline.json` artifact.

## Taxonomy and filing

- `MemoryCategory` includes `"procedure"`.
- Default taxonomy exposes a **`procedures`** bucket (priority between principles and entities).
- `category-dir` maps `procedure` → `procedures/`.

## Extraction (user-taught workflows)

When the extractor proposes `category: "procedure"`, the **extraction judge** requires at least **two steps** and **explicit trigger-style** phrasing before the memory is accepted. Failed checks drop the candidate rather than downgrading silently.

## Recall (task initiation)

On prompts that look like **starting hands-on work** (deploy, ship, open a PR, run tests, etc.), the orchestrator may inject a **`## Relevant procedures`** block built from **active** procedure files only. **`pending_review`** miner suggestions are not injected by default.

Promoted session-end experience memories (issue #2979) are `category: procedure` and compete for the same `recallMaxProcedures` slots. They stay out of injection while `pending_review`. When `sessionExperience.enabled` is on, a matching `experience_situation` can win a slot and renders as an `Experience.` preview. The gate-off path does not inspect experience attributes.

Relevant config keys include:

- `procedural.recallMaxProcedures` — cap on injected procedure previews. **Default `2`** (lowered from the earlier `3` in issue #567 PR 3/5 to keep procedural injection from crowding out other recall sections once the feature is enabled by default).

See also: [Advanced retrieval](./advanced-retrieval.md) and [Retrieval pipeline](./architecture/retrieval-pipeline.md).

## Safer-by-default thresholds (issue #567 PR 3/5)

The procedural mining + recall defaults are tuned so the feature stays safe when it is enabled by default in the slice-4 config flip:

| Key | Default | Notes |
| --- | ------- | ----- |
| `procedural.minOccurrences` | `3` | At least three clustered trajectories before a candidate procedure is emitted. Set to `0` to disable mining entirely. |
| `procedural.successFloor` | `0.75` | Miner promotion requires ≥ 75% trajectory success. Raised from `0.7` in #567 PR 3 to reduce false positives. |
| `procedural.autoPromoteOccurrences` | `8` | When auto-promote is on, pending_review procedures wait for eight occurrences before becoming active. |
| `procedural.lookbackDays` | `14` | Trajectory miner window. Lowered from `30` in #567 PR 3 so mined procedures stay recent. |
| `procedural.recallMaxProcedures` | `2` | Cap on injected procedure previews per recall. Lowered from `3` in #567 PR 3. |

Operators who need to override any of these should do so explicitly; all fields accept CLI-style string inputs and JSON numbers.

## Mining (trajectories)

A dedicated miner clusters **causal trajectory** records (bounded lookback by `recordedAt` / `lookbackDays`) and can write **`status: pending_review`** procedure candidates. Promotion to **`active`** respects optional auto-promote rules and avoids clobbering user-edited bodies.

When `sessionExperience.enabled` is on, promoted session-end experience memories (issue #2979) join that same input set: `experience_situation` is the cluster goal, `experience_approach` / `experience_reflection` fill the trajectory summaries, and `pending_review` episodes stay out. Gate off leaves miner input byte-identical to the trajectory-only set.

Automation is **not** part of `runMemoryGovernance`. Use the MCP tool **`remnic.procedure_mining_run`** (legacy alias **`engram.procedure_mining_run`**), with optional cron registration mirroring other nightly jobs, so procedural mining stays isolated from shadow/apply governance.

## Stats surface (issue #567 PR 5/5)

Operators can inspect procedural memory health via three matched surfaces that all return the same `ProcedureStatsReport` JSON shape (schema v1):

- **CLI:** `remnic procedural stats [--format json|text] [--memory-dir <path>]`
- **HTTP:** `GET /engram/v1/procedural/stats?namespace=<optional>`
- **MCP tool:** `remnic.procedural_stats` (with legacy alias `engram.procedural_stats`), argument `{ namespace?: string }`

The report includes:

- `counts` — procedure files by status: `total`, `active`, `pending_review`, `rejected`, `quarantined`, `superseded`, `archived`, `other`.
- `recent` — `lastWriteAt` (ISO 8601 or `null`), `writesLast7Days` (exclusive upper bound per CLAUDE.md rule 35), and `minerSourced` count (procedures whose `source=procedure-miner`).
- `maintenance` — `lastMaintenanceAt` (ISO 8601 or `null`, from the library-maintenance run marker, issue #2370) and `needsRepairFlags` (active procedures carrying a `needsRepair` structured attribute).

All three surfaces are read-only and namespace-scoped (CLAUDE.md rule 42). The HTTP endpoint resolves the namespace through the same layer used by `/recall/explain` and `/trust-zones/status`; the MCP tool uses the authenticated principal. The CLI reads from whatever `memoryDir` the current config / active-space resolves to, or an explicit `--memory-dir` override.

## Library health maintenance (issue #2370)

The store only growing was the gap: the miner adds, auto-promote activates,
and nothing ever merged, repaired, or retired. The maintenance job consumes
telemetry Remnic already records — `mw_success` / `mw_fail` counters,
`lastAccessed`, causal trajectories — and proposes transitions for ACTIVE
procedures only. `pending_review`, `rejected`, `quarantined`, `superseded`,
and `archived` procedures are never candidates.

Shadow-first: a run without `apply` produces a report and writes nothing —
not even the run marker. Applying requires `apply: true` (CLI `--apply`)
**and** `procedural.maintenance.enabled: true` in config. Like mining, the
job is deliberately not part of `runMemoryGovernance` (same isolation
decision).

Actions, in evaluation order per run:

1. **Merge** — clusters active procedures by normalized trigger phrase +
   step signature (ordered intents + tool calls). The most-recently-updated
   member becomes canonical; the rest are `superseded` with `supersededBy`.
   The canonical is stamped with the issue-#687 contract (`reinforcement_count`,
   `last_reinforced_at`, `derived_via: pattern-reinforcement`, `derived_from`)
   so `patterns explain` reads procedure canonicals unchanged. Clusters with
   user-edited bodies are flagged, never merged.
2. **Repair flag** — procedures whose step tools no longer appear in the
   last `lookbackDays` of causal trajectories get
   `structuredAttributes.needsRepair` (`{ reason, detectedAt }`). Bodies are
   never rewritten — autonomous revision underperforms curation, so repair
   is a review action.
3. **Retire** — demote to `archived` (never delete; page versioning
   snapshots every overwrite) when EITHER failure-dominant
   (`mw_fail >= retireMinOutcomes` AND `mw_fail > mw_success × retireFailRatio`)
   OR idle (`retireIdleDays` without an access signal AND zero recorded
   outcomes; `retireIdleDays: 0` disables idle retirement). User-edited
   procedures are exempt and flagged instead.

A procedure counts as user-edited when its body no longer round-trips
through the miner's own step serializer — the stateless equivalent of "body
hash differs from last mined write".

Procedures are eligible for `memory_outcome` (issue #2370): injected
procedures flow into the same per-recall bookkeeping as other memories
(`LastRecallSnapshot.memoryIds`, access tracking), so success/failure
judgments land on their `mw_*` counters.

Surfaces:

- CLI: `remnic procedural maintain [--apply] [--format json|text]`
- MCP: `remnic.procedure_library_maintenance` (alias
  `engram.procedure_library_maintenance`), args `{ namespace?, apply?, dryRun? }`
  — the authenticated principal drives the namespace, never a client-supplied actor.

Config (see [config-reference.md](config-reference.md) for the full table):
`procedural.maintenance.{enabled, retireIdleDays, retireMinOutcomes,
retireFailRatio, mergeEnabled}`.

Out of scope: automatic body rewriting, outcome-weighted recall ranking
(hypothesis H1, #1958), and non-procedural pattern reinforcement (#687
scope unchanged).

## Pattern reinforcement CLI (issue #687 PR 4/4)

The pattern-reinforcement CLI ships on the OpenClaw-hosted surface as `openclaw engram patterns`; there is no standalone `remnic patterns` command. The command group exposes the pattern-reinforcement output written by the maintenance job (PR 2/4). Both subcommands read from the active `memoryDir` and require no extra config.

### `openclaw engram patterns list`

Lists memories whose `reinforcement_count > 0`, sorted by count descending.

```bash
openclaw engram patterns list [--limit N] [--category cat1,cat2] [--since ISO] [--format text|markdown|json]
```

| Flag | Description | Default |
| --- | --- | --- |
| `--limit N` | Maximum rows to show (positive integer) | 50 |
| `--category list` | Comma-separated category filter | all categories |
| `--since ISO` | Only include memories reinforced on or after this ISO 8601 timestamp | all time |
| `--format fmt` | Output format: `text`, `markdown`, or `json` | `text` |

### `openclaw engram patterns explain <memoryId>`

Shows the full reinforcement picture for a single canonical: reinforcement count, `last_reinforced_at`, `derived_from` provenance chain (page-version refs stamped by PR 2/4), canonical body, and cluster members (memories whose `supersededBy` points at this canonical).

```bash
openclaw engram patterns explain <memoryId> [--format text|markdown|json]
```

Exits with code `1` and a descriptive error if `<memoryId>` is not found or has no `reinforcement_count > 0`.

Invalid flag values (`--format xml`, `--limit 0`, `--since not-a-date`) throw a listed-options error rather than silently defaulting (CLAUDE.md rule 51).

## Portable skill bundles (issue #2369)

Active procedures project into the `skills/<slug>/SKILL.md` layout that Codex
and Claude Code already load, so a procedure learned in one host is readable,
versionable, and shareable rather than private agent state.

What is projected: `category: procedure` memories with `status: active` and
nothing else. `pending_review`, `rejected`, `quarantined`, `superseded`,
`archived`, and `forgotten` procedures never reach a host skills directory.
Slugs derive deterministically from the procedure title, collide-free within a
batch, and get a `user-` prefix when they would shadow a built-in Remnic skill.
Provenance rides in namespaced frontmatter keys (`x-remnic-memory-id`,
`x-remnic-updated`, `x-remnic-source`) so re-projection is idempotent.

### Codex materialization

Set `procedural.skillProjection.enabled: true` (default `false`) to add a
`skills/` section to the Codex materializer. It obeys every existing
materializer invariant: the `.remnic-managed` sentinel opt-in, atomic
tmp-then-rename writes, content-hash no-ops, and no writes outside
`<codex_home>/memories`. Retired procedures lose their projected folder on the
next run; the sentinel records which slugs Remnic projected, so a hand-created
skill folder is never a removal candidate. `maxSkills: 0` disables projection.

### Export

```bash
remnic export skills --out ./exported-skills [--max-skills 20] [--namespace <ns>]
```

Writes `<out>/<slug>/SKILL.md` for each projected procedure. Read-only with
respect to memory, and it never deletes anything in the target directory. Works
regardless of `procedural.skillProjection.enabled` (an explicit user action),
but requires `procedural.enabled`.

### Import (review-gated)

```bash
remnic import skills ./some-skills-dir [--namespace <ns>]
```

Walks `<dir>/<slug>/SKILL.md`, parses the frontmatter and `## Step N` sections
(a step-less body is stored verbatim), and writes `category: procedure`
memories with **`status: pending_review`** and `source: skill-import`. Imported
procedures never auto-promote, whatever `procedural.autoPromoteOccurrences`
says: recall injects only active procedures, so review is the promotion
checkpoint. The import triggers a search reindex so approved procedures are
discoverable.

Import safety:

- Imported skills are inert data. Nothing in a bundle is ever executed, and no
  tool is registered. A bundle containing `scripts/` or other resources imports
  the SKILL.md text only and sets `structuredAttributes.hasUnimportedResources`
  so a reviewer can see what was left behind.
- Symlinked roots, symlinked bundle directories, symlinked `SKILL.md` files, and
  anything resolving outside the requested directory are skipped with a reason.

## Benchmark

The **`procedural-recall`** benchmark in `@remnic/bench` scores:

1. **Task initiation gate** — deterministic intent classification vs. labeled prompts.
2. **Procedure section gate** — temp `memoryDir` round-trip: whether a non-null recall section is produced when expected (feature on/off and non-task prompts).

Run a quick pass:

```bash
npm run bench:run -- --quick procedural-recall
```
