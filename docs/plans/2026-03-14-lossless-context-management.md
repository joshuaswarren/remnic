# Lossless Context Management (LCM) for Engram

**Date:** 2026-03-14
**Status:** Design
**Scope:** New subsystem — complements existing memory pipeline

---

## 1. Problem Statement

When OpenClaw's native compaction fires, conversation history is irreversibly compressed. Important details — decisions, code snippets, error messages, reasoning chains — can be lost. The agent has no way to recover them.

Engram sits in the **memory plugin slot**, not the context engine slot. It cannot replace compaction, but it can observe the full conversation stream, build a lossless indexed archive, and inject compressed summaries and on-demand expansion tools so the agent retains access to everything that happened — even after compaction discards the raw turns.

---

## 2. Design Principles

1. **Complement, don't replace.** Native compaction still fires. Engram makes it less destructive.
2. **Proactive summarization.** Build the summary DAG continuously during the session, not reactively after compaction.
3. **Lossless by default.** Every message is stored; nothing is discarded. Summaries are views, not replacements.
4. **Expansion on demand.** Agent can drill back into compressed regions via MCP tools.
5. **Hybrid storage.** SQLite for structural queries (DAG, FTS). Existing JSONL transcripts and markdown memories unchanged.

---

## 3. Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │         OpenClaw Gateway             │
                    │                                       │
                    │   agent_end hook ──► Engram           │
                    │   before_compaction ──► Engram        │
                    │   before_agent_start ──► Engram       │
                    │   MCP tools ──► Engram                │
                    └─────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
              │  Existing  │  │   NEW:     │  │   NEW:     │
              │  Memory    │  │  Context   │  │  Expansion │
              │  Pipeline  │  │  Archive   │  │  Tools     │
              │            │  │  (SQLite)  │  │  (MCP)     │
              └────────────┘  └────────────┘  └────────────┘
```

### Hook Integration Points

| Hook | Current Use | LCM Addition |
|------|-------------|--------------|
| `agent_end` | Buffer messages, extract memories | Index messages into archive, trigger incremental summarization |
| `before_compaction` | Checkpoint active context | Snapshot DAG state, mark compaction boundary |
| `after_compaction` | Recovery | Verify archive covers compacted range |
| `before_agent_start` | Recall injection | Inject compressed history section from DAG |

---

## 4. Data Model

### 4.1 Message Archive (SQLite)

Every message observed via `agent_end` is appended to the archive. This is the "immutable store" — append-only, never modified.

```sql
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  turn_index  INTEGER NOT NULL,
  role        TEXT NOT NULL,         -- 'user' | 'assistant' | 'system' | 'tool'
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at  TEXT NOT NULL,         -- ISO 8601
  metadata    TEXT                   -- JSON: tool names, model, etc.
);
CREATE INDEX idx_messages_session ON messages(session_id, turn_index);
```

### 4.2 Summary DAG (SQLite)

Hierarchical summaries form a directed acyclic graph. Leaf nodes summarize small groups of messages; higher nodes condense groups of summaries.

```sql
CREATE TABLE summary_nodes (
  id            TEXT PRIMARY KEY,    -- ULID
  session_id    TEXT NOT NULL,
  depth         INTEGER NOT NULL,    -- 0 = leaf (messages), 1+ = condensed
  parent_id     TEXT,                -- FK to parent summary node
  summary_text  TEXT NOT NULL,
  token_count   INTEGER NOT NULL,
  msg_start     INTEGER NOT NULL,    -- first message turn_index covered
  msg_end       INTEGER NOT NULL,    -- last message turn_index covered
  escalation    INTEGER DEFAULT 0,   -- 0=normal, 1=aggressive, 2=deterministic
  created_at    TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES summary_nodes(id)
);
CREATE INDEX idx_summary_session ON summary_nodes(session_id, depth);
CREATE INDEX idx_summary_range ON summary_nodes(session_id, msg_start, msg_end);
```

### 4.3 FTS Index

Full-text search over both raw messages and summary text, enabling `engram.context_search`.

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=id);
CREATE VIRTUAL TABLE summaries_fts USING fts5(summary_text, content=summary_nodes, content_rowid=rowid);
```

