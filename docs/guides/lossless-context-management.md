# Lossless context management (LCM)

When AI agents hit their context window limit, the runtime compresses older messages to make room. This is called **compaction**, and it permanently discards the original content. LCM prevents information loss by proactively archiving every message and building a hierarchical summary structure that can be injected back into recall.

## How it works

LCM operates as a complement to native compaction — it does not replace it. Instead, it observes, archives, summarizes, and provides expansion tools.

```
Agent turn ends
       │
       ▼
 ┌─────────────┐     ┌──────────────────┐
 │ Archive msg  │────▶│ SQLite FTS index  │
 │ (lossless)   │     └──────────────────┘
 └──────┬──────┘
        │
        ▼
 ┌─────────────┐     ┌──────────────────┐
 │ Summarize   │────▶│ Summary DAG      │
 │ (incremental)│     │ (depth 0,1,2…)   │
 └─────────────┘     └──────────────────┘
        │
        ▼ (at recall time)
 ┌─────────────┐
 │ Assemble    │──▶ Compressed session history injected into recall
 │ recall      │
 └─────────────┘
```

### Summary DAG

Summaries are organized in a hierarchical directed acyclic graph:

| Depth | Covers | Description |
|-------|--------|-------------|
| 0 (leaf) | ~8 turns | Most detailed summaries |
| 1 | ~32 turns | Rollup of 4 leaf nodes |
| 2 | ~128 turns | Rollup of 4 depth-1 nodes |
| 3+ | ~512+ turns | Further compression |

The **fresh tail** (most recent N turns, default 16) always uses leaf-level summaries for maximum detail. Older portions use the deepest available nodes for maximum compression.

### Three-level summarization

When creating summaries, LCM uses a three-level escalation strategy:

1. **Normal** — LLM produces a dense paragraph summary
2. **Aggressive** — If the normal summary exceeds the token budget, LLM produces bullet points
3. **Deterministic** — If the LLM still exceeds budget, a no-LLM fallback extracts first/last sentences and truncates the middle (guaranteed convergence)

This ensures summarization never fails, even if the LLM is unavailable or produces overly verbose output.

## Enabling LCM

Add to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "lcmEnabled": true
        }
      }
    }
  }
}
```

Restart the gateway after changing config.

## Configuration

All LCM settings have sensible defaults. Override only what you need:

| Setting | Default | Description |
|---------|---------|-------------|
| `lcmEnabled` | `false` | Enable LCM (the `research-max` preset turns this on) |
| `lcmLeafBatchSize` | `8` | Number of turns per leaf summary node |
| `lcmRollupFanIn` | `4` | Number of child nodes merged into one parent |
| `lcmFreshTailTurns` | `16` | Recent turns that always use leaf-level (most detailed) summaries |
| `lcmMaxDepth` | `5` | Maximum DAG depth (depth 5 covers ~8192 turns) |
| `lcmRecallBudgetShare` | `0.15` | Fraction of the total recall budget allocated to LCM compressed history |
| `lcmDeterministicMaxTokens` | `512` | Token limit for the deterministic (no-LLM) fallback summarizer |
| `lcmArchiveRetentionDays` | `90` | Days to retain raw archived messages before pruning |

## MCP tools

LCM registers three tools that agents can use to explore conversation history. Each is registered remnic-first with a legacy `engram_context_*` alias retained during the compatibility window:

### `remnic_context_search`

Full-text search across all archived conversation messages.

```
Query: "database migration decision"
Limit: 5
SessionId: (optional) filter to a specific session
```

Returns matching messages with turn index, role, snippet, and session ID.

### `remnic_context_describe`

Get a compressed summary of a turn range. Uses the best available summary node from the DAG.

```
SessionId: "default"
FromTurn: 0
ToTurn: 50
```

Returns the summary text, turn count, and depth of the covering node.

### `remnic_context_expand`

Retrieve raw lossless messages for a turn range. This is the "zoom in" tool — when a summary isn't detailed enough, the agent can expand to the original messages.

```
SessionId: "default"
FromTurn: 10
ToTurn: 15
MaxTokens: 2000
```

Returns the original messages with role and content, truncated to fit the token budget (preserving first and last messages).

## How it complements native compaction

LCM sits in the **memory plugin slot**, not the context engine slot. It cannot prevent or replace compaction — the runtime controls that. Instead:

1. **Before compaction**: LCM flushes pending summaries and records the compaction boundary
2. **During compaction**: The runtime compresses context as usual (LCM has no role here)
3. **After compaction**: LCM verifies archive coverage
4. **At recall time**: LCM injects a `## Session History (Compressed)` section into the recall payload, giving the agent access to information that was compacted away

This means even after multiple compaction cycles, the agent retains a compressed view of the entire session history, with the ability to expand any section on demand.

## Storage

LCM uses a single SQLite database at `<memoryDir>/state/lcm.sqlite` with WAL mode for concurrent reads. The database contains:

- **messages** — Raw archived messages with full-text search index
- **summary_nodes** — Hierarchical summary DAG
- **compaction_events** — Record of compaction boundaries

Old data beyond `lcmArchiveRetentionDays` is automatically pruned.

## Architecture

For the full technical design, see the [LCM Design Document](../../docs/plans/2026-03-14-lossless-context-management.md).

Source files:
- `src/lcm/schema.ts` — SQLite schema and database initialization
- `src/lcm/archive.ts` — Message archive with FTS5 search
- `src/lcm/dag.ts` — Summary DAG operations
- `src/lcm/summarizer.ts` — Three-level summarization engine
- `src/lcm/recall.ts` — DAG-aware recall assembly
- `src/lcm/engine.ts` — Facade tying all components together
- `src/lcm/tools.ts` — MCP tool registration
