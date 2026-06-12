# remnic

## PUBLIC REPOSITORY — Privacy Policy

**This repository is PUBLIC on GitHub.** Every commit is visible to the world.

### Rules for ALL agents committing to this repo:

1. **NEVER commit personal data** — no names, emails, addresses, phone numbers, account IDs, or user identifiers
2. **NEVER commit API keys, tokens, or secrets** — even in comments or examples
3. **NEVER commit memory content** — the `facts/`, `entities/`, `corrections/`, `questions/`, `state/` directories contain user memories and must NEVER be committed
4. **NEVER commit IDENTITY.md or profile.md** — these contain personal behavioral profiles
5. **NEVER commit `.env` files** or any file containing credentials
6. **NEVER reference specific users, their preferences, or their data** in code comments or commit messages
7. **Config examples must use placeholders** — `${OPENAI_API_KEY}`, not actual keys
8. **Test data must be synthetic** — never use real conversation data in tests

### What IS safe to commit:
- Source code (`src/`, `scripts/`)
- Package manifests (`package.json`, `tsconfig.json`, `tsup.config.ts`)
- Plugin manifest (`openclaw.plugin.json`)
- Documentation (`README.md`)
- Build configuration
- `.gitignore`
- This `CLAUDE.md` file

### Procedural memory (issue #519)

Ships **enabled by default** since issue #567 PR 4/5 (previously default-off). Operators who want to opt out must set **`procedural.enabled`: `false`** (nested `procedural` object). Agents should read `docs/procedural-memory.md` and the README **Configuration** table for the full threshold defaults and the opt-out path.

### Before every commit, verify:
- `git diff --cached` contains NO personal information
- No hardcoded API keys, URLs with tokens, or credentials
- No references to specific users or their data

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

### Integration Points

