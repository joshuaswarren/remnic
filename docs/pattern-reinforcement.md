# Pattern reinforcement

Pattern reinforcement generalizes Remnic's procedural-memory miner into a universal
mechanism: any observation that recurs across sessions is merged into a single
*reinforced primitive* with a confidence boost, whether it is a procedure, a fact,
or a preference. Enable it when you want repeated preferences, facts, and decisions
to consolidate and outrank one-off mentions instead of accumulating as duplicates.

**Opt-in via `patternReinforcementEnabled` (default `false`).** The recall boost for
reinforced primitives is a second, independent opt-in
(`reinforcementRecallBoostEnabled`, default `false`).

## Enable it

```json
{
  "patternReinforcementEnabled": true
}
```

That turns on the maintenance job with a weekly cadence and the default categories.
To also weight reinforced primitives higher in recall, add
`reinforcementRecallBoostEnabled: true` (see [Recall boost](#recall-boost)).

## Concept

The procedural miner already detects recurring multi-step runbooks. Pattern
reinforcement extends that principle to all configurable memory categories:

- A user expressing the same preference across 30 sessions → reinforced preference
  primitive.
- A debugging pattern recurring across 20 sessions in different repos → reinforced
  engineering practice.
- The same project context referenced repeatedly → reinforced project anchor.

The procedural miner is unchanged. Pattern reinforcement runs as a **separate
maintenance job** on a configurable cadence and considers only the categories you
configure (default: `preference`, `fact`, `decision`).

## Reinforcement model

The job runs `runPatternReinforcement()` from
`packages/remnic-core/src/maintenance/pattern-reinforcement.ts` using a storage
interface that accepts any `StorageManager`-compatible implementation.

### Cluster key

Each memory is keyed by `category::normalizedContent`:

```text
normalizedContent = content.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200)
key               = `${category}::${normalizedContent}`
```

Truncating to 200 characters means long-form content with a stable opening still
clusters together even when the tail differs slightly. The category prefix ensures
that identical text in different categories (e.g., a `fact` and a `decision` with
the same wording) is never cross-superseded.

### What gets reinforced

The job:

1. **Clusters** all active and superseded memories in the configured categories by
   cluster key. Forgotten, archived, quarantined, pending_review, and rejected
   memories are excluded.
2. **Picks the most-recent active member** of each cluster with
   `cluster.size >= minCount` as the **canonical**.
3. **Stamps the canonical** with `reinforcement_count` (total cluster size) and
   `last_reinforced_at` (ISO 8601). Provenance fields `derived_from` (source IDs)
   and `derived_via: "pattern-reinforcement"` are also written.
4. **Marks older duplicates** `status: "superseded"` with a `supersededBy` pointer
   to the canonical's ID.

The job is idempotent for the **counter**: re-running on the same corpus does not
double-bump `reinforcement_count`. The bump-only-on-change guard compares cluster
size to the canonical's previous counter and bumps only when it grew.

The canonical's frontmatter can still be rewritten on a re-run when the **cluster
membership** changes (new sources joined or older sources rotated out, even at the
same total count) or when **`derived_via`** needs to be set to
`"pattern-reinforcement"` for the first time. In those cases the job updates
`derived_from` and `updated` to keep provenance accurate while leaving
`reinforcement_count` unchanged. Treat these refresh writes as the steady-state
cost of accurate provenance, not as counter drift.

### YAML frontmatter fields

Reinforced canonicals carry these additional fields:

```yaml
reinforcement_count: 12
last_reinforced_at: "2026-04-27T08:00:00.000Z"
derived_from:
  - mem_abc123
  - mem_def456
  - mem_ghi789
derived_via: "pattern-reinforcement"
```

Superseded duplicates carry:

```yaml
status: superseded
supersededBy: mem_jkl012
```

## Configuration

```json
{
  "patternReinforcementEnabled": true,
  "patternReinforcementCadenceMs": 604800000,
  "patternReinforcementMinCount": 3,
  "patternReinforcementCategories": ["preference", "fact", "decision"]
}
```

| Key | Default | Notes |
| --- | ------- | ----- |
| `patternReinforcementEnabled` | `false` | Master gate. Set to `true` to enable the maintenance job. |
| `patternReinforcementCadenceMs` | `604800000` (7 days) | Minimum milliseconds between runs. Set to `0` to disable cadence gating (run on every invocation of the MCP/cron trigger). |
| `patternReinforcementMinCount` | `3` | Minimum cluster size before a canonical is promoted. Clamped to `[2, 1000]`; clusters of 1 are degenerate. |
| `patternReinforcementCategories` | `["preference", "fact", "decision"]` | Categories the job scans. An empty array means no categories are processed. |

The cadence guard is **entirely in-memory** and is NOT derived from the
`last_reinforced_at` field written to memory frontmatter. The orchestrator keeps a
`lastPatternReinforcementAtByNs` map (keyed by namespace) that records the
epoch-ms timestamp when each run completes. If
`Date.now() - lastRunAt < patternReinforcementCadenceMs`, the job returns early
with `skippedReason: "cadence"`.

Because the map is in-process, it resets on every process restart. A freshly
restarted gateway always runs the job on the first invocation that follows,
regardless of when the previous process last ran it. Operators who need
cross-restart cadence control should rely on external scheduling — for example a
system cron job that calls the `remnic.pattern_reinforcement_run` MCP tool on a
fixed interval — rather than the in-process gate alone. Set
`patternReinforcementCadenceMs: 0` to disable cadence gating entirely.

## Recall boost

Reinforced primitives can be weighted higher in recall. This is **opt-in**
(`reinforcementRecallBoostEnabled`, default `false`):

```json
{
  "reinforcementRecallBoostEnabled": true,
  "reinforcementRecallBoostMax": 0.3
}
```

| Key | Default | Notes |
| --- | ------- | ----- |
| `reinforcementRecallBoostEnabled` | `false` | When `true`, memories with `reinforcement_count > 0` receive an additive score boost. |
| `reinforcementRecallBoostMax` | `0.3` | Maximum additive reinforcement boost per result. Range `[0, 1]`. |
| `reinforcementRecallBoostWeight` | `0.05` | Per-unit boost multiplier. |

The formula:

```text
boost = min(reinforcementRecallBoostMax, reinforcementRecallBoostWeight × reinforcement_count)
```

A memory reinforced 12 times with the default weight and max receives
`min(0.3, 0.05 × 12) = min(0.3, 0.6) = 0.3` — the cap.

### X-ray surfacing

When `reinforcementRecallBoostEnabled` is on and a result actually received a
non-zero boost (`reinforcementBoost > 0`), Recall X-ray attaches the value to the
per-result `explain` object, formatted inline as `reinforcement_boost=<value>`
alongside the other score components (`importance`, `mmr_penalty`, `tier_prior`,
etc.). Results that did not receive a boost omit the field. This makes it easy to
audit which results were boosted by pattern reinforcement vs. which won on raw
relevance. See [Recall X-ray](xray.md) for the full per-result explain schema.

## Inspecting reinforced patterns

The `patterns` command group is hosted by the OpenClaw plugin runtime under the
`engram` group. Both subcommands read from the active `memoryDir` and require no
extra config.

### `openclaw engram patterns list`

Lists memories whose `reinforcement_count > 0`, sorted by count descending.

```bash
openclaw engram patterns list [--limit N] [--category cat1,cat2] [--since ISO] [--format text|markdown|json]
```

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--limit N` | `50` | Maximum rows to show (positive integer). |
| `--category list` | all categories | Comma-separated category filter (e.g. `preference,fact`). |
| `--since ISO` | all time | Only include memories reinforced on or after this ISO 8601 timestamp. |
| `--format fmt` | `text` | Output format: `text`, `markdown`, or `json`. |

Example output (`--format text`):

```text
Pattern memories (3):

  [12x] mem_jkl012  (preference, last_reinforced=2026-04-27T08:00:00.000Z, status=active)
        prefer short inline comments over block comments for single-line notes...
        path: memories/preferences/mem_jkl012.md
  [8x] mem_abc456  (fact, last_reinforced=2026-04-20T10:00:00.000Z, status=active)
        the project uses pnpm workspaces...
        path: memories/facts/mem_abc456.md
```

### `openclaw engram patterns explain <memoryId>`

Shows the full reinforcement picture for a single canonical:

- `reinforcement_count` and `last_reinforced_at`
- `derived_from` source memory IDs stamped by the maintenance job
- Canonical body
- Cluster members — memories whose `supersededBy` points at this canonical

```bash
openclaw engram patterns explain <memoryId> [--format text|markdown|json]
```

Exits with code `1` and a descriptive error if `<memoryId>` is not found or has no
`reinforcement_count > 0`. Invalid flag values (`--format xml`, `--limit 0`,
`--since not-a-date`) throw a listed-options error rather than silently defaulting.

```text
$ openclaw engram patterns explain mem_jkl012
Pattern: mem_jkl012
  reinforcement_count: 12
  last_reinforced_at: 2026-04-27T08:00:00.000Z
  category:           preference
  status:             active
  derived_via:        pattern-reinforcement
  path:               memories/preferences/mem_jkl012.md

Canonical content:
  prefer short inline comments over block comments for single-line notes.

Derived from (2):
  - mem_abc123
  - mem_def456

Cluster members (2):
  - mem_abc123 (status=superseded, supersededAt=2026-04-27T08:00:00.000Z)
      prefer terse implementation comments.
  - mem_def456 (status=superseded, supersededAt=2026-04-27T08:00:00.000Z)
      avoid block comments unless they explain a larger invariant.
```

## Triggering the job

Pattern reinforcement is **not** triggered automatically by the Dreams REM phase.
The runtime call site is `EngramAccessService.patternReinforcementRun`, exposed
through:

- **MCP tool:** `remnic.pattern_reinforcement_run` (canonical) /
  `engram.pattern_reinforcement_run` (legacy alias)
- **Maintenance scheduler / cron:** the job can be registered as a standalone
  maintenance cron entry

To trigger an ad-hoc run, call the MCP tool:

```json
{ "name": "remnic.pattern_reinforcement_run", "arguments": {} }
```

Pass `"force": true` to bypass the in-process cadence gate for an immediate run.
For the separate procedural miner, use `remnic.procedure_mining_run`.

## Relationship to procedural memory

Pattern reinforcement and the procedural miner are **siblings**, not replacements:

| Aspect | Procedural miner | Pattern reinforcement |
| ------ | ---------------- | --------------------- |
| Input | Causal trajectory records | All memories in configured categories |
| Cluster key | `${goal}\|${entityRefs}` from trajectory | `${category}::${normalizedContent(200)}` |
| Output | `category: procedure` with ordered steps | `reinforcement_count` + `last_reinforced_at` on any category |
| Min threshold | `procedural.minOccurrences` (default `3`) | `patternReinforcementMinCount` (default `3`) |
| Config gate | `procedural.enabled` (default `true`) | `patternReinforcementEnabled` (default `false`) |
| Recall injection | Task-initiation procedure block | Score boost via `reinforcementRecallBoostEnabled` |

Procedure memories are not in the default `patternReinforcementCategories` list, so
the two pipelines do not interfere.

## Caveats

- The job merges duplicates by normalized content; it does not do semantic
  clustering. Reworded-but-equivalent memories with different opening text will not
  cluster.
- The recall boost is off by default. Enabling reinforcement alone stamps counters
  but does not change ranking until `reinforcementRecallBoostEnabled` is on.
- The cadence gate is in-process only; use external scheduling for cross-restart
  cadence control.

## Cross-references

- [Procedural memory](procedural-memory.md) — the procedure-specific miner that
  ships alongside.
- [Recall X-ray](xray.md) — surfacing `reinforcementBoost` in the score
  decomposition.
- [Dreams: phased consolidation](dreams.md) — pattern-reinforcement scheduling is
  independent of the Dreams pipeline.

## Provenance

Pattern reinforcement tracks issue
[#687](https://github.com/joshuaswarren/remnic/issues/687): a bench fixture repeats
one preference across 30 sessions and reinforcement merges them into a single
primitive within one maintenance cycle, reinforced primitives outrank one-shot
equivalents in recall (with the boost enabled),
`openclaw engram patterns explain <id>` traces a primitive back to its sources, and
the procedural miner is unchanged.