### 4.4 Compaction Boundaries

Track when native compaction fired so the agent knows which ranges have been compressed.

```sql
CREATE TABLE compaction_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  fired_at      TEXT NOT NULL,
  msg_before    INTEGER NOT NULL,    -- last turn_index before compaction
  tokens_before INTEGER NOT NULL,
  tokens_after  INTEGER NOT NULL
);
```

---

## 5. Proactive Summarization Engine

### 5.1 Trigger: Incremental Summarization

After each `agent_end` observation, check if enough new messages have accumulated since the last leaf summary:

```
if (unsummarized_turn_count >= leafBatchSize) {
    create leaf summary node covering those turns
}
```

Default `leafBatchSize`: **8 turns** (configurable via `lcmLeafBatchSize`).

### 5.2 Trigger: Depth Rollup

After creating a leaf node, check if enough sibling nodes at that depth exist to condense upward:

```
if (sibling_count_at_depth >= rollupFanIn) {
    create depth+1 summary node covering those siblings
}
```

Default `rollupFanIn`: **4** (configurable via `lcmRollupFanIn`). This means:
- Depth 0 (leaf): covers ~8 turns each
- Depth 1: covers ~32 turns (4 leaves)
- Depth 2: covers ~128 turns (4 depth-1 nodes)
- Depth 3: covers ~512 turns (4 depth-2 nodes)

### 5.3 Three-Level Escalation

Summarization uses three escalation levels to guarantee convergence:

| Level | Method | Token Target | When |
|-------|--------|-------------|------|
| 0 — Normal | LLM summary (local or cloud) | 25% of input tokens | Default |
| 1 — Aggressive | LLM bullet-point compression | 12% of input tokens | If normal output > target |
| 2 — Deterministic | First/last sentence extraction + truncation | 512 tokens max | If LLM unavailable or output still exceeds budget |

Level 2 is the safety net — it never calls an LLM, so compaction always completes even with no API access.

### 5.4 Summary Prompt

```
Compress the following conversation segment into a dense summary.
Preserve: decisions made, code artifacts mentioned, errors encountered,
open questions, and any commitments or next-steps.
Omit: pleasantries, restatements, and anything the agent would not
need to recall later.
Output a single paragraph, maximum {targetTokens} tokens.
```

For aggressive (level 1):
```
Compress into bullet points. One bullet per distinct fact or decision.
Maximum {targetTokens} tokens total. No prose.
```

---

## 6. DAG-Aware Recall Section

### 6.1 New Recall Pipeline Section

Add a new section to `assembleRecallSections` in the orchestrator:

```typescript
{
  key: "lcm-compressed-history",
  label: "Session History (Compressed)",
  priority: 15,          // after profile, before episodic
  budgetShare: 0.15,     // 15% of recall budget
  async build(ctx) {
    return lcmRecall.assembleCompressedHistory(ctx.sessionId, ctx.budgetTokens);
  }
}
```

### 6.2 Assembly Strategy

1. Find the deepest summary nodes for the current session (most compressed)
2. Walk the DAG from deepest to shallowest, allocating budget
3. For the most recent portion of conversation (the "fresh tail"), use shallower / leaf summaries to preserve detail
4. Format as a chronological compressed narrative

**Fresh tail protection:** The last `lcmFreshTailTurns` turns (default: 16) always use leaf-level summaries, never deeply compressed ones. This ensures recent context stays detailed.

### 6.3 Output Format

```markdown
## Session History (Compressed)

**Early session** (turns 1-128, depth-2 summary):
[Dense paragraph covering early conversation...]

**Mid session** (turns 129-256, depth-1 summary):
[Paragraph with more detail...]

**Recent** (turns 257-280, leaf summaries):
[Most detailed summaries of recent work...]
```

