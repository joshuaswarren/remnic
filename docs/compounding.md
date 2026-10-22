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

Weekly synthesis reads three evidence sources for the ISO week (`YYYY-Www`):

- Shared feedback from `feedback/inbox.jsonl`. When `sharedContextDir` is set, that file lives under the shared-context directory. When it is unset, the inbox is `memoryDir/shared-context/feedback/inbox.jsonl` so a standalone store replicates it with the memory directory. If that file is missing or empty, synthesis copies a non-empty legacy `workspaceDir/shared-context/feedback/inbox.jsonl` once and then reads only the memory-dir copy. Other shared-context files stay at the workspace default.
- Correction memories (`category: correction`) whose `created` timestamp falls in the week, from `corrections/` and that week's `facts/<YYYY-MM-DD>/` at the memory root and under every namespace directory. These become mistake patterns and rubric observations on the weekly report. Only an explicit `active` status, or a missing status, is included. A correction that later becomes forgotten or any other non-active status, or whose source file is gone, retires its mistake on the next weekly synthesis. A source file that still exists but cannot be read stays active. The weekly report lists every namespace. Store recall and promotion keep the flat memory root and the routed default namespace, and do not inject another namespace's correction text or action-failure reason. Generic recall also skips derived `compounding/` markdown, including a namespaced copy, so a root report cannot quote another namespace through search. The scan accepts at most 500 corrections after those checks and opens at most 2000 files. Timestamped names from other weeks are skipped before stat. It reads the flat root and the routed default namespace before other namespaces, so a foreign store cannot fill the cap and hide an older correction from the caller's store. When the same correction text appears in more than one store, agent, workflow, tags, and confidence on the merged mistake come only from the visible copies. The mistake registry keeps 500 patterns, with store-visible action failures ahead of correction text and every visible pattern ahead of another namespace. Files larger than 256KB are skipped.
- Action outcomes from `state/memory-actions.jsonl` at the memory root and from `namespaces/<namespace>/state/memory-actions.jsonl` for every namespace store. The weekly report counts every namespace. Persisted rubrics and promotion candidates count only the flat root and the routed default namespace.

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