- `api.on("gateway_start")` — initialize orchestrator
- `api.on("before_agent_start")` — inject memory context
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
9. **Legacy env var fallback chains** — always try `REMNIC_*` first, then fall back to `ENGRAM_*`. This applies to config parsing, hook scripts, and daemon label lookups.
10. **Never interpolate unsanitized values into shell scripts** — pass host/port/config values via environment variables, never via string interpolation into script command strings.
11. **Scope globals per plugin ID** — runtime orchestrator mirrors, CLI dedupe guards, and capability caches must be keyed by `serviceId` when multiple instances can coexist.
12. **Write rollback data before success markers** — if a migration writes `.migrated-from-engram`, the `.rollback.json` must be written first so failures don't leave a false success marker.
13. **Wrap external service calls in try-catch** — token generation, daemon health probes, and filesystem writes must not crash the primary install/remove/config flow. Fail gracefully and surface a user-facing note instead.
14. **Validate CLI flag arguments exist** — `--format`, `--focus`, `--since` without a following value must throw an error, not silently default.
15. **Sync lock files after dependency changes** — changing `workspace:*` specifiers or adding/removing packages requires `pnpm install` to update `pnpm-lock.yaml` and any nested `package-lock.json` files.
16. **Clean up ALL test globals in teardown** — include unkeyed globals like `__openclawEngramOrchestrator` in `resetGlobals()` helpers, not just the keyed ones.
17. **Expand `~` in all user-facing path inputs** — Node.js `fs` does NOT expand `~`. Use `expandTilde()` consistently, never ad-hoc regex. This applies to `memoryDir`, `--config`, env var paths, and `--memory-dir`.
18. **Validate JSON parse result type** — `JSON.parse('null')` succeeds but `null` is not a valid config. Always check `typeof result === 'object' && result !== null` after parsing before property access.
19. **Sort comparators must return 0 for equal items** — a comparator that returns `1` for both `compare(a,b)` and `compare(b,a)` violates the contract and produces non-deterministic ordering. Use a stable secondary key.
20. **Search ALL code when changing function signatures** — when changing `addTurn(role, content)` to `addTurn(sessionId, turn)`, search `evals/`, `tests/`, and `packages/*/` — not just `src/`. Missed call sites in adapters/evals were a recurring source of post-merge fixes.
21. **Interactive prompts must gate actual mutations** — if a migration prompt asks "migrate legacy config?" and the user says "no", the code must skip the actual config mutations, not just print different console messages while still writing the new config.
22. **Config resolution must be deduplicated** — the slot → PLUGIN_ID → LEGACY_PLUGIN_ID resolution was independently implemented in 5+ locations with divergent edge-case handling. Always import from the shared utility rather than reimplementing.
23. **Hash operations must use consistent content form** — if writes hash `rawContent`, reads and dedup checks must also hash `rawContent`, not the timestamped `citedContent`. Mixing forms silently breaks dedup.
24. **Reject file paths used as directory arguments** — `existsSync` returns true for files. Use `statSync().isDirectory()` when a directory is expected. Accepting a file as `memoryDir` produces a broken install that only fails later.
25. **Don't destroy old state before confirming new state succeeds** — rotate tokens AFTER config write succeeds, clean up old profiles AFTER new profile is confirmed. PR #400 had 20+ review rounds on this pattern alone.
26. **Import via package name, not relative cross-package paths** — `import { X } from "@remnic/core"` not `import { X } from "../../../remnic-core/src/foo.js"`. Directory renames silently break relative imports with no package-dependency signal.
27. **Guard `slice(-n)` against `n === 0`** — `entries.slice(-0)` equals `slice(0)` and returns ALL entries. Always check `if (n <= 0)` before negating for slice. The `-0 === 0` footgun is a JavaScript-specific trap.
28. **Coerce CLI values to expected types at input boundaries** — `--config port=5555` produces `"5555"` (string). `typeof saved === "number"` rejects it on reinstall. Always `Number(port)` + validate at the boundary, store as the expected type.
29. **Force-flush must bypass dedupe** — explicit flush surfaces (session flush, before_reset) must pass `skipDedupeCheck: true`. Stale dedup fingerprints from failed extractions suppress legitimate retries.
30. **New filters/transforms must have configuration gates** — every new recall filter, config transformation, or behavioral override needs an `enabled` check or escape hatch. Unconditional changes remove user control and break feature-flag symmetry.
31. **Core package files must never have host-specific prefixes** — `openclaw-recall-audit.ts` in `@remnic/core` violates the architecture boundary. Generic modules in core should use generic names (`recall-audit.ts`). Host adapters wrap core, not the other way around.
32. **Line parsers must track position during iteration, not use indexOf** — `content.indexOf(line)` returns the first occurrence, not the current parsing position. When parsing structured text with potential duplicate lines, maintain a running offset variable.
33. **Test mock function signatures must match production interfaces** — if production declares `getLastRecall(sessionKey: string)`, the mock must accept and use `sessionKey`, not define a zero-argument function. Mismatched mocks make tests pass vacuously.
34. **Distinguish empty results from backend failures** — `search()` returning `[]` for both "index is empty" and "endpoint returned 5xx" prevents callers from short-circuiting on genuine failures. Use distinct result shapes: `{ok: true, results: []}` vs `{ok: false, error: "backend_unavailable"}`.
35. **Time-range filters must use exclusive upper bounds** — `ts <= toMs` causes double-counting at midnight boundaries. Use `ts < toMs` consistently for half-open `[start, end)` interval semantics. Test with exact-boundary timestamps.
36. **String `"false"` is truthy in JavaScript** — `--config installExtension=false` produces `"false"` (string), which `!== false` evaluates as `true`. Coerce boolean-like strings (`"false"`, `"0"`, `"no"`, `"off"`) at config-read boundaries using a shared helper.
37. **Cache invalidation must clear ALL cache layers** — if `invalidateAllMemoriesCache()` only clears the hot cache but not `coldMemoriesCache`, stale data persists. When adding a cache layer, grep all invalidation functions and update them.
38. **Sort object keys before hashing/serializing** — `Object.entries({city, country})` vs `Object.entries({country, city})` produce different strings, breaking deduplication. Sort keys before serializing for any hash/content-dedup operation.
39. **Feature gates must be identical across all code paths** — if `temporalSupersessionEnabled` gates the QMD path but not the recent-scan fallback path, behavioral divergence depends on which recall path is exercised. Enumerate every path when adding a feature gate.
40. **Serialized promise chains must recover from rejection** — `writeChain = writeChain.then(fn)` without `.catch()` recovery permanently poisons the chain after the first I/O error. All subsequent `.then()` callbacks never execute. Use a `queueWrite()` wrapper that recovers the chain after rejection while still surfacing the error to the caller.
41. **Match loop iterator method to the data you need** — `for (const v of map.values())` when you also need the key means referencing an undefined or outer-scope variable. Use `.entries()` to destructure both key and value. TypeScript strict mode should catch this, but verify `noImplicitAny` is enabled.
42. **Read and write paths must resolve through the same namespace layer** — if search uses namespace-aware resolution, get/delete must too. Un-namespaced search in multi-principal deployments exposes cross-tenant data. Constrain search scope via session-derived namespace resolution.
43. **Direct-write paths must trigger reindex** — bypassing the normal extraction→persist→index pipeline (e.g., heartbeat import writing directly to storage) leaves data undiscoverable until unrelated maintenance. After direct writes, explicitly call the reindex step.
44. **Don't index content that failed to persist** — if a dedup check, importance gate, or other filter rejects content before it's written to storage, do NOT add it to `contentHashIndex`. Phantom index entries cause subsequent extractions with similar content to be silently dedup-suppressed against non-existent stored facts. PR #399.
45. **Config schema minimums must honor documented disable values** — if docs say "set to 0 to disable", both the JSON schema `minimum` AND the code path must accept 0. `Math.max(1, value)` with `minimum: 1` in the schema silently overrides the user's documented disable intent. PR #399.
46. **Escape literal template parts before building regex** — when constructing regex from user-provided templates, always `escapeRegex()` on the prefix/suffix. Empty prefix+suffix produces a match-everything regex. Special `$` in replacement strings corrupts output — use a replacement function or escape `$` → `$$`. PR #401.
47. **Shared mutable objects must not leak across connections/sessions** — a single mutable `clientInfo` object shared across MCP connections lets one session's adapter metadata bleed into another. In multi-tenant deployments this is a cross-tenant data leak. Use per-connection instances or deep-copy. PR #347.
48. **Enum defaults must be least-privileged** — when a decision/status enum is missing or `undefined`, defaulting to `"approved"` or `"enabled"` is a security vulnerability. Always default to `"rejected"`, `"pending"`, `"disabled"`, or `"none"`. PR #344, #345.
49. **Deduplicate batch operation inputs before executing** — duplicate rollout slugs in a batch rename cause ENOENT crash when the second rename tries to move an already-moved file. Check for duplicates before processing, or verify source exists before each move. PR #392.
50. **CI must never silence test/type failures** — `|| true` on `pytest`, `mypy`, `tsc`, or equivalent in CI makes broken code pass. Each quality gate must be a separate CI step that fails the build on error. PR #349.
51. **Reject invalid user input instead of silently defaulting** — invalid `--format`, `--since`, `--focus`, MCP parameters, or briefing window tokens must throw errors listing valid options. Silently falling back to defaults hides configuration mistakes. Applies to ALL input surfaces: CLI, MCP tools, API endpoints, and config parsing. PR #396 (10+ instances).
52. **Validation allow-lists must exactly match handled values** — if `BRIEFING_FORMAT_ALLOWED` includes `"text"` but downstream code only handles `"markdown"` and `"json"`, the validator accepts what the code can't process. Dead switch cases after name normalization (e.g., `case "remnic.briefing":` after converting to `engram.*`) must be removed. PR #396.
53. **Status filters must enumerate ALL non-active states** — filtering only `superseded` and `archived` but not `quarantined`, `rejected`, or `pending_review` causes stale data in user-facing outputs. Define an explicit `ACTIVE_STATUSES` set rather than an ad-hoc exclusion list. When adding a new status, grep ALL filters. PR #396.
54. **Never delete before write in file replace operations** — `rmSync(target)` then `renameSync(tmp, target)` loses data permanently if rename fails. Write to temp first, then rename atomically. Verify rename success before cleanup. `renameSync` can fail on cross-device moves. PR #394.
55. **Documented behavior must have a corresponding implementation and test** — if docs say "timeout is applied to all daemon calls", the provider must forward the timeout parameter AND a test must verify it. CI publish workflows must validate `github.ref == 'refs/heads/main'` on the job, not just the trigger. Config properties defined in schema must be wired end-to-end. PR #397, #398.
56. **Never merge before AI reviewers post** — `cursor[bot]` and `chatgpt-codex-connector[bot]` take 2-5 minutes to review a PR. Merging immediately after PR creation races past them, leaving comments unaddressed on merged code. Run `scripts/pre-merge-check.sh <PR#>` before every `gh pr merge`. The script verifies: (1) both AI reviewers have posted, (2) zero unresolved threads remain. PRs #429-#439 had 5 comments missed due to this race.
57. **À-la-carte packages must stay optional at every install layer** — users who only need memory features should not have to install benchmark, weclone, or plugin code. Optional workspace packages (`@remnic/bench`, `@remnic/export-weclone`, `@remnic/import-weclone`, etc.) MUST be loaded via computed-specifier dynamic imports (`await import("@remnic/" + "bench")`) and MUST NOT appear in any base install surface's runtime `dependencies` or `noExternal` bundler list. Declare them as `peerDependenciesMeta.*.optional = true` and surface a user-facing install hint when the dynamic import fails. See `packages/remnic-cli/src/optional-bench.ts` and `optional-weclone-export.ts` for the canonical pattern. See also the "À-la-carte packaging" section below.

