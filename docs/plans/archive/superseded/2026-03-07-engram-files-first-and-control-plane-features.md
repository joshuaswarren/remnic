# Engram Direction And Feature Request Drafts

## Storage Direction

### Decision

Engram should stay files-first.

Do not migrate the primary source of truth from markdown files to SQLite. Instead, add an optional derived read model for the features that benefit from indexed queries, timelines, dashboards, and operator tooling.

### Why

Engram already treats plain files as a product feature, not an implementation detail:

- memory is inspectable on disk
- backups and exports are simple
- users can grep, diff, sync, and edit memory without a database client
- existing subsystems already assume file-native storage: namespaces, shared context, boxes, artifacts, compounding, transcript retention, import/export, and QMD indexing

Moving the source of truth to SQLite would force a deep rewrite of storage, recall, lifecycle, recovery, and tooling, while also weakening one of Engram's main differentiators: transparent local memory as plain markdown.

The missing capabilities do not require a full cutover. Most of them need one of these instead:

- a structured append-only lifecycle ledger
- a rebuildable projection/index optimized for APIs and UI
- stronger maintenance and operator surfaces

### Recommended Architecture

Keep this split:

- Source of truth: markdown files and existing state files under `memoryDir`
- Lifecycle ledger: append-only event stream written by Engram for create/update/supersede/archive/reject actions
- Optional read model: SQLite or another local index built from files plus the lifecycle ledger for fast joins, filtering, timelines, and dashboards

That gives Engram the operational affordances of a local registry without giving up the file-native architecture.

### Revisit Triggers

Revisit the decision only if one or more of these become real bottlenecks:

- file counts or directory scans materially slow normal recall/write paths
- Engram needs multi-process write concurrency with stronger transactional guarantees
- operator-facing APIs and UI become first-class workloads and cannot be served efficiently from a derived read model
- recovery, replication, or synchronization requirements become database-shaped rather than file-shaped

### Guidance For The Feature Requests Below

All seven proposals below assume:

- markdown remains the primary store
- any database added is a derived cache, projection, or control-plane index
- every derived store must be rebuildable from the file corpus plus append-only ledgers

## Suggested Delivery Order

1. Lifecycle ledger and derived projection store
2. Structured explicit capture modes
3. Native knowledge sync
4. Entity retrieval intelligence
5. Quality review and audit pipeline
6. Universal agent access layer
7. Admin console
8. Setup, health, and benchmarking toolkit

That order hardens Engram's memory quality before adding more operator surfaces.

## Existing Plan Overlap And Adjustments

This draft should be read alongside the existing plans in `docs/plans/`.

### Existing Plans To Preserve

- `2026-02-11-v3.0-multi-agent-memory.md`
  Keep. It already covers namespace policy, cross-agent sharing, and promotion. The new access-layer work should not replace namespace semantics; it should expose them cleanly to non-OpenClaw clients.

- `2026-02-11-v4.0-cross-agent-shared-intelligence.md`
  Keep. It already covers file-based shared context. The new proposals should treat shared context as a separate coordination surface, not collapse it into the access layer or projection store.

- `2026-02-21-engram-memory-os-roadmap.md`
  Keep. It remains the umbrella roadmap for Memory OS capabilities. The new proposals add operational/control-plane work that the roadmap assumes but does not fully specify.

- `2026-02-22-v8.2-pr18-graph.md`
- `2026-02-22-v8.2-tree-graph-design.md`
  Keep. These already cover graph edges, temporal memory tree work, and graph recall. The new entity retrieval proposal must not duplicate graph-building scope; it should focus on entity-centric ranking, aliasing, answer hints, and short-window coreference.

### Scope Adjustments

- The new lifecycle ledger and projection feature is foundational and should sit underneath:
  - quality review and audit
  - universal agent access layer
  - admin console

- The new universal agent access layer supersedes the narrower idea of a simple local bridge API. It should be implemented once and consumed by OpenClaw, Codex, Claude Code, and future clients.

