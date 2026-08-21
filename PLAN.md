# OpenClaw Engram Roadmap

**Current Version:** 2.2.3
**Last Updated:** 2026-02-11

---

## Completed Features

### v1.0.0 — Core Memory System (2026-02-05)
- GPT-5.2 extraction via OpenAI Responses API
- QMD hybrid search (BM25 + vector + reranking)
- Markdown + YAML frontmatter storage
- 10 memory categories: fact, preference, correction, entity, decision, relationship, principle, commitment, moment, skill
- Question generation and identity reflections
- Profile auto-consolidation
- CLI tools: search, store, profile, entities, questions, identity

### v1.1.0 — Observability & Entity Management (2026-02-07)
- LLM trace callback system for external observability plugins
- Inter-plugin discovery via `globalThis.__openclawEngramOrchestrator`
- Token usage reporting on all LLM calls
- Entity extraction with known entity name injection
- Fuzzy entity matching to prevent fragmentation
- Configurable entity aliases (`config/aliases.json`)

### v1.2.0 — Retrieval Quality & Knowledge Graph (2026-02-07)
- **Access Tracking**: Track memory access counts and recency (batched updates)
- **Local Importance Scoring**: Zero-LLM heuristic scoring with critical/high/normal/low/trivial tiers
- **Recency Boosting**: Recent memories rank higher (configurable weight)
- **Access Count Boosting**: Frequently accessed memories surface higher
- **Status Field**: Lifecycle management (active/superseded/archived)
- **Automatic Chunking**: Sentence-boundary chunking for long memories (disabled by default)
- **Contradiction Detection**: LLM-verified contradiction resolution (disabled by default)
- **Memory Linking**: Knowledge graph with typed relationships (disabled by default)
- **Conversation Threading**: Group memories into threads (disabled by default)
- **Memory Summarization**: Compress old memories into summaries (disabled by default)
- **Topic Extraction**: TF-IDF topic analysis from memory corpus

### v2.0.0 — Transcript & Context Preservation (2026-02-08)
- **Transcript Archive**: Full conversation history stored in JSONL with 7-day retention
- **Transcript Injection**: Recent conversation context (12h) automatically injected into recall
- **Compaction Checkpoint**: Pre-compaction state capture for seamless session recovery
- **Hourly Summaries**: Per-channel narrative summaries of conversation activity
- **Cron Integration**: Optional hourly summary generation via cron (recommended configuration: `sessionTarget: "isolated"` + `payload.kind: "agentTurn"` calling `memory_summarize_hourly`)

### v2.1.0 — Local LLM Provider Support (2026-02-08)
- **Local LLM Client**: Auto-detection of LM Studio, Ollama, MLX, vLLM
- **Fallback Support**: Graceful degradation to gateway's default AI when local LLM unavailable
- **Extraction via Local LLM**: Memory extraction using local models (qwen3-coder-30b recommended)
- **Summarization via Local LLM**: Hourly summaries using local models (phi-4 recommended)
- **Configurable Endpoints**: Custom URL and model name support
- **Multi-Provider Fallback**: Supports OpenAI, Anthropic, and any OpenAI-compatible API configured in openclaw.json
- **Hard Timeout**: Configurable `localLlmTimeoutMs` (default 180s) to prevent stalls
- **Slow Query Log**: `slowLogEnabled` + `slowLogThresholdMs` for debugging long local/QMD operations
- **Safer Logging Defaults**: No request-body previews at info level; reduced noisy startup output

### v2.2.0 — Advanced Retrieval (2026-02-10)
- **Heuristic Query Expansion**: Optional expanded queries (no LLM calls) to improve recall coverage
- **LLM Re-ranking**: Optional, timeboxed local-only rerank of top candidates (fail-open)
- **Feedback Loop**: Optional thumbs up/down tool (`memory_feedback`) stored locally and applied as a soft bias

---

## Planned Features

### v2.3 — Memory Import & Export

**Goal:** Enable data portability and backup.

#### Scope (What We Export/Import)
- Memories (markdown + YAML frontmatter)
- State files:
- `profile.md`, `IDENTITY.md`, `questions.json`, `entities/`, `threads/`, `summaries/`, `state/*.json`
- Transcript archive is optional:
- Default: exclude transcripts from exports unless explicitly requested (privacy + size)

#### Export
- Formats:
- JSON: portable manifest + full memory records (including frontmatter fields)
- Markdown bundle: copy of memory directory structure (optionally packaged)
- SQLite: single-file export suitable for analysis and import
- CLI surface:
- `openclaw engram export --format json --out <path> [--include-transcripts] [--namespace <ns>]`
- `openclaw engram export --format sqlite --out <path> [--namespace <ns>]`
- `openclaw engram export --format md --out <dir> [--namespace <ns>]`
- Design notes:
- JSON should include a top-level `manifest.json` with version, export time, plugin version, and checksum.
- SQLite schema should include `memories`, `entities`, `links`, `feedback`, `negatives`, `meta` tables.