## À-la-carte packaging

Remnic ships as a family of packages that compose. Every install surface must respect this contract:

- **Core always works alone.** `@remnic/core` is the only install most users need.
- **Optional packages never piggyback on the base install.** `@remnic/bench`, `@remnic/export-weclone`, `@remnic/import-weclone`, `@remnic/plugin-openclaw`, etc. must be separately `npm install`-able and must never be bundled, noExternal'd, or declared as a runtime `dependencies` entry on a base package.
- **Load optional packages lazily.** Use a computed-specifier dynamic import (`await import("@remnic/" + "bench")`) so bundlers cannot statically resolve the module. Wrap in a loader helper that throws a user-facing install hint on miss. Canonical implementations: `packages/remnic-cli/src/optional-bench.ts`, `packages/remnic-cli/src/optional-weclone-export.ts`, `packages/remnic-core/src/cli.ts:ensureBuiltInBulkImportAdapters`.
- **Declare as optional peer deps.** In the consuming package's `package.json`, list optional companions under `peerDependencies` and mark each as optional via `peerDependenciesMeta.<name>.optional = true`. Do not list them under `dependencies`.
- **Never add to `noExternal`.** In tsup configs, optional packages must be `external` (or simply omitted from `noExternal`). Adding them to `noExternal` bundles them into the base install and breaks à-la-carte.
- **Publish everything.** Any package that end users are expected to install (even as an extension) must be published to npm. If it's `"private": true` and you recommend it, that's a bug — ship it or remove the recommendation. The publish order in `.github/workflows/release-and-publish.yml` is the source of truth; keep it topologically sorted.

