# Engram PR6: Objective-State Writers

**Status:** planned for implementation in this slice  
**Roadmap track:** Objective-state memory as a first-class store  
**Primary source:** AMA-Bench / AMA-Agent — https://arxiv.org/abs/2602.22769

## Goal

Ship the first runtime writer layer for objective-state memory. This slice turns `agent_end` tool activity into normalized objective-state snapshots for file, process, and generic tool outcomes, using the store contract introduced in PR5.

## Why This Slice Exists

PR5 created the snapshot schema and store, but the store is not useful until Engram can populate it from real agent trajectories. AMA-Bench / AMA-Agent argues that memory systems fail when they cannot recover what tools ran, what changed, and what state resulted. PR6 is the smallest writer slice that starts closing that gap without changing retrieval behavior yet.

## Scope

This slice includes:

- agent-end-derived snapshot normalization for `tool` role messages
- assistant tool-call context matching through `tool_call_id`
- file/process/tool classification from tool names and arguments
- hashed payload recording so raw tool output is not stored in objective-state snapshots
- flag-gated persistence using the existing objective-state config
- tests for normalization, flag gating, and on-disk persistence

This slice does **not** include:

- objective-state retrieval formatting or ranking changes
- causal trajectory linking across multiple actions
- trust-zone promotion rules
- freeform world-state inference beyond the stable tool/file/process surfaces

## Flags

- `objectiveStateMemoryEnabled`
- `objectiveStateSnapshotWritesEnabled`

Both must be enabled before Engram writes objective-state snapshots from runtime agent events.

## Runtime Contract

- hook surface: `agent_end`
- source event: assistant tool calls plus matching `tool` role results
- normalized output kinds:
  - `process`
  - `file`
  - `tool`
- persistence target: `{memoryDir}/state/objective-state/snapshots/YYYY-MM-DD/*.json`

## Verification

- unit tests for process/file/tool normalization
- unit tests for flag-gated writes
- status inspection confirms written snapshots are visible through `objective-state-status`

## Follow-on PRs

- PR7: objective-state retrieval formatter and ranking hooks
- PR8: causal trajectory schema and storage