- The new setup/health/benchmarking toolkit should reuse existing CLI surfaces where sensible rather than inventing parallel commands.

- Native knowledge sync should remain separate from transcript indexing and separate from graph storage.

- The explicit capture feature should complement `memory_store`, not replace it.

---

## Feature 1: Lifecycle Ledger And Derived Projection Store

### Summary

Add an append-only lifecycle ledger plus a rebuildable local projection store so Engram can support timelines, APIs, dashboards, review tooling, and high-quality operator workflows without abandoning file-native storage.

### Problem

Engram is currently file-native, but it does not yet maintain a first-class lifecycle record of what happened to a memory over time. That leaves several operator features either weak or expensive to build:

- timelines for a single memory
- explainable maintenance and audit operations
- reversible status transitions
- fast filtered inspection for admin tooling
- reliable inputs for APIs and dashboards

Engram needs structured lifecycle history and a fast derived read model, but without moving the source of truth away from markdown.

### Goals

- Record every important memory transition in an append-only ledger
- Keep markdown files authoritative
- Build a local projection store optimized for joins, filtering, and timelines
- Make the projection fully rebuildable from authoritative sources
- Support rollback-safe maintenance and audit tooling
- Feed higher-level features such as APIs, console views, and benchmarking

### Non-Goals

- Replacing markdown as the source of truth
- Introducing a mandatory database dependency for all installs
- Writing business logic only into the projection while bypassing file writes

### Lifecycle Events

The ledger should capture at least:

- created
- updated
- superseded
- archived
- rejected
- restored
- merged
- imported
- promoted
- explicit-capture accepted
- explicit-capture queued

Each event should include:

- event ID
- memory ID
- event type
- timestamp
- actor or subsystem
- reason code
- rule version
- related memory IDs
- before and after state summaries where applicable
- correlation or run ID

### Derived Projection Responsibilities

The projection store should provide:

- current-state memory rows
- status indexes
- per-memory timelines
- entity mention indexes
- native knowledge chunk indexes where enabled
- maintenance and review queue views

### Storage Model

Recommended split:

- authoritative markdown memory files
- authoritative append-only lifecycle ledger
- optional local projection store, defaulting to SQLite when enabled

The projection must be:

- rebuildable
- versioned
- safe to discard and regenerate
- never the only place where truth exists

### Rebuild Semantics

Engram should support:

- full rebuild from corpus plus ledger
- partial rebuild by namespace or time range
- integrity verification between files and projection
- repair commands when projection drift is detected

### Architecture

- File writes remain the primary write path
- Lifecycle events are emitted synchronously with successful state transitions
- Projection updates can be synchronous for small installs or backgrounded with durability guarantees
- Any read-path feature that uses the projection must fail open or fall back safely when the projection is unavailable

### Rollout

Phase 1:

- lifecycle event schema
- append-only ledger writer
- rebuild CLI

Phase 2:

- current-state projection
- timeline queries
- integrity checks

Phase 3:

- richer indexes for entities, native knowledge, and review workflows

### Acceptance Criteria

- Engram can answer "what happened to this memory?" from a structured timeline
- The projection can be deleted and rebuilt without data loss
- Markdown remains the source of truth after rollout

---

## Feature 2: Universal Agent Access Layer

### Summary

Add a local, authenticated, versioned access layer for Engram with both HTTP endpoints and MCP tools so agents outside OpenClaw can use Engram directly.

### Problem

Engram is still too tightly coupled to OpenClaw-specific hooks and tool registration. That limits adoption and makes outside-agent access awkward for:

- Codex
- Claude Code
- other MCP-capable agent runtimes
- local scripts and automation

Engram should become a local memory service that OpenClaw uses, not only an OpenClaw plugin that others must adapt around.

### Goals