---

## 7. Pre-Compaction Checkpoint

### 7.1 `before_compaction` Hook

When native compaction is about to fire:

1. **Flush pending summaries** — run any outstanding leaf/rollup summarizations
2. **Record compaction boundary** — insert into `compaction_events`
3. **Tag DAG nodes** — mark which summary nodes cover the about-to-be-compacted range

### 7.2 `after_compaction` Hook

After compaction completes:

1. **Verify coverage** — confirm the archive has messages for the entire compacted range
2. **Log gap warning** — if any turns are missing from the archive, log a warning (non-blocking)

---

## 8. Expansion MCP Tools

Three new tools let the agent drill back into compressed history on demand.

### 8.1 `engram.context_search`

Search the full message archive by keyword or semantic query.

```typescript
{
  name: "engram.context_search",
  description: "Search all conversation history (including compacted regions) by keyword",
  parameters: {
    query: { type: "string", description: "Search query" },
    limit: { type: "number", description: "Max results", default: 10 },
    session_id: { type: "string", description: "Limit to specific session", optional: true }
  },
  returns: [
    { turn_index: number, role: string, snippet: string, session_id: string }
  ]
}
```

Implementation: FTS5 query against `messages_fts`, return snippets with surrounding context.

### 8.2 `engram.context_describe`

Get a summary of a turn range without expanding the full content.

```typescript
{
  name: "engram.context_describe",
  description: "Get a compressed summary of a conversation range",
  parameters: {
    session_id: { type: "string" },
    from_turn: { type: "number" },
    to_turn: { type: "number" }
  },
  returns: { summary: string, turn_count: number, depth: number }
}
```

Implementation: Find the best-fit summary node(s) covering the requested range. If no exact match, combine adjacent nodes or generate on the fly.

### 8.3 `engram.context_expand`

Retrieve raw messages for a specific turn range — the full lossless content.

```typescript
{
  name: "engram.context_expand",
  description: "Retrieve full conversation messages for a turn range (lossless)",
  parameters: {
    session_id: { type: "string" },
    from_turn: { type: "number" },
    to_turn: { type: "number" },
    max_tokens: { type: "number", description: "Truncate if range exceeds this", default: 8000 }
  },
  returns: [
    { turn_index: number, role: string, content: string }
  ]
}
```

Implementation: Direct query against `messages` table. Truncate from the middle if the range exceeds `max_tokens`, keeping first and last turns intact.

---

## 9. Configuration Surface

All LCM settings are optional and have sensible defaults. The feature is off by default.

```typescript
// Added to PluginConfig
lcmEnabled: boolean;               // default: false
lcmLeafBatchSize: number;          // default: 8
lcmRollupFanIn: number;            // default: 4
lcmFreshTailTurns: number;         // default: 16
lcmMaxDepth: number;               // default: 5
lcmRecallBudgetShare: number;      // default: 0.15
lcmSummaryModel: string | null;    // default: null (use extraction model)
lcmDeterministicMaxTokens: number; // default: 512
lcmArchiveRetentionDays: number;   // default: 90
```

### Preset Integration

```jsonc
// memoryOsPreset: "lcm-enabled"
{
  "lcmEnabled": true,
  "lcmLeafBatchSize": 8,
  "lcmRollupFanIn": 4,
  "lcmFreshTailTurns": 16
}
```

---

## 10. Storage Layout

```
~/.openclaw/workspace/memory/local/
├── state/
│   ├── lcm.sqlite          # NEW: message archive + summary DAG
│   ├── embeddings.json      # existing
│   └── buffer.json          # existing
├── facts/                   # existing (unchanged)
├── entities/                # existing (unchanged)
├── profile.md               # existing (unchanged)
└── transcripts/             # existing JSONL (unchanged, still written)
```