When you touch any of these files — tsup configs, CLI/plugin package.json `dependencies`, or dynamic-import loaders — re-verify the contract end to end: does `npm install @remnic/cli` still work without the optional packages present? Does the CLI throw a clean install hint instead of a `MODULE_NOT_FOUND`?

## Cleaner PR Workflow

Default workflow going forward:

1. Keep each PR narrow.
   - Prefer one subsystem group per PR.
   - Split mixed work into separate PRs for schema/surface, storage/cache, and retrieval/planner behavior when possible.

2. Sync `main` before review.
   - Rebase or merge `main` before the first serious AI review cycle.
   - Avoid mid-review base refreshes unless a conflict forces it.

3. Batch fixes.
   - Group unresolved comments by subsystem, fix the full group, verify once, then push once.
   - Do not use review feedback as a micro-push loop.

4. Run local review gates first.
   - `npm run preflight:quick`
   - `npm run test:entity-hardening` when touching `src/` or `packages/remnic-core/src/` `orchestrator.ts`, `storage.ts`, `intent.ts`, `memory-cache.ts`, `entity-retrieval.ts`, or `config.ts`
   - `npm run review:cursor` when the local Cursor CLI is available

5. Treat AI review freshness as a merge criterion.
   - A stale positive verdict on an older head does not count.
   - Merge-ready means green checks, zero unresolved review threads, and a fresh positive AI verdict on the current head.

