# Compounding engine

The compounding engine turns cross-agent feedback into persistent institutional learning: weekly synthesis reports, a stable mistake registry, and rubrics that can be injected into future prompts. Enable it when you want agents to accumulate lessons from approvals and rejections over time. Opt-in via `compoundingEnabled` (default `false`).

> Provenance: compounding engine landed in v5.0.

## Enable it

```json
{
  "compoundingEnabled": true,
  "compoundingInjectEnabled": true,
  "compoundingSemanticEnabled": false
}
```

- `compoundingInjectEnabled` (default `true` when compounding is enabled) injects recurring mistake patterns and matching rubric snippets into recall.
- `compoundingSemanticEnabled` (default `false`) adds an advisory `Promotion Candidates` section to weekly reports.

## Inputs

The engine reads shared feedback entries from:
- `shared-context/feedback/inbox.jsonl`

Write feedback via tool:
- `shared_feedback_record`

## Outputs

On each weekly synthesis run, Remnic writes:
- `memoryDir/compounding/weekly/<YYYY-Www>.md`
- `memoryDir/compounding/weekly/<YYYY-Www>.json`
- `memoryDir/compounding/mistakes.json`
- `memoryDir/compounding/rubrics.md`
- `memoryDir/compounding/rubrics/index.json`
- `memoryDir/compounding/rubrics/agents/*.md`
- `memoryDir/compounding/rubrics/workflows/*.md`

The weekly report is written even if there are no feedback entries yet (day-one outcomes).

Weekly reports now include:
- Provenance annotations for feedback-derived patterns (`inbox.jsonl` line + entry key)
- Outcome-aware weighting summaries (`applied/skipped/failed` by action type)
- Optional `Promotion Candidates (Advisory)` section when `compoundingSemanticEnabled=true`
- Stable promotion candidate ids so operators can explicitly promote one lesson into durable memory later

`mistakes.json` is now a backward-compatible stable registry:
- legacy `patterns[]` is preserved for existing readers
- `registry[]` adds stable IDs, recurrence counts, first/last-seen timestamps, scope metadata, tags, and retirement status

`shared_feedback_record` also accepts optional compounding metadata:
- `workflow`
- `severity`
- `confidence`
- `tags`
- `evidenceWindowStart`
- `evidenceWindowEnd`

Promotion candidates are advisory only and do not auto-write into shared memory.
Promotion now happens through an explicit operator path:
- tool: `compounding_promote_candidate`
- CLI: `openclaw engram compounding-promote --week-id <YYYY-Www> --candidate-id <id>`

Promoted lessons are written as durable `principle` or `rule` memories with `source=compounding-promotion`.

When `compoundingInjectEnabled=true`, recall injection can include both recurring mistake patterns and rubric snippets that match the current query/workflow.

## Running weekly synthesis

Manual:

```bash
# via OpenClaw agent tool
compounding_weekly_synthesize
```

Recommended scheduling:
- Use OpenClaw cron with an isolated agent turn that calls `compounding_weekly_synthesize`.

## Continuity audit generation

When `identityContinuityEnabled=true`, `continuityAuditEnabled=true`, and `compoundingEnabled=true`, use:

- `continuity_audit_generate` with `period=weekly|monthly` and optional `key`.

Outputs:
- `memoryDir/identity/audits/weekly/<YYYY-Www>.md`
- `memoryDir/identity/audits/monthly/<YYYY-MM>.md`

When continuity audits are enabled, weekly compounding reports include a `Continuity Audits` section linking available weekly/monthly audit artifacts.