#### Import
- Sources:
- Engram exports (json/sqlite/md bundle)
- Other systems (future): mem0, CLAWS, Honcho exports (if/when formats are known and stable)
- CLI surface:
- `openclaw engram import --from <path> [--format auto] [--namespace <ns>] [--dry-run]`
- `openclaw engram import --from <path> --format json [--conflict skip|overwrite|dedupe]`
- Conflict policy (default):
- Skip if a memory with the same `id` exists.
- Optional `--dedupe` mode that detects duplicates by content hash and tags imported items with `importedFrom`.

#### Backup
- Goal: safe, low-risk backups without requiring a running gateway.
- CLI surface:
- `openclaw engram backup --out-dir <dir> [--retention-days N] [--include-transcripts]`
- Implementation approach:
- Create timestamped backup directories.
- Copy only the Engram `memoryDir` (or per-namespace directory once v3.0 lands).
- Optional retention enforcement that deletes old backups.
- Note: scheduling is external (cron/launchd/systemd). Engram provides the command.

#### Migration Tools
- Goal: make it safe to re-run transformations as prompts and heuristics evolve.
- CLI surface:
- `openclaw engram migrate rescore-importance [--dry-run]`
- `openclaw engram migrate rechunk [--dry-run]`
- `openclaw engram migrate normalize-frontmatter [--dry-run]`
- `openclaw engram migrate reextract --model <id> [--limit N] [--dry-run]`
- Safety defaults:
- Always support `--dry-run`.
- Prefer additive changes and preserve originals where practical.
- Never require cloud calls by default (re-extract should be explicit).

---

### v2.4 — Context Retention System Hardening (Hourly + Semantic Recall)

**Goal:** Reduce knowledge loss in long-running systems by making summaries richer and enabling optional “search your own past conversations” recall.

#### Extended Hourly Summaries (Plan)
- Current: “hourly summaries” are narrative-only and primarily based on transcript turns.
- Add an optional “extended” mode that captures:
- Topics discussed (bulleted)
- Decisions made (bulleted, include who/when if available)
- Action items (bulleted, include owner if available)
- Rejected ideas / reversals (bulleted)
- Tools used counts (top N tool names + counts)
- Basic stats (user msgs, assistant msgs, tool calls)
- Storage format:
- Append-only daily files per sessionKey:
- `memoryDir/summaries/hourly/<sessionKey>/<YYYY-MM-DD>.md`
- Each hour as a heading: `### 2026-02-11 14:00` (local TZ)
- Scheduling:
- Keep cron as the driver; allow per-install schedules and staggering.
- Provide a helper command/script to install/update the cron job (do not silently rewrite `~/.openclaw/cron/jobs.json` at runtime).
- Config:
- `hourlySummariesExtendedEnabled` (default false)
- `hourlySummariesIncludeToolStats` (default false)
- `hourlySummariesIncludeSystemMessages` (default false)
- `hourlySummariesMaxTurnsPerRun` (default conservative)
- Safety:
- Never log or store secrets.
- Never include raw tool args for sensitive tools; only count tool names unless explicitly enabled.

#### Conversation Chunk Embeddings + Semantic Recall Hook (Optional)
- Add an optional “conversation index” alongside (or separate from) memory indexing.
- Behavior:
- Chunk past transcript turns into “conversation chunks” (time-bounded, e.g. 10-30 turns or N chars).
- Embed each chunk and store it in an index (per sessionKey and/or per namespace once v3.0 lands).
- On each new prompt, run semantic search over the conversation index and inject top-K relevant chunks into context.
- Default off (privacy + storage).
- Implementation options (choose one in implementation plan):
- Option A: FAISS + `sentence-transformers` (`all-MiniLM-L6-v2`, 384-dim) in a Python sidecar script, run via cron.
- Option B: Node-native embeddings (ex: local embedding endpoint) + QMD documents for transcript chunks (single infra, less tooling).
- Config:
- `conversationIndexEnabled` (default false)
- `conversationIndexBackend` (`faiss` | `qmd`)
- `conversationIndexMaxChunks` / `conversationIndexRetentionDays`
- `conversationRecallTopK` / `conversationRecallMaxChars`
- Risks to manage:
- Disk growth (indexes can grow fast).
- Privacy (transcripts can contain sensitive content; defaults must be conservative).
- Latency (semantic recall must be fast and fail-open; do not block Discord listener loop).

---

### v3.0 — Multi-Agent Memory

**Goal:** Share memories across multiple agents with access control.

