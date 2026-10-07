# Architecture Notes

Extracted from `AGENTS.md` (Path B 2026-10-07).

## Architecture Notes

### File Structure
```
packages/remnic-core/src/
│
│ ── Core lifecycle ──────────────────────────────────────
├── index.ts                    # Plugin entry point, hook registration
├── config.ts                   # Config parsing with defaults
├── types.ts                    # TypeScript interfaces
├── logger.ts                   # Logging wrapper
├── orchestrator.ts             # Core memory coordination
├── storage.ts                  # File I/O for memories
├── buffer.ts                   # Smart turn buffering
├── lifecycle.ts                # Session and service lifecycle management
├── bootstrap.ts                # Plugin bootstrap / init sequence
│
│ ── Extraction & scoring ────────────────────────────────
├── extraction.ts               # GPT-5.2 extraction engine
├── extraction-judge.ts         # LLM-as-judge fact-worthiness gate
├── importance.ts               # Importance scoring
├── calibration.ts              # Score calibration helpers
├── topics.ts                   # Topic extraction
│
│ ── Chunking & storage format ───────────────────────────
├── chunking.ts                 # Recursive large-content chunking
├── semantic-chunking.ts        # Topic-boundary chunking (embedding-based)
├── page-versioning.ts          # Snapshot-based version history for memory files
├── citations.ts                # OAI-mem-citation block generation
│
│ ── Recall & retrieval ──────────────────────────────────
├── qmd.ts                      # QMD search client
├── qmd-recall-cache.ts         # Recall result caching
├── retrieval.ts                # Primary retrieval orchestration
├── recall-audit.ts             # Recall audit trail
├── recall-mmr.ts               # Maximal marginal relevance diversification
├── recall-qos.ts               # Recall quality-of-service enforcement
├── recall-query-policy.ts      # Query rewriting / policy
├── recall-state.ts             # Recall state tracking
├── rerank.ts                   # Result reranking
├── source-attribution.ts       # Source attribution for recalled facts
│
│ ── Dedup & consolidation ───────────────────────────────
├── dedup/                      # Semantic deduplication pipeline
├── semantic-consolidation.ts   # Embedding-aware memory merging
├── summarizer.ts               # Summary generation
├── summary-snapshot.ts         # Point-in-time summary snapshots
│
│ ── Taxonomy & classification ───────────────────────────
├── taxonomy/                   # MECE taxonomy resolver, loader, defaults
├── entity-retrieval.ts         # Entity-aware retrieval
├── entity-schema.ts            # Entity type definitions
│
│ ── Extensions & publishers ─────────────────────────────
├── memory-extension/           # Third-party extension discovery + publishers
├── memory-extension-host/      # Host-side extension rendering + discovery
│
│ ── Enrichment ──────────────────────────────────────────
├── enrichment/                 # External enrichment pipeline, provider registry
│
│ ── Binary lifecycle ────────────────────────────────────
├── binary-lifecycle/           # Mirror/redirect/clean pipeline for binary files
│
│ ── Wearables ───────────────────────────────────────────
├── wearables/                  # Wearable transcript ingestion: connector registry, cleanup, redaction, corrections, speaker registry, day store, trust-gated memory gen
│
│ ── Access surfaces ─────────────────────────────────────
├── cli.ts                      # CLI commands
├── access-mcp.ts               # MCP server surface
├── access-http.ts              # HTTP API surface
├── access-cli.ts               # CLI access helpers
├── surfaces/                   # Heartbeat, dreams, and other surface integrations
│
│ ── Maintenance & governance ────────────────────────────
├── maintenance/                # Governance crons, archive, backup, observation ledger
├── hygiene.ts                  # Memory hygiene checks
├── memory-cache.ts             # Multi-layer memory cache
│
│ ── Compatibility & migration ───────────────────────────
├── compat/                     # Provider compatibility checks (Codex, etc.)
├── migrate/                    # Legacy data migration utilities
├── sdk-compat.ts               # SDK compatibility shims
│
│ ── Session & threading ─────────────────────────────────
├── threading.ts                # Conversation threading
├── session-integrity.ts        # Session identity validation
├── session-toggles.ts          # Per-session feature toggles
├── namespaces/                 # Multi-tenant namespace resolution
│
│ ── Supporting subsystems ───────────────────────────────
├── routing/                    # Tier and model routing
├── sync/                       # Cross-device sync
├── network/                    # Network transport helpers
├── profiling.ts                # Runtime profiling
├── intent.ts                   # User intent classification
├── tokens.ts                   # Token counting utilities
└── utils/                      # Shared utility functions
```

### Key Patterns