- Expose a stable local HTTP API for programmatic access
- Expose a first-class MCP server for agent-native access
- Make Codex and Claude Code easy first adopters
- Preserve local-first security and operator control
- Keep request/response shapes explainable and versioned
- Support both read and policy-controlled write operations

### Non-Goals

- Internet-facing public SaaS endpoints
- Multi-tenant hosted identity or auth
- Replacing OpenClaw integrations

### Consumers

The access layer should be straightforward to configure from:

- OpenClaw
- Codex desktop and CLI environments
- Claude Code / Codex-compatible MCP clients
- lightweight local scripts

### Access Modes

#### HTTP

Recommended endpoints:

- `GET /engram/v1/health`
- `POST /engram/v1/recall`
- `POST /engram/v1/recall/explain`
- `POST /engram/v1/suggestions`
- `GET /engram/v1/memories/:id`
- `GET /engram/v1/memories/:id/timeline`
- `GET /engram/v1/entities/:id`
- `GET /engram/v1/review-queue` when available

#### MCP

Recommended MCP tools:

- `engram.recall`
- `engram.recall_explain`
- `engram.memory_get`
- `engram.memory_timeline`
- `engram.memory_store`
- `engram.suggestion_submit`
- `engram.entity_get`
- `engram.review_queue_list`

The MCP server should map cleanly onto the same internal service layer as HTTP rather than duplicating logic.

### Request/Response Design

`recall` should support:

- `query`
- `sessionKey`
- `namespace`
- `topK`
- `mode`
- `includeDebug`

Responses should include:

- `results`
- `count`
- `traceId`
- `plannerMode`
- `fallbackUsed`
- `sourcesUsed`
- `budgetsApplied`
- `latencyMs`

Write operations should support:

- `schemaVersion`
- `idempotencyKey`
- `dryRun`

### Security Requirements

- Bind to loopback by default
- Require token auth by default for HTTP
- Support local secret or token configuration for MCP-backed operations where needed
- Fail closed when auth is not configured
- Enforce request size limits
- Rate-limit write endpoints
- Support idempotent retries on write operations
- Emit structured audit logs without leaking secrets

### Integration Requirements For Codex And Claude Code

- MCP server should be discoverable with minimal config
- tool names and schemas should be stable and ergonomic
- errors should be short, machine-readable, and human-useful
- explain/debug tools should return enough detail for agent self-correction
- startup health checks should clearly indicate projection/index availability

### Architecture

- Implement one internal service layer
- Expose it through both HTTP and MCP adapters
- OpenClaw-specific plugin wiring should call the same service layer, not a different code path
- Any projection-backed reads must degrade safely when projection is unavailable

### Rollout

Phase 1:

- `health`
- `recall`
- `recall/explain`
- `memory_get`

Phase 2:

- suggestion ingest
- memory timeline
- entity inspection

Phase 3:

- review queue
- richer maintenance/debug surfaces

### Acceptance Criteria

- A Codex or Claude Code client can query Engram through MCP without OpenClaw-specific glue
- Local scripts can query Engram through HTTP without shelling out to CLI
- HTTP and MCP produce equivalent results for the same request class

---

## Feature 3: Engram Admin Console

### Summary

Add an optional local admin console for browsing, reviewing, debugging, and managing Engram memory.

### Problem

Once Engram stores enough memory, file inspection alone stops being an efficient operator experience. Users need a fast way to:

- search and filter memory
- inspect one memory in context
- debug recall quality
- review duplicates and false positives
- understand entity relationships and memory health

### Goals

- Provide a local operator UI that works on top of the universal agent access layer
- Make read-only inspection easy and safe
- Surface review workflows without forcing direct file edits
- Add first-class recall debugging and quality operations
- Keep the UI private, accessible, and lightweight

### Non-Goals

- A cloud dashboard
- Replacing Git or raw file access for power users
- Background sync or hosted analytics

### Core Views