#### Concepts
- Principal: the caller identity used for access checks (initially derived from `sessionKey`)
- Namespace: a partition of memory (examples: `josh`, `calla`, `shared`, `public`)
- Policy: which principals can read/write which namespaces

#### Principal Resolution (How We Know Who Is Calling)
- Phase 1 (no OpenClaw core changes):
- Derive principal from `sessionKey` using configurable rules:
- `principalFromSessionKeyMode: prefix|regex|map`
- `principalFromSessionKeyRules`: ordered list of {match, principal}
- Default principal: `default`
- Phase 2 (optional, requires OpenClaw core support):
- If plugin SDK exposes an explicit agent id, prefer that over sessionKey heuristics.

#### Storage Layout
- Move from one directory to per-namespace layout:
- `memoryDir/namespaces/<namespace>/...` where each namespace contains:
- category folders (`facts/`, `preferences/`, etc)
- `state/` (relevance/negatives/topics/etc)
- `transcripts/` optional per namespace or global (decision needed)
- Provide migration:
- Existing memoryDir becomes `namespaces/default` by default.

#### QMD Indexing Strategy
- Option A (recommended):
- QMD collection per namespace: `openclaw-engram-<namespace>`
- Search default namespace + configured shared namespaces.
- Option B:
- Single collection with namespace prefix inside documents (simpler, weaker isolation)

#### Access Control
- Config:
- `namespacesEnabled` boolean
- `namespaces` array with:
- `name`, `readPrincipals`, `writePrincipals`, `includeInRecallByDefault`
- Enforcement:
- All writes require write permission to the target namespace.
- Reads for recall/search only include namespaces the principal can read.
- Tooling:
- Add namespace-aware variants:
- `memory_search` gains optional `namespace` param (default: caller default)
- `memory_store` gains optional `namespace` param (default: caller default)
- Add `memory_promote` tool: move/copy memory from private namespace to shared with audit note.

#### Agent-Specific Profiles
- Profiles and identity reflections should be namespace-scoped by default:
- `profile.md` per namespace
- `IDENTITY.md` either per namespace or global (decision needed)

#### Cross-Agent Learning
- Default policy:
- Agents write to their own namespace.
- Selected “curated” memories can be promoted to `shared` by an explicit tool call.
- Optional future:
- Auto-promote based on high-confidence categories (explicit preference/fact/correction) gated by allowlist.

#### Verification
- Unit tests:
- Principal resolution logic
- Namespace path mapping
- Access control enforcement (read and write)
- Recall only includes allowed namespaces
- CLI tests:
- Export/import per namespace (once v2.3 + v3.0 intersect)

---

### v4.0 — Cross-Agent Shared Intelligence (Shared Context Layer)

**Goal:** Make a multi-agent OpenClaw installation behave like a coordinated team by giving agents a shared “brain” they all read before acting, plus daily synthesis and cross-signal amplification.

#### Core Idea
- Introduce a shared, file-based context layer (a directory) that all agents can read/write:
- `shared-context/priorities.md` (living priority stack)
- `shared-context/agent-outputs/` (work products each agent drops; others consume)
- `shared-context/feedback/` (approval/rejection stream that trains all agents)
- `shared-context/roundtable/` (daily synthesis + cross-signals)
- Optional: `kpis/`, `calendar/`, `content-calendar/`, `cross-signals.json`

#### Why This Is A Major Version
- This crosses “single-agent memory” into “multi-agent operational coordination”.
- Requires conventions around access control, write hygiene, and retention.
- Needs careful defaults to avoid creating spam/junk-drawer behavior.

#### Open Questions (Must Decide Early)
- Where should `shared-context/` live in an OpenClaw install:
- under `workspace/` (no symlinks, simpler) vs external path + symlink (closer to the pattern you shared)?
- Should Engram manage this as:
- Decision: ship inside Engram (v4.0), not a separate plugin.
- How strict should write rules be:
- Decision: staged writes + curator merge, plus a small allowlist of direct-write paths.
- What is the “source of truth” for priorities:
- Decision: both, with explicit merge rules.
- Canonical top section is curated; automated inputs append below with timestamps; curator merges.

#### Planned Components
- Living Priority Stack
- A well-known file that all agents read at start of each run.
- Cross-Signal Detection
- Detect entity/topic overlap across agent outputs; amplify when 2+ independent sources mention the same entity.
- Provide an optional semantic (LLM-assisted) enhancer that can detect fuzzy matches and topic-level overlaps.
- Must support any OpenClaw provider (including robust local LLM); should also leverage existing Engram entity extraction + similarity checks across agent memories.
- Daily Context Sync (cron)
- Summarize what each agent learned today; produce a “roundtable” digest and update `cross-signals.json`.
- Weekly Memory Compound (cron)
- Distill what worked/didn’t; extract durable patterns into shared memory (or curated docs).
- Feedback Loop (shared)
- A simple, append-only approval/rejection stream that all agents consult and that can bias future outputs.