6. Run pre-merge check before every merge.
   - `scripts/pre-merge-check.sh <PR#>` — blocks if reviewers haven't posted or threads are unresolved.
   - Wait at least 3 minutes after PR creation before attempting to merge.
   - Never merge a PR in the same tool call that created it.

Reference:
`docs/ops/pr-review-hardening-playbook.md`

## Why Review Churn Happens

When a PR touches session identity, retrieval routing, compaction, cache, or
other lifecycle-heavy behavior, repeated review rounds usually mean the change
was fixed too locally instead of being hardened as a whole subsystem.

The common failure mode:

1. A fix is made for the reported bug only.
2. A reviewer then exercises an adjacent path:
   - sparse metadata
   - remembered binding reuse
   - provider rebinding
   - restart recovery
   - `before_reset`
   - `session_end`
   - compaction
3. Another follow-up commit is required.

Required prevention workflow:

1. Build the scenario matrix before coding.
2. Define the invariants for every entrypoint the subsystem owns.
3. Add tests for the entire failure class, not only the reported example.
4. Apply one cohesive subsystem patch.
5. Run the hardening gate before requesting AI review again.

If the work is stateful and you are responding one review comment at a time,
stop and widen the fix before pushing.

## Agent Notes: Retrieval Explain Surface (issues #518, #570)

Two adjacent surfaces with similar names — both shipped on main. Do not
conflate them:

1. **`recall/explain`** (graph-path, shipped) — `POST
   /engram/v1/recall/explain` / `engram.recall_explain` MCP tool /
   `EngramAccessService.recallExplain()`. Returns a graph-path
   explanation *document* ("why these memories?" for the graph
   subsystem). Markdown formatting delegates to the shared
   `recall-explain-renderer.ts` so CLI / HTTP / MCP stay in sync.

2. **Recall xray / tier explain** (#570, shipped) — `GET
   /engram/v1/recall/xray` / `engram.recall_xray` MCP tool / `remnic
   xray` CLI / `EngramAccessService.recallXray()`. Returns a
   *structured per-result annotation* of which retrieval tier served
   the query (`direct-answer`, `hybrid`, etc.). Attached to
   `LastRecallSnapshot.tierExplain` only when
   `recallDirectAnswerEnabled: true`.

On-disk modules (all shipped):

- `packages/remnic-core/src/direct-answer.ts` — pure eligibility
  function over caller-resolved `DirectAnswerCandidate`s.
- `packages/remnic-core/src/direct-answer-wiring.ts` — source-agnostic
  `tryDirectAnswer(...)` binding invoked by the orchestrator.
- `packages/remnic-core/src/recall-xray.ts`,
  `recall-xray-renderer.ts`, `recall-xray-cli.ts` — tier-explain core,
  shared renderer, and CLI surface.
- `packages/remnic-core/src/recall-explain-renderer.ts` — shared
  markdown renderer for the legacy graph-path `/recall/explain`
  surface.
- `packages/remnic-core/src/types.ts` — `RecallTierExplain` interface,
  attached to `LastRecallSnapshot` via `recall-state.ts`.

Rule 22 applies: never fork formatting — extend the renderers. If a
shared `abort-error.ts` module is later introduced, migrate the
private `throwIfAborted(signal)` helper in `direct-answer-wiring.ts`
rather than re-implementing it per call site.