- Memory browser: search, filter, sort, paginate, preview, open raw file
- Memory detail: content, frontmatter, linked entity, related memories, lifecycle timeline
- Recall debugger: run a query, inspect planner choice, candidates, boosts, penalties, and final injection
- Review queue: pending suggestions, suspected duplicates, low-plausibility captures, archive candidates
- Entity explorer: aliases, facts, related entities, recent mentions, direct-answer candidates
- Quality dashboard: counts by status, confidence, namespace, age, category, archive pressure
- Maintenance dashboard: last successful maintenance, last reindex, last backup, last audit report

### Best-Practice UX Requirements

- Read-only by default
- Destructive actions require explicit confirmation
- Write actions create audit entries
- Large result sets are virtualized
- Every memory detail view has a direct path back to the raw markdown file
- Operator actions show before/after diffs
- Accessibility support includes keyboard navigation and semantic labels

### Write Actions

Allowed operator actions should include:

- confirm
- reject
- archive
- supersede
- merge duplicate set
- edit metadata
- add alias
- trigger reindex for one memory or one source file

### Architecture

- Static SPA or lightweight server-rendered UI
- Uses the local universal agent access layer only
- No direct filesystem writes from browser code
- Loopback bind only
- Token-protected
- Compatible with a future packaged local app if needed

### Rollout

Phase 1:

- memory browser
- memory detail
- recall debugger

Phase 2:

- review queue
- entity explorer
- maintenance dashboard

Phase 3:

- merge/diff workflows
- charts and historical trend views

### Acceptance Criteria

- Operators can inspect and debug recall without leaving the UI
- Operators can review and disposition suspect memories safely
- Every write action is auditable and reversible where practical

---

## Feature 4: Native Knowledge Sync

### Summary

Add a native knowledge sync subsystem that indexes curated workspace files into recall without converting them into extracted memories.

### Problem

A large portion of durable context already lives in curated files:

- `MEMORY.md`
- `IDENTITY.md`
- daily notes
- project briefs
- playbooks
- operating docs

Today Engram is strong at extracting memory from conversation and transcripts, but weaker at treating human-written workspace knowledge as a first-class recall source.

### Goals

- Index curated markdown and note files into recall
- Preserve provenance back to file, section, and line range
- Keep synced knowledge separate from extracted memory
- Support incremental sync by hash and mtime
- Enforce privacy and namespace boundaries
- Allow source weighting so curated docs and daily notes can be treated differently

### Non-Goals

- Auto-rewriting user docs
- Treating every synced chunk as a durable memory file
- Blindly indexing the entire workspace without allowlists

### Supported Source Types

Initial source classes:

- `MEMORY.md`
- `IDENTITY.md`
- daily notes matching configurable globs
- curated docs explicitly listed in config

Later extensions:

- team handbooks
- project decision logs
- operating runbooks

### Retrieval Model

Native synced content should behave like a separate recall source with:

- chunked content
- source kind
- source path
- section label
- source date when derivable
- namespace/privacy class
- optional linked memory IDs

Recall should be able to:

- blend synced knowledge with memory files
- bias toward direct curated facts when appropriate
- exclude private sources from shared contexts
- time-filter daily notes for temporal queries

### Configuration

Add a config block similar to:

```json
{
  "nativeKnowledge": {
    "enabled": true,
    "includeFiles": ["MEMORY.md", "IDENTITY.md"],
    "dailyNotesGlob": "memory/**/*.md",
    "excludeGlobs": [],
    "maxChunkChars": 900,
    "sharedSafeFiles": ["shared/**"],
    "embedOnSync": false
  }
}
```

### Architecture

- Build a native sync manifest under `memoryDir/state/`
- Track source path, size, mtime, content hash, last sync time
- Chunk content by headings and bullets first, paragraphs second
- Keep synced knowledge in a dedicated derived index, not mixed into durable memory files
- Expose sync results in maintenance reports and doctor output

### Privacy And Scope Rules