#### Success Criteria
- Agents stop working at cross-purposes (measured by reduced contradictory/duplicate outputs).
- High-signal overlaps are surfaced (entity convergence) without human routing.
- Priorities changes propagate within one run cycle.
- Shared-context remains readable and does not degrade into noise (curation/retention works).

---

### v5.0 — Memory Compounding Engine (Weekly Learning + Outcomes)

**Goal:** Make agents measurably improve week-over-week by learning from approvals/rejections and outcomes, and turning that into durable, reusable rules (institutional knowledge).

#### Core Idea
- Capture structured feedback for agent recommendations, including:
- Decision: `approved` | `rejected` | `approved_with_feedback`
- Reason: human-readable explanation of why
- Learning: the extracted rule/constraint (if any)
- Outcome fields: optional numeric/structured fields (deal value, conversion lift, time saved, etc.)
- Run a weekly synthesis that turns that stream into:
- “Mistakes we don’t repeat” (concise patterns)
- “Rubrics” (what good looks like per agent/task type)
- Promoted durable memories (preferences/principles/corrections/decisions) into shared context (once v3/v4 shared layers exist)

#### Shipping Decision
- One-phase: ship with outcomes support from day one (not a later add-on).

#### Planned Components
- Feedback schema + storage
- Append-only feedback log(s) in shared-context (and optionally per-namespace once v3.0 lands).
- Tools to record feedback/outcomes (strict schema, append-only).
- Weekly synthesis job (cron)
- Summarize feedback, extract mistakes/rubrics, and write weekly rollup artifacts.
- Mistake tracker
- Maintain a `mistakes.json` (or JSONL) that is actively referenced at runtime as constraints.
- Outcome-aware learning
- Incorporate outcomes into weighting, rubric evolution, and prioritization frameworks (e.g. ICE, confidence scoring).
- Runtime enforcement
- Ensure the “mistakes” and “rubrics” are injected into prompts and/or used as ranking bias so the learning changes behavior.
- Auditing + provenance
- Every synthesized rule must link back to the source feedback entry IDs and the original artifact(s).

#### Success Criteria
- The same rejection reason stops recurring (measured by reduced repeated mistakes).
- Agents adopt stable rubrics (e.g., “always include confidence score”) across weeks.
- Outcomes improve (or time-to-decision drops) for repeated workflows.

---

## Implementation Plans
- v2.3: `docs/plans/2026-02-11-v2.3-memory-import-export.md`
- v2.4: `docs/plans/2026-02-11-v2.4-context-retention-hardening.md`
- v3.0: `docs/plans/2026-02-11-v3.0-multi-agent-memory.md`
- v4.0: `docs/plans/2026-02-11-v4.0-cross-agent-shared-intelligence.md`
- v5.0: `docs/plans/2026-02-11-v5.0-memory-compounding-engine.md`

## Resolved Decisions (2026-02-11)
1. v2.3 exports: transcripts are excluded by default; include only via explicit `--include-transcripts`.
2. v2.3 SQLite: must be round-trip importable (export + import).
3. v3.0 transcripts: global-per-install, filtered by principal/namespace at recall time.
4. v3.0 identity patterns: per-namespace (agent-specific), stored in `workspace/IDENTITY.md` as separate sections per namespace (keeps one file, but avoids cross-namespace blending).
5. v3.0 principal resolution: derive principal from `sessionKey` via configurable mapping rules (no OpenClaw core changes required).
6. v3.0 QMD strategy: use one QMD collection per namespace (strong isolation; merge results across allowed namespaces).
7. v3.0 default recall/search: search principal namespace + `shared` by default (do not include `public` unless explicitly configured).
8. v3.0 shared writes: auto-promote is enabled for selected categories, gated by explicit config allowlist and high-confidence rules (details TBD).
9. v3.0 shared auto-promote categories: `correction`, `decision`, `preference` (config allowlist; conservative defaults; never auto-promote transcripts/moments).

---

## Deferred Ideas

These ideas are noted but not currently planned:

- **Real-time Sync**: Multi-device memory sync (conflicts with local-first philosophy)
- **Image Memory**: Extract and search memories from images
- **Audio Memory**: Transcribe and index voice conversations
- **Third-Party Integrations**: Direct sync with Notion, Obsidian, etc.

---

## Versioning Policy

- **Major (X.0.0)**: Breaking changes to storage format or API
- **Minor (x.Y.0)**: New features, backward compatible
- **Patch (x.y.Z)**: Bug fixes, documentation updates

---

*Maintained by: openclaw-engram maintainers*
*Changelog: See CHANGELOG.md for detailed release notes*
