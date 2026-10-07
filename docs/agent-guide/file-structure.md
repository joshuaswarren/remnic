# File Structure

Extracted from `AGENTS.md` (Path B 2026-10-07).

## File Structure

The codebase is a monorepo. Core logic lives in `packages/remnic-core/`;
host adapters and CLI live in sibling packages.

```
packages/
├── remnic-core/           # Core memory engine (primary source)
├── remnic-cli/            # CLI tooling
├── remnic-server/         # Server runtime
├── plugin-openclaw/       # OpenClaw host adapter
├── plugin-claude-code/    # Claude Code host adapter
├── plugin-codex/          # Codex host adapter
├── plugin-hermes/         # Hermes host adapter
├── hermes-provider/       # Hermes provider integration
├── connector-replit/      # Replit connector
├── shim-openclaw-engram/  # Legacy engram shim
└── bench/                 # Benchmarks

packages/remnic-core/src/
│
│  ── Core pipeline ──────────────────────────────────
├── index.ts               # Plugin entry, hook registration
├── config.ts              # Config parsing with defaults
├── types.ts               # TypeScript interfaces
├── logger.ts              # Logging wrapper
├── orchestrator.ts        # Core memory coordination
├── storage.ts             # File I/O for memories
├── buffer.ts              # Smart turn buffering
├── extraction.ts          # GPT-5.2 extraction engine
├── qmd.ts                 # QMD search client
├── importance.ts          # Importance scoring
├── chunking.ts            # Large content chunking
├── threading.ts           # Conversation threading
├── topics.ts              # Topic extraction
├── tools.ts               # Agent tools
├── cli.ts                 # CLI commands
│
│  ── Recall & retrieval ─────────────────────────────
├── retrieval.ts           # Recall pipeline implementation
├── intent.ts              # Intent heuristics (morphology-aware)
├── signal.ts              # Signal-based flush triggers
├── recall-qos.ts          # Recall quality-of-service
├── recall-mmr.ts          # Maximal marginal relevance
├── recall-query-policy.ts # Query rewrite policy
├── recall-audit.ts        # Recall audit trail
├── qmd-recall-cache.ts    # QMD recall caching
├── rerank.ts              # Re-ranking pipeline
├── harmonic-retrieval.ts  # Harmonic retrieval scoring
├── verified-recall.ts     # Verified recall checks
│
│  ── Classification & scoring ───────────────────────
├── himem.ts               # Episode/Note classification (v8.0)
├── boxes.ts               # Memory Box builder + Trace Weaver (v8.0)
├── extraction-judge.ts    # LLM-as-judge fact-worthiness gate (#376)
├── semantic-chunking.ts   # Topic-boundary chunking (#368)
├── source-attribution.ts  # Citation/attribution helpers (#379)
├── relevance.ts           # Relevance scoring
├── calibration.ts         # Score calibration
│
│  ── Versioning & lifecycle ─────────────────────────
├── page-versioning.ts     # Snapshot-based version history (#371)
├── lifecycle.ts           # Memory lifecycle management
├── temporal-supersession.ts # Temporal supersession logic
├── temporal-index.ts      # Temporal indexing
│
│  ── Session & context ──────────────────────────────
├── session-integrity.ts   # Session integrity checks
├── session-toggles.ts     # Per-session feature toggles
├── session-observer-bands.ts # Observer band system
├── session-observer-state.ts # Observer state tracking
├── profiling.ts           # User profiling
├── identity-continuity.ts # Identity continuity
│
│  ── Causal reasoning ───────────────────────────────
├── causal-chain.ts        # Causal chain tracking
├── causal-behavior.ts     # Behavioral causal signals
├── causal-retrieval.ts    # Causal-aware retrieval
├── causal-consolidation.ts # Causal consolidation
├── causal-trajectory.ts   # Trajectory tracking
├── causal-trajectory-graph.ts # Trajectory graph
│
│  ── Graph & dashboard ──────────────────────────────
├── graph.ts               # Knowledge graph
├── tmt.ts                 # Tree-of-memory-traces
├── graph-dashboard-*.ts   # Dashboard rendering (diff, key, parser)
├── abstraction-nodes.ts   # Abstraction node system
│
│  ── Access & MCP ───────────────────────────────────
├── access-mcp.ts          # MCP access provider
├── access-cli.ts          # CLI access provider
├── access-http.ts         # HTTP access provider
├── access-service.ts      # Access service coordinator
├── access-schema.ts       # Access schema definitions
├── access-idempotency.ts  # Idempotent access operations
│
│  ── Utilities & support ────────────────────────────
├── sanitize.ts            # Content sanitization
├── tokens.ts              # Token counting
├── json-extract.ts        # JSON extraction helpers
├── json-store.ts          # JSON-backed storage
├── whitespace.ts          # Whitespace handling
├── bootstrap.ts           # Bootstrap/init routines
├── model-registry.ts      # LLM model registry
├── fallback-llm.ts        # LLM fallback routing
├── local-llm.ts           # Local LLM integration
│
│  ── Subdirectories ─────────────────────────────────
├── enrichment/            # External enrichment pipeline (#365)
├── binary-lifecycle/      # Binary file management (#367)
├── taxonomy/              # MECE taxonomy resolver (#366)
├── memory-extension/      # Extension publisher contract (#381, #382)
├── memory-extension-host/ # Extension host discovery (#381)
├── compat/                # Provider compatibility checks
├── adapters/              # Host adapter interfaces
├── connectors/            # External service connectors
├── conversation-index/    # Conversation indexing
├── compounding/           # Compounding memory logic
├── curation/              # Memory curation pipeline
├── dedup/                 # Deduplication engine
├── lcm/                   # Lifecycle management
├── maintenance/           # Maintenance tasks
├── migrate/               # Migration scripts
├── namespaces/            # Multi-tenant namespace logic
├── network/               # Network transport layer
├── onboarding/            # Onboarding flows
├── projection/            # Memory projections
├── replay/                # Replay/debug tooling
├── review/                # Review pipeline
├── routing/               # Routing logic
├── runtime/               # Runtime services
├── search/                # Search subsystem
├── shared-context/        # Shared context management
├── spaces/                # Memory spaces
├── surfaces/              # Surface adapters
├── sync/                  # Sync engine
├── transfer/              # Data transfer utilities
├── utils/                 # Shared utility functions
└── work/                  # Work-product tracking

~/.openclaw/workspace/memory/local/
├── profile.md             # User profile
├── facts/                 # Daily fact directories
│   ├── 2026-02-01/
│   │   ├── fact-123.md
│   │   └── decision-456.md
│   └── 2026-02-07/
│       └── ...
├── entities/              # Entity files
│   ├── person-joshua-warren.md
│   ├── company-creatuity.md
│   └── project-openclaw.md
├── corrections/           # Explicit corrections
├── questions/             # Curiosity questions
├── summaries/             # Compressed old memories
└── state/
    ├── buffer.json        # Current buffer state
    └── meta.json          # Extraction counters
```

### Memory File Format

Facts and entities use markdown with YAML frontmatter:

```markdown
---
id: fact-1770469224307-eelr
category: decision
confidence: 0.85
created: 2026-02-07T10:00:00Z
updated: 2026-02-07T10:00:00Z
tags:
  - architecture
  - database
entityRef: project-openclaw
importance:
  score: 0.7
  reason: architectural decision
status: active
---

We decided to use PostgreSQL for the main database because it handles JSON well and has excellent extension support.
```
