# Contradiction Review

Nightly scan that detects semantically contradictory memory pairs and queues them for user resolution.

## Overview

Write-time temporal supersession (issue #448) only catches contradictions when both facts share a `structuredAttributes` supersession key on the same `entityRef`. Facts that contradict semantically without colliding on a normalized key remain co-active.

The contradiction scan closes this gap by:

1. **Pairing** active memories with similar content (shared entity refs or overlapping topic tokens)
2. **Judging** each pair with an LLM-as-judge classifier
3. **Queuing** contradicting pairs for user review
4. **Resolving** through existing temporal-supersession machinery

## Configuration

```json
{
  "contradictionScan": {
    "enabled": false,
    "similarityFloor": 0.82,
    "topicOverlapFloor": 0.4,
    "maxPairsPerRun": 500,
    "cooldownDays": 14,
    "autoMergeDuplicates": false
  }
}
```

| Property | Default | Description |
|----------|---------|-------------|
| `enabled` | `false` | Master switch for the nightly cron. Operators must explicitly set `true` to enable (least-privileged default per rule 48). |
| `similarityFloor` | `0.82` | Embedding cosine similarity threshold for candidate pair generation |
| `topicOverlapFloor` | `0.4` | Minimum Jaccard overlap of topic tokens for unstructured pairs |
| `maxPairsPerRun` | `500` | Cap on pairs evaluated per cron run |
| `cooldownDays` | `14` | Days before re-evaluating a pair judged independent/both-valid. `0` disables cooldown. |
| `autoMergeDuplicates` | `false` | Auto-flag pairs judged "duplicates" for dedup (still needs user approval) |

## Surfaces

### CLI (hosted)

Contradiction review ships on the OpenClaw-hosted CLI. (Do not confuse it with
the standalone `remnic review` command, which drives the separate memory
*suggestion* queue with `list|approve|dismiss|flag`.)

```bash
# List unresolved contradictions
openclaw engram review list
openclaw engram review list --filter contradicts --namespace work

# Show a specific pair
openclaw engram review show <pairId>

# Resolve a pair
openclaw engram review resolve <pairId> --verb keep-a
openclaw engram review resolve <pairId> --verb both-valid

# Run an on-demand scan
openclaw engram review scan
```

Valid verbs:
- `keep-a` — Supersede memory B, keep A
- `keep-b` — Supersede memory A, keep B
- `merge` — Create merged memory, supersede both
- `both-valid` — Mark as reviewed; apply cooldown
- `needs-more-context` — Defer; short cooldown

### HTTP

```
GET  /engram/v1/review/contradictions?filter=contradicts&limit=20
GET  /engram/v1/review/contradictions/:pairId
POST /engram/v1/review/resolve  { pairId, verb }
POST /engram/v1/contradiction-scan  { namespace? }
```

### MCP tools

- `remnic.review_list` / `engram.review_list` — List review items
- `remnic.review_resolve` / `engram.review_resolve` — Resolve a pair
- `remnic.contradiction_scan_run` / `engram.contradiction_scan_run` — Run an on-demand scan

## Cron

The nightly cron (`engram-contradiction-scan`) runs at 3:37 AM by default. It's registered alongside the other governance crons in `maintenance/memory-governance-cron.ts`.

## Architecture

```
packages/remnic-core/src/contradiction/
  contradiction-scan.ts    — Pair generator + scan driver
  contradiction-judge.ts   — LLM-as-judge classifier
  contradiction-review.ts  — Review queue storage
  resolution.ts            — Resolution verb executor
```

All resolution verbs delegate to `temporal-supersession.ts` — the contradiction module does not reimplement supersession logic.