The SQLite database is the single new file. Existing JSONL transcripts continue to be written for backward compatibility and for the existing extraction pipeline. The SQLite archive is a parallel index, not a replacement.

---

## 11. Implementation Phases

### Phase 1: Archive + FTS (Foundation)

**Files:** `src/lcm/archive.ts`, `src/lcm/schema.ts`

- SQLite schema creation (messages, messages_fts, compaction_events)
- Message indexing in `agent_end` hook
- `engram.context_search` tool (FTS-based)
- `engram.context_expand` tool (raw retrieval)
- Configuration parsing (`lcmEnabled`, archive settings)
- Tests: archive writes, FTS search, expand retrieval

**Deliverable:** Full message archive with search. No summarization yet.

### Phase 2: Summary DAG

**Files:** `src/lcm/summarizer.ts`, `src/lcm/dag.ts`

- Summary node schema (summary_nodes, summaries_fts)
- Leaf summarization triggered from `agent_end`
- Depth rollup logic
- Three-level escalation (normal → aggressive → deterministic)
- `engram.context_describe` tool
- Tests: leaf creation, rollup at each depth, escalation fallback

**Deliverable:** Working DAG that builds incrementally during sessions.

### Phase 3: Recall Integration

**Files:** `src/lcm/recall.ts`, modifications to `src/orchestrator.ts`

- New `lcm-compressed-history` recall section
- Fresh tail protection logic
- Budget-aware DAG traversal for recall assembly
- Integration with `assembleRecallSections`
- Tests: recall output format, budget enforcement, fresh tail

**Deliverable:** Compressed session history injected into every agent start.

### Phase 4: Compaction Hooks

**Files:** `src/lcm/compaction.ts`

- `before_compaction`: flush + boundary record
- `after_compaction`: coverage verification
- Compaction event logging
- Tests: boundary recording, gap detection

**Deliverable:** Full integration with native compaction lifecycle.

### Phase 5: Maintenance + Ops

**Files:** `src/lcm/maintenance.ts`, CLI commands

- Archive retention (prune messages older than `lcmArchiveRetentionDays`)
- SQLite WAL management and vacuum
- CLI commands: `engram lcm stats`, `engram lcm search`, `engram lcm prune`
- Dashboard integration (ops-dashboard RPC methods)

**Deliverable:** Production-ready with operational tooling.

---

## 12. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SQLite write contention under concurrent agents | Lost messages | WAL mode + busy timeout; each agent gets its own session_id partition |
| Summary LLM costs during active sessions | Unexpected spend | Deterministic fallback (level 2) is free; use local LLM when configured |
| Archive disk growth | Storage bloat | Retention policy with automatic pruning; SQLite VACUUM on schedule |
| DAG depth explosion in very long sessions | Slow recall assembly | `lcmMaxDepth` cap; flatten beyond max depth |
| FTS quality for code-heavy content | Poor search results | Index both raw content and summary text; future: AST-aware indexing |

---

## 13. Non-Goals (Explicit)

- **Replacing native compaction** — Engram cannot control when compaction fires. We work around it.
- **Cross-session DAG merging** — Each session builds its own DAG. Cross-session recall uses the existing memory pipeline.
- **Real-time streaming** — Messages are indexed at `agent_end` granularity, not token-by-token.
- **Sub-agent delegation grants** — Out of scope for initial implementation. Future work.

---

## 14. Success Metrics

1. **Zero information loss** — every message in every session is recoverable via `engram.context_expand`
2. **Recall quality** — compressed history section provides useful context that the agent references in its responses
3. **Compaction resilience** — after native compaction fires, the agent can still answer questions about pre-compaction conversation via expansion tools
4. **Performance** — summarization overhead < 2s per leaf batch; recall assembly < 500ms
5. **Storage efficiency** — SQLite archive < 2x the size of equivalent JSONL transcripts