- Shared or cross-agent recall must not pull private user files unless explicitly allowed
- Curated shared files need explicit allowlisting
- Every synced chunk should carry a source privacy class
- Sync should skip secrets and obviously unsafe source paths

### Rollout

Phase 1:

- `MEMORY.md`
- `IDENTITY.md`
- one daily-notes glob

Phase 2:

- curated include lists
- incremental sync reports
- source privacy classes

Phase 3:

- file watchers
- richer source weighting

### Acceptance Criteria

- Engram can recall from curated markdown sources without converting them into extracted memories
- Shared recall never leaks private curated files
- Native sync is incremental, auditable, and visible in health tooling

---

## Feature 5: Structured Explicit Capture Modes

### Summary

Add policy-controlled explicit capture modes so Engram can run in `implicit`, `explicit`, or `hybrid` memory capture configurations.

### Problem

Automatic extraction is powerful, but some users and deployments want tighter consent and precision:

- only save memory when explicitly asked
- capture structured notes with less ambiguity
- prevent silent memory creation in sensitive contexts
- handle environments where operator review is required

Engram already has `memory_store`, but it does not yet provide a full explicit capture policy and protocol.

### Goals

- Add a formal capture policy mode
- Support explicit memory creation when the user asks to remember something
- Make structured capture available through both tools and inline protocol
- Apply strict validation and secret filtering before storage
- Allow hybrid mode so Engram can still do selective automatic extraction

### Non-Goals

- Removing implicit extraction for all users
- Requiring a UI to use explicit capture
- Trusting arbitrary unvalidated structured notes

### Capture Modes

- `implicit`: current Engram behavior
- `explicit`: only explicit structured capture is persisted
- `hybrid`: explicit capture always allowed, automatic extraction remains available under policy

### Preferred Mechanisms

Primary path:

- dedicated tool for structured capture

Fallback path:

- inline structured memory note block for environments where tool use is unavailable or constrained

This keeps Engram compatible with different model/runtime capabilities while making the tool path the best practice.

### Structured Note Requirements

Each explicit note should support:

- one standalone fact per note
- `category`
- `confidence`
- `namespace`
- `tags`
- `entityRef`
- optional `ttl`
- optional `sourceReason`

Validation rules:

- min and max content length
- no nested notes
- no secrets, credentials, or tokens
- safe category whitelist
- optional namespace policy check
- duplicate detection before write

### Consent And Safety

When `explicit` mode is on:

- no silent extraction from normal turns
- only direct explicit notes or explicit tool calls create memory

When `hybrid` mode is on:

- explicit notes bypass buffering and store immediately
- automatic extraction still obeys the normal filters and thresholds

### AGENTS/Instruction Support

Engram should be able to generate or update an instruction snippet that tells agents how to use explicit memory capture safely.

This must be opt-in, previewable, and reversible.

### Architecture

- Add `captureMode` config
- Route explicit notes through the same sanitization, dedupe, and lifecycle logic as normal writes
- Write lifecycle events for all explicit captures
- If a note cannot be stored immediately, queue it for review instead of dropping it silently

### Rollout

Phase 1:

- config support
- dedicated tool
- validation

Phase 2:

- inline protocol support
- optional instruction bootstrap helper

Phase 3:

- policy-aware review queue integration

### Acceptance Criteria

- In `explicit` mode, normal conversation does not create memory
- Explicit notes are validated, sanitized, deduped, and auditable
- Hybrid mode supports both immediate explicit capture and normal extraction

---

## Feature 6: Memory Quality Review And Audit Pipeline

### Summary

Add a full memory governance pipeline: review queue, nightly maintenance, quality scoring, dry-run/apply/restore/report modes, and durable audit artifacts.

### Problem

Long-term memory systems need operator-grade governance. Without it, the system accumulates:

- junk captures
- duplicates
- malformed or implausible memories
- stale low-value memories
- unreviewed explicit suggestions

