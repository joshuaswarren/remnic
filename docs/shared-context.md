# Shared context

Shared context is a file-based coordination layer that multiple agents read and write, enabling cross-agent collaboration without direct agent-to-agent messaging. Enable it when you run several agents that should pool priorities, work products, and feedback in one place. Opt-in via `sharedContextEnabled` (default `false`).

> Provenance: shared context landed in v4.0.

## Enable it

```json
{
  "sharedContextEnabled": true,
  "sharedContextDir": "~/.openclaw/workspace/shared-context"
}
```

`sharedContextDir` is optional and defaults to `~/.openclaw/workspace/shared-context/`.

## Directory structure

- `priorities.md`: curated living priority stack (agents read before acting)
- `priorities.inbox.md`: append-only inbox for new priority notes
- `agent-outputs/<agent>/<YYYY-MM-DD>/*.md`: work products written by agents
- `feedback/inbox.jsonl`: append-only approvals/rejections with optional learning/outcome
- `roundtable/<YYYY-MM-DD>.md`: daily synthesis written by the curator tool
- `cross-signals/<YYYY-MM-DD>.md`: human-readable recurring themes, risks, and promotion candidates with provenance
- `cross-signals/<YYYY-MM-DD>.json`: deterministic overlap report (topics/entities) across daily outputs + feedback totals

## Authority envelope

Every agent output carries a governance envelope in its frontmatter (issue #1957):

```yaml
sharedBy: "agent-id"    # origin: the acting agent that wrote the item
authority: "informational"  # informational | advisory | binding
expiresAt: "2099-01-01T00:00:00.000Z"  # optional
supersedes: "item-id"   # optional
```

Rules:

- Default authority is `informational`. A missing, unrecognized, or malformed value never resolves above `informational` (least privilege).
- `binding` requires two things: the writer explicitly requests it, and the operator sets `sharedContextAllowBindingAuthority: true` (default `false`). A binding write without the flag is rejected; a stored `binding` item read without the flag downgrades to `advisory`.
- Legacy items without an envelope keep working unchanged: they read as `informational` with origin falling back to the frontmatter `agent` field.
- Cross-signals reports (JSON and markdown) and the daily roundtable annotate every source with its resolved authority and origin, so consumers can weigh items accordingly.
- Origin is server-derived, never caller-chosen. When a write crosses an access surface that resolved an authenticated principal (or the OpenClaw host runs with a configured runtime principal), that identity is stamped as `sharedBy`, and an `agentId` parameter naming a different agent is rejected. Only surfaces with no resolvable identity (an in-process caller, an unauthenticated local CLI) fall back to the supplied `agentId`.

### What the tool surfaces can set today

In this slice, `authority`, `expiresAt`, and `supersedes` are settable only by
in-process callers of `SharedContextManager.writeAgentOutput` (for example the
curator and other core code paths). Both documented tool surfaces — the MCP
`engram.shared_context_write_output` operation and the OpenClaw
`shared_context_write_output` tool — accept only `agentId`, `title`, and
`content`, reject extra properties, and therefore always write
`authority: informational` with no expiry and no supersession. Exposing the
envelope fields on those surfaces (with the authority allow-list and the
`sharedContextAllowBindingAuthority` gate enforced at the boundary) is
deliberate follow-up work, not a capability you can reach from a tool call
today. The read side is already live everywhere: stored `advisory`/`binding`
items written in-process resolve and annotate exactly as described above.

## Tools

- `shared_context_write_output`
- `shared_priorities_append`
- `shared_feedback_record`
- `shared_context_cross_signals_run`
- `shared_context_curate_daily`

`shared_context_cross_signals_run` writes:
- cross-signal markdown (`cross-signals/<YYYY-MM-DD>.md`)
- cross-signal JSON (`cross-signals/<YYYY-MM-DD>.json`)

`shared_context_curate_daily` now writes:
- roundtable markdown (`roundtable/<YYYY-MM-DD>.md`)
- cross-signal markdown (`cross-signals/<YYYY-MM-DD>.md`)
- cross-signal JSON (`cross-signals/<YYYY-MM-DD>.json`)

Cross-signal report includes:
- per-source topic token extraction (from title/body)
- overlap entries where the same token appears across 2+ agents
- daily feedback decision totals (`approved`, `approved_with_feedback`, `rejected`)
- optional semantic overlap enhancement metadata (`semantic.enabled/applied/timedOut`)

Roundtable output includes a `Cross-Signals` section summarizing:
- number of sources analyzed
- number of feedback entries analyzed
- decision totals
- semantic enhancer status (disabled/applied/no-additional-overlap/timeout fail-open)
- paths to the generated cross-signal markdown + JSON
- top overlap bullets when available

Semantic enhancer settings (all optional):
- `sharedCrossSignalSemanticEnabled` (default `false`)
- `sharedCrossSignalSemanticTimeoutMs` (default `4000`)
- `sharedCrossSignalSemanticMaxCandidates` (default `120`)

Compatibility aliases remain supported:
- `crossSignalsSemanticEnabled`
- `crossSignalsSemanticTimeoutMs`

Injection:
- When enabled, Remnic injects `priorities.md`, the latest `roundtable/*.md`, and the latest `cross-signals/*.md` into the system prompt (timeboxed and capped by `sharedContextMaxInjectChars`, default 4,000).
- Shared context is assembled at **position 1** in the recall pipeline — before profile and memories. It consumes recall budget first.

### Budget interaction

With the default `recallBudgetChars` of 8,000 and `sharedContextMaxInjectChars` of 4,000, shared context plus profile can consume most of the budget, leaving little room for actual memories. If you enable shared context, raise `recallBudgetChars` to at least 32,000 (or 64,000+ for large-context models). See [Recall budget tuning](config-reference.md#recall-budget-tuning).

## Scheduling

Run `shared_context_curate_daily` as an isolated cron agent turn (recommended) near the end of your day.
