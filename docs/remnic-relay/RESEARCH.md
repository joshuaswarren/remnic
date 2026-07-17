# Remnic Relay research

## Product thesis

Remnic Relay is a shared, inspectable, correctable mission-memory layer for a
team of Codex agents. Its deliberately narrow promise is:

> Correct once. Every Codex agent learns.

The Build Week demo must make a real state change visible: two agents hold
conflicting project beliefs, a source-grounded correction is approved, the
stale decision is superseded, and a cold agent retrieves the replacement and
produces a passing outcome. A receipt must connect every claim to captured
fixture evidence.

## Existing Remnic foundations

Relay reuses, but does not claim as new, the following Remnic capabilities:

- shared context and shared outputs;
- recall audit and Recall X-ray evidence;
- coding-decision memories with explicit supersession;
- correction proposal and approval contracts;
- graph, trace, and admin-console surfaces;
- native Codex hooks and memory materialization.

The Relay-specific work is a bounded mission read model, a dedicated Mission
Control UI, an isolated one-shot Codex runner, deterministic replay, and the
evidence and packaging needed for judges to reproduce the story.

## Architecture findings

- The Relay contract belongs in `@remnic/core`. It is host-agnostic and must not
  import Codex, OpenClaw, or Hermes code.
- The HTTP surface should reuse `EngramAccessService`, operation validation,
  access tokens, namespace capabilities, and the existing surface catalog.
- Mission events are append-only evidence. A deterministic reducer produces a
  complete snapshot so the browser does not need to reconstruct product state.
- An isolated mission log avoids scanning general memory or recall timelines,
  makes bounds enforceable, and keeps the demo independent of production data.
- A mission event can reference existing memory, recall-audit, test, source,
  commit, correction, and agent-output evidence without pretending that a
  historical query was captured at action time.
- Persisted events need stable ordering, strict identifiers, idempotent append,
  bounded reads, distinct empty/error states, cross-process serialization, and
  symlink-safe file access.

## Current technical references

- Zod 3.24 supports strict objects, discriminated unions, inferred TypeScript
  types, datetime validation, and regex-constrained identifiers. Relay uses
  these for one versioned event envelope with a closed payload union.
- Node.js 22 supports file-handle sync and no-follow open flags, which allows an
  append to be durable without following a replaced symlink.
- Remnic already provides a cross-process file-lock helper and operation-boundary
  validation. Relay should compose those instead of introducing parallel
  infrastructure.

## Competitive and demo implications

Agent-control-plane and generic memory products are crowded. Relay should not
lead with “agents have memory.” The differentiator is a visual, falsifiable
correction loop across independent Codex sessions with human approval and an
auditable cold-start handoff.

The winning bar for every addition is whether it improves at least one of:

1. the visible correction and propagation story;
2. judge confidence in provenance and isolation;
3. clean-room repeatability before the three-minute deadline;
4. product coherence as a developer tool for real Codex teams.

Performance work, generic orchestration, autonomous corrections, and production
data integration do not pass that bar for this submission.