Engram has consolidation and archival logic, but it does not yet expose a coherent, operator-facing quality pipeline.

### Goals

- Introduce an explicit review queue and review reasons
- Add deterministic quality sweeps before destructive actions
- Support dry-run and rollback-safe maintenance flows
- Produce machine-readable and human-readable artifacts after each run
- Keep all decisions auditable by versioned rule set

### Non-Goals

- Replacing Engram's existing extraction/consolidation path
- Requiring human review for every write
- Creating irreversible destructive actions without restore metadata

### Memory Lifecycle States

Recommended statuses:

- `active`
- `pending_review`
- `superseded`
- `archived`
- `rejected`
- `quarantined`

Each transition should record:

- timestamp
- actor or subsystem
- reason code
- rule version
- related memory IDs if applicable

### Queue Sources

The review queue should accept:

- explicit suggestions that fail direct-write policy
- semantic duplicate candidates
- low-plausibility captures
- suspect archive candidates
- malformed memory imports
- failed explicit captures when policy says "queue, do not drop"

### Maintenance Sequence

Recommended sequence:

1. snapshot
2. native knowledge sync
3. quality sweep
4. exact dedupe
5. semantic dedupe
6. TTL and archival evaluation
7. report generation
8. index maintenance

### Audit Modes

- `shadow`: simulate and report, write no destructive changes
- `apply`: execute transitions and write restore metadata
- `restore`: reverse a specific applied run where possible
- `report`: render the output of a previous run

### Artifacts

Each maintenance run should produce:

- execution summary JSON
- kept memories report
- archived/rejected/superseded report
- review queue snapshot
- rollback metadata
- metrics summary
- rule version manifest
- per-run trace or correlation ID

### Architecture

- Write all lifecycle transitions to an append-only ledger
- Build queue views from the ledger plus current file state
- Keep rule sets versioned so future audits are reproducible
- Allow per-namespace and global maintenance runs

### Rollout

Phase 1:

- new statuses
- lifecycle ledger
- queue schema

Phase 2:

- shadow/apply/report modes
- audit artifacts

Phase 3:

- restore mode
- UI/API integration

### Acceptance Criteria

- Operators can run dry-run maintenance and inspect exactly what would change
- Every destructive maintenance action leaves restore metadata
- Duplicate and junk handling becomes visible, testable, and reversible

---

## Feature 7: Entity Retrieval Intelligence

### Summary

Add a dedicated entity retrieval layer with mention indexing, alias handling, coreference support, direct-answer prioritization, and entity answer hints.

### Problem

Entity queries are a common memory use case:

- "Who is X?"
- "What do we know about Y?"
- "What happened with her last month?"

Basic semantic search is not enough for these cases. Good entity recall needs:

- stronger alias handling
- recent-turn carry-forward for pronouns and follow-ups
- separation between direct factual answers and instruction-like noise
- privacy-aware ranking for person and relationship facts

### Goals

- Detect entity-seeking queries
- Resolve likely entity targets from the current query and recent turns
- Build or maintain an entity mention index across memories and native knowledge
- Prioritize direct answer candidates
- Provide answer hints in recall context before long supporting memory lists

### Non-Goals

- Building a full general-purpose graph database
- Solving arbitrary coreference beyond the recent local dialogue window
- Replacing normal recall for non-entity queries

### Capabilities

Add:

- entity intent detection
- alias normalization and canonicalization
- recent-turn coreference for pronouns and short follow-ups
- entity mention indexing across memory files, transcripts when appropriate, and native knowledge sync
- direct-answer scoring for "who is" and "what do you know about" style prompts
- penalties for instruction-like, template-like, or low-signal content
- uncertainty handling when answers conflict

### Recall Output Shape

For entity-oriented recall, Engram should be able to inject:

- `entity_answer_hints`
- top supporting facts
- recent timeline snippets when relevant
- related entities when confidence is high

This keeps the answer layer concise while preserving evidence.