1. **Three-phase flow** — recall (before), buffer (after), extract (periodic)
2. **Smart buffer** — decides when to flush based on content signals
3. **GPT-5.2 for extraction** — uses OpenAI Responses API (NOT Chat Completions)
4. **QMD for search** — hybrid BM25 + vector + reranking
5. **Markdown + YAML frontmatter** — human-readable storage format
6. **Consolidation** — periodic merging, cleaning, and summarization
7. **Extraction judge** — optional LLM-as-judge post-filter evaluates fact durability before writes
8. **Semantic chunking** — sentence-embedding-based topic boundary detection alternative to recursive chunking
9. **Page versioning** — every memory file overwrite saves a numbered snapshot; list/diff/revert via CLI
10. **Citation blocks** — recall responses emit `<oai-mem-citation>` blocks for Codex-compatible attribution
11. **Publisher contract** — pluggable `MemoryExtensionPublisher` interface for host-specific extension installation
12. **MECE taxonomy** — deterministic categorization via mutually exclusive, collectively exhaustive directory
13. **Enrichment pipeline** — importance-tiered external enrichment with provider registry and audit trail
14. **Binary lifecycle** — three-stage mirror/redirect/clean pipeline for binary files in memory directory
15. **Wearable connectors** — à-la-carte `@remnic/connector-limitless|bee|omi` packages feed the shared `src/wearables/` pipeline (pull → cleanup → redaction → corrections → speaker labels → day store → trust-gated memory gen). Day transcripts live at `<memoryDir>/wearables/<source>/<date>.md` — QMD-searchable but outside the memory scan roots. Memory creation defaults to `memoryMode: "review"` (pending_review). See docs/wearables.md
16. **Desktop capture — activity + meetings** — the on-screen counterpart to the wearable pipeline (umbrella #1896). `src/activity/` (#1899) is a host-agnostic core subsystem: `ActivityStore` (SQLite, idempotent on `(machine, captured_at_utc, content_hash)`, atomic base+FTS writes, validated/canonicalized capture timestamps) plus a deterministic day digest rendered to `<memoryDir>/activity/<date>.md` (per-machine dwell, DST-correct `[start, end)` day windows, JSON-encoded frontmatter machine labels). `src/meetings/` (#1900, engine #2122 + surfaces #2123) is a fully-wired host-agnostic core subsystem that retrospectively derives meetings from a day's already-ingested signals: `detectMeetings()` (app-span ∩ audio-window, audio-only, and provider paths; non-overlapping meetings with re-run-stable `mtg-<date>-<hash>` IDs anchored on the exact start instant) → `fuseMeeting()` (reuses the shared wearables `fuseCluster` — never a parallel merger — with `corroboratedBy` and a `contextDwellSeconds`-gated screen-context timeline) → a deterministic markdown record at `<ns>/meetings/<date>/<meeting-id>.md` (idempotent on `contentHash`, outside the memory scan roots, excluded from generic recall by `isGenericRecallExcludedPath`) → `MeetingsBuilder` orchestration over a `MeetingsDaySource` → `createMeetingMemoryGenerator` writing a deterministic recall-anchor episode per record plus trust-gated `summaryMode` (`off`/`review`/`smart`) summary/facts (a judge `reject` drops even in `review` mode). The `meetings.*` config gate parses and validates (see docs/config-reference.md), defaulting off. Surfaces: the `remnic meetings list/show/build` CLI, MCP tools (`engram.meetings_list`/`engram.meetings_get`/`engram.meetings_build`, with `remnic.` aliases), HTTP routes (`/engram|remnic/v1/meetings[/:id|/build]`), and a post-sync (auto **and** manual) auto-build tail-step via the wearables `onDaysSynced` and activity `onActivitySynced` hooks. Caller-derived namespace symmetry: wearable sources, meeting records, and meeting memories are caller-namespaced (`writableNamespaceFor`/`resolveReadableNamespace`), while screen activity is a machine-global store consumed only for the default/machine-owner namespace (non-default callers run audio-only). All reachable from `@remnic/core`. Capture daemons (`@remnic/capture-screen`, `@remnic/capture-audio`) and native macOS/Windows helpers that produce screen/audio input are à-la-carte, fixture-`--replay`-testable, and land in later slices. See docs/meetings.md and docs/desktop-capture.md

### Integration Points

- `api.on("gateway_start")` — initialize orchestrator
- `api.on("before_prompt_build")` — inject memory context
- `api.on("agent_end")` — buffer turn for extraction
- `api.registerTool()` — memory search, stats, etc.
- `api.registerCommand()` — CLI interface
- `api.registerService()` — service lifecycle

### Testing Locally

```bash
# Build
npm run build

# Full restart (gateway_start hook needs this)
launchctl kickstart -k gui/501/ai.openclaw.gateway

# Or for hot reload (but gateway_start won't fire)
kill -USR1 $(pgrep openclaw-gateway)

# Trigger a conversation to test

# View logs
grep "\[engram\]" ~/.openclaw/logs/gateway.log
```

### Common Gotchas

1. **OpenAI must use Responses API** — never Chat Completions (per CLAUDE.md guidelines)
2. **Zod optional fields** — must use `.optional().nullable()`, not just `.optional()`
3. **Gateway launchd env isolated** — API keys must be in plist EnvironmentVariables
4. **Config schema strict** — new properties MUST be added to `openclaw.plugin.json` configSchema
5. **SIGUSR1 doesn't fire gateway_start** — use `launchctl kickstart -k` for full restart
6. **profile.md injected everywhere** — keep under 600 lines or consolidation triggers
7. **QMD `query` is intentional** — DO NOT change the *default* from `query` to `search` or `vsearch`. The `query` command provides LLM expansion + reranking that Remnic relies on. Remnic's own reranking was disabled because `qmd query` handles it. Likewise, the daemon's `query` MCP call intentionally runs a `lex+vec+hyde` plan (full hybrid recall), not BM25-only. Both are by design, not bugs — a slower daemon path doing more inference is expected on CPU-only models, NOT 70x "overhead" (issue #1335). If you need a faster BM25-only path, it is exposed as opt-in config, never as a default change: `qmdSubprocessStrategy: "search"` (CLI fallback) and `qmdSearchStrategy: "lex"`/`"lex-vec"` (daemon plan). Defaults stay `query`/`hybrid`. See `docs/search-backends.md` → "Tuning daemon latency on CPU-only models".
8. **QMD version gates** — Remnic targets `@tobilu/qmd` 2.5.3, probes `qmd --version`, and must keep older QMD installs working by omitting unsupported flags. Use `--format json` for QMD 2.5.3+ query/search subprocess calls; keep legacy `--json` for older versions.
11. **Scope globals per plugin ID** — runtime orchestrator mirrors, CLI dedupe guards, and capability caches must be keyed by `serviceId` when multiple instances can coexist.
12. **Write rollback data before success markers** — if a migration writes `.migrated-from-engram`, the `.rollback.json` must be written first so failures don't leave a false success marker.
13. **Wrap external service calls in try-catch** — token generation, daemon health probes, and filesystem writes must not crash the primary install/remove/config flow. Fail gracefully and surface a user-facing note instead.
20. **Search ALL code when changing function signatures** — when changing `addTurn(role, content)` to `addTurn(sessionId, turn)`, search `tests/`, and `packages/*/` — not just `src/`. Missed call sites in adapters were a recurring source of post-merge fixes.
21. **Interactive prompts must gate actual mutations** — if a migration prompt asks "migrate legacy config?" and the user says "no", the code must skip the actual config mutations, not just print different console messages while still writing the new config.
23. **Hash operations must use consistent content form** — if writes hash `rawContent`, reads and dedup checks must also hash `rawContent`, not the timestamped `citedContent`. Mixing forms silently breaks dedup.
25. **Don't destroy old state before confirming new state succeeds** — rotate tokens AFTER config write succeeds, clean up old profiles AFTER new profile is confirmed. PR #400 had 20+ review rounds on this pattern alone.
34. **Distinguish empty results from backend failures** — `search()` returning `[]` for both "index is empty" and "endpoint returned 5xx" prevents callers from short-circuiting on genuine failures. Use distinct result shapes: `{ok: true, results: []}` vs `{ok: false, error: "backend_unavailable"}`.
43. **Direct-write paths must trigger reindex** — bypassing the normal extraction→persist→index pipeline (e.g., heartbeat import writing directly to storage) leaves data undiscoverable until unrelated maintenance. After direct writes, explicitly call the reindex step.
49. **Deduplicate batch operation inputs before executing** — duplicate rollout slugs in a batch rename cause ENOENT crash when the second rename tries to move an already-moved file. Check for duplicates before processing, or verify source exists before each move. PR #392.

50. **Use canonical validation script names** — the root package exposes `check:ratchets` (plural) and `check-types`; `@remnic/core` exposes only `check-types`. Neither defines a `typecheck` script. Verify `package.json` before invoking scripts. Twenty fleet notes in one week came from guessed names.
51. **Use Biome for formatting** — the root package pins `@biomejs/biome` 1.9.4. Prettier is not installed anywhere in the workspace: `pnpm exec prettier` fails, and `npx prettier` may download Prettier and prompt for confirmation — use the pinned Biome binary instead. Do not run whole-file formatting on baseline-unformatted legacy files; format changed lines only. Six incidents caused whole-file churn.
52. **Keep napkins per worktree** — copy or create `.claude/napkin.md` in every worktree. Per-worktree napkins prevent concurrent writer clobbering.
- **GitHub PR review-comment API routes (agent-notes: 2026-08-14):** read a review comment with `repos/{owner}/{repo}/pulls/comments/{comment_id}` (no PR number in the path); reply with `repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies` (PR number required). The owner is `joshuaswarren` — read it from `git remote -v`, never guess. Five route-guessing failures on 2026-08-13/14.