### Ranking Guidance

Boost:

- compact factual statements
- relationship facts when the query is person-centered
- high-confidence, recently accessed, or curated entity facts

Penalize:

- instruction-like text
- extraction/process chatter
- low-signal duplicates
- metadata wrappers

### Privacy And Safety

- private person facts must not leak into shared recall
- relationship boosts must respect namespace/privacy boundaries
- answer hints must reflect uncertainty instead of overclaiming when evidence conflicts

### Architecture

- Maintain an entity mention index under `memoryDir/state/` or an optional derived projection store
- Update aliases and entity cards during normal extraction and native sync
- Use a recent-turn query enricher before recall planning finalizes the search

### Rollout

Phase 1:

- entity query detection
- alias index
- answer hint generation

Phase 2:

- recent-turn coreference
- instruction/noise penalties

Phase 3:

- richer entity cards
- related entity traversal

### Acceptance Criteria

- Engram gives materially better answers for entity queries and pronoun follow-ups
- Shared contexts do not leak private entity facts
- Conflicting entity facts are surfaced with explicit uncertainty

---

## Feature 8: Setup, Health, And Benchmarking Toolkit

### Summary

Add a complete operator toolkit for install, setup, health checks, inventory, rebuild, and recall benchmarking.

### Problem

Engram is powerful, but today it still expects too much operator guesswork around:

- initial setup
- QMD readiness
- config validation
- maintenance visibility
- performance regressions
- index freshness

### Goals

- make first-run installation reliable
- surface actionable health diagnostics
- provide inventory and maintenance visibility
- support reproducible recall benchmarking before and after changes
- keep outputs scriptable and human-readable

### Non-Goals

- hosted monitoring
- replacing CI
- replacing deep manual debugging for rare edge cases

### Commands

Recommended commands:

- `openclaw engram setup`
- `openclaw engram doctor`
- `openclaw engram inventory`
- `openclaw engram benchmark recall`
- `openclaw engram rebuild-index`
- `openclaw engram repair`

### `setup`

Should:

- validate `openclaw.json`
- create missing directories
- check QMD binary and collection availability
- optionally initialize native sync config
- optionally install explicit capture instructions when the capture feature is enabled
- print next steps and verification commands

### `doctor`

Should check:

- config parse success
- file permissions
- memory directory structure
- QMD availability and collection health
- transcript/index freshness
- last successful maintenance run
- API auth configuration when the bridge API is enabled
- file hygiene limits for bootstrapped files

It should return:

- human-readable output
- JSON mode for scripts and CI
- suggested remediation steps

### `inventory`

Should report:

- counts by category, namespace, status, age band
- profile and entity sizes
- archive pressure
- review queue size
- index freshness
- storage footprint

### `benchmark recall`

Should support:

- case files with expected memories, entities, or categories
- latency metrics
- precision/recall-style scoring where possible
- side-by-side compare between two Engram configs or two revisions
- machine-readable run output
- golden query suites checked into the repo for regression testing
- optional explain dumps for failed benchmark cases

### Architecture

- All commands should operate correctly in read-only mode where possible
- JSON output should be stable and versioned
- Health checks should be safe to run on production workspaces
- Benchmark runs should never mutate memory unless explicitly requested

### Rollout

Phase 1:

- `setup`
- `doctor`
- `inventory`

Phase 2:

- benchmark harness
- rebuild and repair commands

Phase 3:

- CI-friendly recall regression packs
- maintenance SLA checks

### Acceptance Criteria

- A new user can get Engram running with one guided setup flow
- Operators can diagnose bad setup or stale indexes without reading source code
- Recall changes can be benchmarked and compared before rollout

---

## Notes For Issue Creation

When these become GitHub issues:

- keep each issue as a separate feature request
- link each one back to the storage decision above
- include dependencies where one feature requires another
- prefer concrete acceptance criteria over broad goals
- keep rollout phased so Engram can ship value incrementally
