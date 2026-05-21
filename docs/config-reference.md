# Config Reference

All settings live in `openclaw.json` under `plugins.entries.openclaw-engram.config`.

Use `openclaw engram config-review` for opinionated tuning recommendations and `openclaw engram doctor` for runtime or configuration problems. The narrative sections below explain the major feature groups; the schema-complete appendix at the bottom is the authoritative default-and-recommended matrix for every shipped config key.

## Core

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback in plugin mode)` | Optional OpenAI API key, `${ENV_VAR}` reference, or `false` to disable direct OpenAI entirely. When `modelSource` is `gateway`, Remnic does not inherit `OPENAI_API_KEY`; gateway provider auth is used instead. |
| `openaiBaseUrl` | `(env fallback)` | Override OpenAI API base URL (e.g. for proxies or compatible endpoints); falls back to `OPENAI_BASE_URL` env var |
| `model` | `gpt-5.5` | OpenAI model for extraction and consolidation |
| `reasoningEffort` | `low` | `none`, `low`, `medium`, `high` |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage root |
| `workspaceDir` | `~/.openclaw/workspace` | Workspace root (IDENTITY.md location) |
| `captureMode` | `implicit` | Memory write policy: `implicit`, `explicit`, or `hybrid` |
| `debug` | `false` | Enable debug logging |

OpenClaw installs default new Remnic entries to `modelSource: "gateway"` so LLM calls use the gateway agent model chain instead of requiring a Remnic-specific OpenAI API key.

`captureMode` behavior:

- `implicit`: normal extraction/write behavior.
- `explicit`: normal conversation turns never create memories; only structured explicit capture writes or queues review items.
- `hybrid`: explicit capture writes immediately, while the normal extraction pipeline remains available.

## Memory OS Presets

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryOsPreset` | `(unset)` | Optional advanced preset: `conservative`, `balanced`, `research-max`, or `local-llm-heavy`. Preset values seed the advanced config surface before explicit per-setting overrides are applied. |

Preset intent:

- `conservative` keeps recall budgets lower and leaves experimental learning/graph features off.
- `balanced` enables the recommended indexing, artifact, and rerank defaults without turning on the higher-churn learning loops.
- `research-max` enables the broadest shipped experimental surface, including graph recall and adaptive policy loops.
- `local-llm-heavy` biases extraction/rerank/tooling toward local OpenAI-compatible endpoints and the fast local tier.

Backward compatibility note:

- `memoryOsPreset: "research"` is accepted as an alias for `research-max`, but new configs should use `research-max`.

## Access Layer

| Setting | Default | Description |
|---------|---------|-------------|
| `agentAccessHttp.enabled` | `false` | Start a local authenticated Remnic HTTP API during plugin startup |
| `agentAccessHttp.host` | `127.0.0.1` | Loopback bind host for the Remnic HTTP API |
| `agentAccessHttp.port` | `4318` | Bind port for the Remnic HTTP API (`0` = ephemeral port) |
| `agentAccessHttp.authToken` | `OPENCLAW_REMNIC_ACCESS_TOKEN` / `OPENCLAW_ENGRAM_ACCESS_TOKEN` | Bearer token for the local HTTP API. Accepts a literal string (with `${ENV_VAR}` expansion) or — under OpenClaw — a SecretRef object such as `{"source":"exec","provider":"kc_openclaw_remnic_token","id":"value"}` resolved at startup via the gateway secret resolver (issue #757). Standalone Remnic accepts strings only. |
| `agentAccessHttp.maxBodyBytes` | `131072` | Maximum accepted JSON request body size |

When `agentAccessHttp.enabled` is on (or `openclaw engram access http-serve` is running), the same loopback server also serves the browser-based admin console shell at `/engram/ui/`. The shell is static, ships with packaged plugin builds, and still requires the configured bearer token over `/engram/v1/...` for memory data and operator actions.

Access-layer safety notes:

- HTTP startup fails closed when no bearer token is configured.
- Request bodies are capped by `agentAccessHttp.maxBodyBytes`.
- Explicit write routes are rate-limited and support `schemaVersion`, `idempotencyKey`, and `dryRun` envelopes.
- The stdio MCP server (`openclaw engram access mcp-serve`) uses the same internal access service as HTTP, so recall/read/write behavior stays aligned across both transports.
- MCP is intentionally zero-config on the Engram side: launch `openclaw engram access mcp-serve` from the client and it will use the same local memory directory, namespace rules, and explicit-capture policy as the in-process plugin runtime.

## Buffer & Triggers

| Setting | Default | Description |
|---------|---------|-------------|
| `triggerMode` | `smart` | `smart`, `every_n`, or `time_based` |
| `bufferMaxTurns` | `5` | Max buffered turns before forced extraction |
| `bufferMaxMinutes` | `15` | Max minutes before forced extraction |
| `highSignalPatterns` | `[]` | Additional regex patterns for immediate extraction |
| `consolidateEveryN` | `3` | Run consolidation every N extractions |

## Extraction Guardrails

| Setting | Default | Description |
|---------|---------|-------------|
| `extractionDedupeEnabled` | `true` | Skip extraction if the same buffer was already extracted recently |
| `extractionDedupeWindowMs` | `300000` | Dedup window in milliseconds (default 5 minutes) |
| `extractionMinChars` | `40` | Minimum buffer character count to trigger extraction |
| `extractionMinUserTurns` | `1` | Minimum user turns in buffer before extraction |
| `extractionMaxTurnChars` | `4000` | Truncate each turn to this many chars before sending to LLM |
| `extractionMaxFactsPerRun` | `12` | Cap on facts extracted per LLM call |
| `extractionMaxEntitiesPerRun` | `6` | Cap on entities extracted per LLM call |
| `extractionMaxQuestionsPerRun` | `3` | Cap on curiosity questions generated per LLM call |
| `extractionMaxProfileUpdatesPerRun` | `4` | Cap on profile update statements per LLM call |
| `beforeResetTimeoutMs` | `2000` | Max time (ms, clamped to `[100, 30000]`) to wait for a reset-triggered flush before returning control to the host. Operators running a local LLM for extraction often want this higher — a 7B model on CPU can take 2–5s per extraction, and the default can abort the queued follow-up flush before it completes. See issue #549 for the error-vs-debug log-level behavior around these aborts. |

## Search Backend (v9.0)

| Setting | Default | Description |
|---------|---------|-------------|
| `searchBackend` | `"qmd"` | Search engine to use: `"qmd"`, `"orama"`, `"lancedb"`, `"meilisearch"`, `"remote"`, `"noop"` |
| `lanceDbPath` | `{memoryDir}/lancedb` | LanceDB database directory |
| `lanceEmbeddingDimension` | `1536` | Vector dimension for LanceDB |
| `meilisearchHost` | `http://localhost:7700` | Meilisearch server URL |
| `meilisearchApiKey` | `(none)` | Meilisearch API key |
| `meilisearchTimeoutMs` | `30000` | Meilisearch request timeout |
| `meilisearchAutoIndex` | `false` | Auto-push documents to Meilisearch on update |
| `oramaDbPath` | `{memoryDir}/orama` | Orama database directory |
| `oramaEmbeddingDimension` | `1536` | Vector dimension for Orama |
| `remoteSearchBaseUrl` | `http://localhost:8181` | Remote search service URL |
| `remoteSearchApiKey` | `(none)` | Remote search API key |
| `remoteSearchTimeoutMs` | `30000` | Remote search request timeout |

See [Search Backends](search-backends.md) for detailed configuration and comparison.

## Retrieval & Recall Budget

| Setting | Default | Description |
|---------|---------|-------------|
| `recallBudgetChars` | `maxMemoryTokens * 4` | **Total character budget for assembled recall context.** Controls how much memory context is injected into agent prompts. If unset, falls back to `maxMemoryTokens * 4`. See [Recall Budget Tuning](#recall-budget-tuning) below. |
| `maxMemoryTokens` | `2000` | Legacy token cap. Only used to compute `recallBudgetChars` when that setting is absent. **Prefer setting `recallBudgetChars` directly.** |
| `qmdEnabled` | `true` | Use QMD for hybrid search |
| `qmdCollection` | `openclaw-engram` | QMD collection name |
| `qmdMaxResults` | `8` | Final result cap after over-scanning and ranking (fetch size may be larger) |
| `qmdColdTierEnabled` | `false` | Query a secondary cold QMD collection before archive fallback when hot recall misses |
| `qmdColdCollection` | `openclaw-engram-cold` | QMD collection name used for cold-tier recall |
| `qmdColdMaxResults` | `8` | Final result cap for cold-tier recall before merging into the normal ranking pipeline |
| `qmdPath` | `(auto)` | Absolute path to `qmd` binary (bypasses PATH) |
| `qmdSupportedVersion` | `2.5.1` | Highest QMD version this Remnic build will auto-install |
| `qmdAutoUpgradeEnabled` | `false` | Opt-in auto-upgrade for PATH/fallback QMD installs; explicit `qmdPath` is never overwritten |
| `qmdAutoUpgradeCheckIntervalMs` | `86400000` | Minimum interval between auto-upgrade attempts |
| `qmdChunkStrategy` | `auto` | QMD chunk strategy to forward when the installed QMD supports it (`auto` or `regex`) |
| `qmdCandidateLimit` | `(none)` | Optional QMD candidate limit forwarded to supported QMD query paths |
| `qmdQueryRerankEnabled` | `true` | Set `false` to ask QMD to skip its built-in rerank step when supported |
| `qmdIndexName` | `(none)` | Optional QMD named index forwarded as `qmd --index <name> ...` when QMD 2.5+ supports named index selection. Leave unset during upgrades unless existing QMD data is already in that named index; QMD's default data lives in `~/.cache/qmd/index.sqlite`, and changing this can point Remnic at an empty DB. |
| `qmdForceCpu` | `false` | Set `QMD_FORCE_CPU=1` for QMD child processes to bypass GPU probing |
| `qmdGpuBackend` | `(none)` | Optional `QMD_LLAMA_GPU` override (`auto`, `metal`, `cuda`, `vulkan`, or `false`) |
| `qmdEmbedParallelism` | `(none)` | Optional `QMD_EMBED_PARALLELISM` override, clamped to 1-8 |
| `qmdEmbedModel` | `(none)` | Optional `QMD_EMBED_MODEL` override used by QMD indexing and vector search |
| `qmdRerankModel` | `(none)` | Optional `QMD_RERANK_MODEL` override used by QMD reranking |
| `qmdGenerateModel` | `(none)` | Optional `QMD_GENERATE_MODEL` override used by QMD query expansion |
| `qmdDaemonEnabled` | `true` | Prefer QMD MCP daemon for recall/search when available (lower contention); fail-open to subprocess search/hybrid paths |
| `qmdDaemonUrl` | `http://localhost:8181/mcp` | Legacy compatibility setting; current runtime uses shared stdio `qmd mcp` rather than the HTTP endpoint directly |
| `qmdDaemonRecheckIntervalMs` | `60000` | Interval to re-probe daemon availability after failure |
| `qmdIntentHintsEnabled` | `false` | Forward inferred recall intent into QMD unified search when supported |
| `qmdExplainEnabled` | `false` | Capture QMD explain traces in `state/last_qmd_recall.json` and `memory_qmd_debug` |
| `embeddingFallbackEnabled` | `true` | Use embedding search when QMD is unavailable |
| `embeddingFallbackProvider` | `auto` | `auto`, `openai`, or `local` — selects embedding API for fallback |
| `recordEmptyRecallImpressions` | `false` | If `true`, write recall impression rows with empty `memoryIds` when no memory context is injected |
| `knowledgeIndexEnabled` | `true` | Inject entity/topic index into recall context |
| `knowledgeIndexMaxEntities` | `40` | Max entities included in the knowledge index |
| `knowledgeIndexMaxChars` | `4000` | Max characters of knowledge index injected |
| `entityRetrievalEnabled` | `true` | Enable entity-oriented recall hints for `who is`, `what do we know about`, and transcript-backed recent-turn pronoun follow-ups within the active recall namespace |
| `entityRetrievalMaxChars` | `2400` | Max characters injected by the entity retrieval section |
| `entityRetrievalMaxHints` | `2` | Max entity targets summarized in a single recall pass |
| `entityRetrievalMaxSupportingFacts` | `6` | Max direct-answer supporting facts/timeline snippets considered per target |
| `entityRetrievalMaxRelatedEntities` | `3` | Max related entities listed per target when confidence is high |
| `entityRetrievalRecentTurns` | `6` | Number of recent transcript turns scanned for pronoun carry-forward and short follow-up resolution |
| `entityRelationshipsEnabled` | `true` | Persist entity-relationship edges that power direct-answer recall summaries |
| `entityActivityLogEnabled` | `true` | Keep per-entity recent-activity snippets for answer synthesis |
| `entityActivityLogMaxEntries` | `20` | Max recent activity entries retained per entity |
| `entityAliasesEnabled` | `true` | Track normalized aliases for entity resolution and merge safety |
| `entitySummaryEnabled` | `true` | Maintain synthesized entity summaries used by retrieval and tooling |
| `recallBudgetChars` | `maxMemoryTokens * 4` | Hard cap for total assembled recall context (final safety trim before system prompt injection) |
| `recallPipeline` | `(built-in ordered defaults)` | Ordered section controls for recall assembly, including per-section caps and knobs |
| `recallDirectAnswerEnabled` | `false` | Enable the direct-answer retrieval tier (issue #518). The current release ships only the pure eligibility function and these config keys — the orchestrator wiring, tier-explain surfaces, and a dedicated bench fixture are not yet in-tree, so setting this to `true` is a no-op at recall time until a subsequent slice lands. See [Retrieval Explain](./retrieval-explain.md). |
| `recallDirectAnswerTokenOverlapFloor` | `0.55` | Minimum query↔memory token-overlap ratio required for direct-answer eligibility. Set to `0` to disable the gate. |
| `recallDirectAnswerImportanceFloor` | `0.7` | Minimum calibrated importance score required for direct-answer eligibility. Set to `0` to disable the gate. `verificationState: "user_confirmed"` bypasses this check. |
| `recallDirectAnswerAmbiguityMargin` | `0.15` | If the second-best candidate scores within this ratio of the top, direct-answer defers to the hybrid tier. |
| `recallDirectAnswerEligibleTaxonomyBuckets` | `["decisions","principles","conventions","runbooks","entities"]` | Taxonomy category IDs eligible for direct-answer routing. Set to `[]` to disable the gate without unsetting `enabled`. |

### `recallPipeline` entries

`recallPipeline` is an array of section entries:

```json
{
  "id": "knowledge-index",
  "enabled": true,
  "maxChars": 3000,
  "maxEntities": 25
}
```

Supported keys:

| Key | Type | Notes |
|-----|------|-------|
| `id` | `string` | Section identifier (required) |
| `enabled` | `boolean` | Enable/disable the section |
| `maxChars` | `number \| null` | Per-section char cap (`null` = uncapped by section) |
| `maxHints` | `number` | `entity-retrieval` section only; max resolved entity targets |
| `maxSupportingFacts` | `number` | `entity-retrieval` section only; direct-answer evidence budget per target |
| `maxRelatedEntities` | `number` | `entity-retrieval` section only; related-entity cap per target |
| `consolidateTriggerLines` | `number` | `profile` section only; profile consolidation trigger line count |
| `consolidateTargetLines` | `number` | `profile` section only; consolidation target line count |
| `maxEntities` | `number` | `knowledge-index` section only; per-section entity cap |
| `maxResults` | `number` | `memories` section only; cap injected memory result count |
| `recentTurns` | `number` | `entity-retrieval` section only; transcript follow-up window |
| `maxTurns` | `number` | `transcript` section only |
| `maxTokens` | `number` | `transcript` section only |
| `lookbackHours` | `number` | `transcript` / `summaries` section only |
| `maxCount` | `number` | `summaries` section only |
| `topK` | `number` | `conversation-recall` section only |
| `timeoutMs` | `number` | `conversation-recall` section only |
| `maxPatterns` | `number` | `compounding` section only |

### Recall Budget Tuning

The recall budget controls how much context Engram injects into each agent prompt. Getting this right is critical — too small and memories are silently truncated; too large and you waste context window space.

**How it works (v9.0.66+):** Engram assembles recall context in pipeline section order (shared-context → profile → entity retrieval → knowledge index → ... → memories → transcripts → summaries). The budget-aware assembler reserves space for the `memories` section so earlier sections cannot fully exhaust the budget. However, the reservation is minimal (heading-sized). If the total budget is too small, earlier sections still crowd out memory content.

**Common pitfall:** The default budget is `maxMemoryTokens * 4` = **8,000 chars**. A typical profile is 4,000–8,000 chars and shared context adds another 4,000–6,000 chars. With these defaults, the `memories` section is still included (it is a protected section), but may be truncated to heading-only (~24 chars) with no actual memory content. The `lastRecall` state file will show successful memory retrieval (non-empty `memoryIds`) but the agent sees only the section heading because the content was truncated during context assembly.

**Recommended values:**

| Model context window | Suggested `recallBudgetChars` | Reasoning |
|---------------------|-------------------------------|-----------|
| 8K–16K tokens | `16000` | Tight budget; consider capping profile via `recallPipeline` |
| 32K–128K tokens | `32000`–`64000` | Room for all sections including memories |
| 200K+ tokens (Claude Opus/Sonnet, GPT-5) | `64000`–`128000` | Generous budget; 16K–32K tokens is a small fraction of context |

**Example config for large-context models:**

```jsonc
{
  "recallBudgetChars": 64000
}
```

**Diagnosing budget exhaustion:** Check `~/.openclaw/workspace/memory/local/state/last_recall.json`. Each session entry records `includedSections`, `finalContextChars`, and `memoryIds`. Because memories is a protected section, it is always included — but under tight budgets it may be truncated to heading-only. If `memoryIds` is non-empty but `finalContextChars` is close to the budget and the memories section content is missing or minimal, the budget was too small and memories were retrieved but truncated during assembly.

**Capping individual sections:** You can override the `recallPipeline` to add `maxChars` to any section:

```jsonc
{
  "recallPipeline": [
    { "id": "shared-context", "enabled": true, "maxChars": 4000 },
    { "id": "profile", "enabled": true, "maxChars": 4000 },
    { "id": "entity-retrieval", "enabled": true, "maxChars": 2400 },
    { "id": "knowledge-index", "enabled": true, "maxChars": 4000 },
    { "id": "memories", "enabled": true }
  ]
}
```

Note: `recallPipeline` controls ordering and can explicitly disable sections via `"enabled": false`. Unlisted sections default to enabled and are appended after the listed entries. To exclude a section, include it with `"enabled": false` rather than omitting it.

## Coding Mode

| Setting | Default | Description |
|---------|---------|-------------|
| `codingMode.projectScope` | `true` | Auto-scope memory to the git project (stable origin-URL hash). Set to `false` to disable project-based namespace isolation. |
| `codingMode.branchScope` | `false` | Additionally overlay the current branch on top of the project namespace. Project-level reads remain visible through `readFallbacks`. |
| `codingMode.globalFallback` | `true` | Include the root/global namespace in recall read-fallbacks for project-scoped sessions. Global facts (framework bugs, library behavior, user preferences) surface across all projects. Set to `false` for strict project isolation. |
| `extractionScopeClassificationEnabled` | `true` | Classify extracted facts as `"global"` or `"project"` scope. Global facts are promoted to the shared root namespace so they are visible across all projects. |

See [Coding agent mode](coding-agent.md) for full details on project detection, `cwd` auto-resolution, `projectTag` for non-git sessions, and cross-project knowledge sharing.

## Native Knowledge

| Setting | Default | Description |
|---------|---------|-------------|
| `nativeKnowledge.enabled` | `false` | Enable curated-file and adapter-backed native knowledge recall. |
| `nativeKnowledge.includeFiles` | `["IDENTITY.md","MEMORY.md"]` | Workspace-relative markdown files to chunk into the native knowledge recall section and track incrementally in backend-agnostic sync state. |
| `nativeKnowledge.maxChunkChars` | `900` | Maximum chunk size before heading/paragraph-aware splitting. |
| `nativeKnowledge.maxResults` | `4` | Maximum native knowledge chunks injected into recall. |
| `nativeKnowledge.maxChars` | `2400` | Maximum total characters injected by the native knowledge section. |
| `nativeKnowledge.stateDir` | `state/native-knowledge` | `memoryDir`-relative directory used for backend-agnostic adapter sync state. |
| `nativeKnowledge.openclawWorkspace` | unset | Optional OpenClaw workspace adapter for bootstrap docs, handoffs, daily summaries, and automation notes. |
| `nativeKnowledge.obsidianVaults` | `[]` | Optional Obsidian vault adapters to sync into native knowledge recall. |

### `nativeKnowledge.openclawWorkspace`

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable the OpenClaw workspace artifact adapter. |
| `bootstrapFiles` | `["IDENTITY.md","MEMORY.md","USER.md"]` | Workspace-relative bootstrap docs treated as high-confidence native knowledge. |
| `handoffGlobs` | `["**/*handoff*.md","handoffs/**/*.md"]` | Workspace-relative globs used to discover handoff notes. |
| `dailySummaryGlobs` | `["**/*daily*summary*.md","summaries/**/*.md"]` | Workspace-relative globs used to discover daily summary notes. |
| `automationNoteGlobs` | `[]` | Optional workspace-relative globs for automation-written status or operating notes. |
| `workspaceDocGlobs` | `[]` | Optional workspace-relative globs for other explicitly allowlisted workspace docs. |
| `excludeGlobs` | `[]` | Additional excludes appended to the built-in safety exclusions (`.git/**`, `node_modules/**`, `dist/**`, `build/**`, `coverage/**`, `**/*.log`, `**/.env*`, `**/*.pem`, `**/*.key`). |
| `sharedSafeGlobs` | `[]` | Optional workspace-relative globs tagged as `shared_safe` when no explicit privacy class is present. |

### `nativeKnowledge.obsidianVaults` entries

Each vault entry supports:

| Key | Default | Description |
|-----|---------|-------------|
| `id` | `vault-{n}` | Stable adapter identifier used in synced metadata and recall formatting. |
| `rootDir` | required | Absolute path to the Obsidian vault root. |
| `includeGlobs` | `["**/*.md"]` | Vault-relative globs eligible for sync. |
| `excludeGlobs` | `[".obsidian/**","**/*.canvas","**/*.png","**/*.jpg","**/*.jpeg","**/*.gif","**/*.pdf"]` | Vault-relative globs excluded from sync. |
| `namespace` | unset | Default namespace assigned to synced notes from this vault. |
| `privacyClass` | unset | Operator-defined privacy classification preserved on synced note chunks. |
| `folderRules` | `[]` | Optional per-folder overrides for namespace and privacy class. Longest matching prefix wins. |
| `dailyNotePatterns` | `["YYYY-MM-DD"]` | Filename patterns used to derive a note date from the vault-relative path. |
| `materializeBacklinks` | `false` | When enabled, compute backlinks from wikilink targets and expose them in recall metadata. |

Example:

```jsonc
{
  "nativeKnowledge": {
    "enabled": true,
    "includeFiles": ["IDENTITY.md", "MEMORY.md", "TEAM.md"],
    "openclawWorkspace": {
      "enabled": true,
      "bootstrapFiles": ["IDENTITY.md", "MEMORY.md", "USER.md"],
      "handoffGlobs": ["handoffs/**/*.md"],
      "dailySummaryGlobs": ["summaries/**/*.md"],
      "automationNoteGlobs": ["automation/**/*.md"],
      "sharedSafeGlobs": ["automation/shared/**/*.md"]
    },
    "obsidianVaults": [
      {
        "id": "personal",
        "rootDir": "/Users/you/Documents/Obsidian",
        "namespace": "shared",
        "privacyClass": "private",
        "folderRules": [
          { "pathPrefix": "Projects", "namespace": "work", "privacyClass": "team" }
        ],
        "dailyNotePatterns": ["Daily/YYYY-MM-DD", "YYYY-MM-DD"],
        "materializeBacklinks": true
      }
    ]
  }
}
```

Direct `includeFiles` sync plus the OpenClaw workspace adapter both persist incremental sync state and tombstones under `nativeKnowledge.stateDir`, preserve source metadata on each chunk when derivable, and dedupe exact overlaps so enabling the adapter does not double-inject bootstrap docs.

## v8.0 Memory OS

| Setting | Default | Description |
|---------|---------|-------------|
| `recallPlannerEnabled` | `true` | Lightweight retrieve-vs-think gating |
| `recallPlannerMaxQmdResultsMinimal` | `4` | QMD cap in `minimal` recall mode |
| `memoryBoxesEnabled` | `false` | Enable Memory Box topic-windowed grouping |
| `traceWeaverEnabled` | `false` | Link recurring-topic boxes into named traces |
| `boxTimeGapMs` | `1800000` | Milliseconds of inactivity that seal an open box (default 30 min) |
| `boxTopicShiftThreshold` | `0.35` | Topic overlap below this seals the box |
| `boxMaxMemories` | `50` | Max memories before forced seal |
| `traceWeaverLookbackDays` | `7` | Days to look back for matching traces |
| `traceWeaverOverlapThreshold` | `0.4` | Minimum topic overlap to join an existing trace |
| `boxRecallDays` | `3` | Days of boxes to inject into recall context |
| `episodeNoteModeEnabled` | `false` | Classify memories as `episode` or `note` |
| `verbatimArtifactsEnabled` | `false` | Store high-confidence memories as verbatim anchors |
| `verbatimArtifactsMinConfidence` | `0.8` | Minimum confidence for artifact writes |
| `verbatimArtifactsMaxRecall` | `5` | Max artifact anchors injected per recall |
| `verbatimArtifactCategories` | `["decision","correction","principle","commitment"]` | Eligible categories |
| `intentRoutingEnabled` | `false` | Write intent metadata; boost compatible recalls |
| `intentRoutingBoost` | `0.12` | Max additive score boost from intent compatibility |

## v8.1 Temporal + Tag Indexes

| Setting | Default | Description |
|---------|---------|-------------|
| `queryAwareIndexingEnabled` | `false` | Build and maintain temporal (`state/index_time.json`) and tag (`state/index_tags.json`) indexes after each extraction. Enables score boosts for temporal queries and `#tag` tokens at recall time. |
| `queryAwareIndexingMaxCandidates` | `200` | Max candidate paths from the index prefilter (0 = no cap). |

## v8.3 Lifecycle Policy Engine

| Setting | Default | Description |
|---------|---------|-------------|
| `lifecyclePolicyEnabled` | `false` | Enable lifecycle scoring + transitions + retrieval weighting. |
| `lifecycleFilterStaleEnabled` | `false` | Filter lifecycle `stale`/`archived` candidates from retrieval before final cap (only when policy is enabled). |
| `lifecyclePromoteHeatThreshold` | `0.55` | Heat threshold for promotion toward `validated`/`active`. |
| `lifecycleStaleDecayThreshold` | `0.65` | Decay threshold to move a memory to `stale`. |
| `lifecycleArchiveDecayThreshold` | `0.85` | Decay threshold to move a memory to `archived` (non-protected categories). |
| `lifecycleProtectedCategories` | `["decision","principle","commitment","preference","procedure"]` | Categories protected from automatic archive transition (includes `procedure` when procedural memories exist). |
| `lifecycleMetricsEnabled` | `false` (auto-`true` when policy enabled unless explicitly set) | Emit lifecycle metrics snapshot at `state/lifecycle-metrics.json`. |

## v8.3 Proactive + Policy Learning Foundation

| Setting | Default | Description |
|---------|---------|-------------|
| `proactiveExtractionEnabled` | `false` | Enable proactive extraction second-pass paths (feature-gated). |
| `contextCompressionActionsEnabled` | `false` | Enable context compression action tool paths and action telemetry wiring. |
| `compressionGuidelineLearningEnabled` | `false` | Enable adaptive compression guideline learning loop. |
| `maxProactiveQuestionsPerExtraction` | `2` | Hard cap on proactive self-questions per extraction (`0` disables). |
| `proactiveExtractionTimeoutMs` | `2500` | Hard timeout for proactive question generation plus bounded answer synthesis (`0` disables the second pass). |
| `proactiveExtractionMaxTokens` | `900` | Token budget applied to each proactive extraction sub-call (`0` disables the second pass). |
| `proactiveExtractionCategoryAllowlist` | unset | Optional category allowlist for proactive second-pass writes; when set, lower-confidence or off-category proactive facts are dropped before persistence. |
| `maxCompressionTokensPerHour` | `1500` | Hourly token budget for compression-learning workflows (`0` disables). |

### v8.3 Tool + State Artifacts

- `context_checkpoint` tool:
  - gated by `contextCompressionActionsEnabled`
  - records append-only telemetry in `state/memory-actions.jsonl`
- `memory_action_apply` tool:
  - gated by `contextCompressionActionsEnabled`
  - records append-only action + outcome telemetry in `state/memory-actions.jsonl`
- `compressionGuidelineLearningEnabled`:
  - consolidation synthesizes/updates `state/compression-guidelines.md`
  - optimizer metadata/version state persists to `state/compression-guideline-state.json`
  - synthesis is fail-open and never blocks consolidation
- `proactiveExtractionTimeoutMs` / `proactiveExtractionMaxTokens`:
  - bound both proactive self-question generation and the same-buffer answer-synthesis pass
  - `0` remains a hard disable for the proactive second pass
- `proactiveExtractionCategoryAllowlist`:
  - filters proactive second-pass facts before persistence so only allowlisted categories are emitted
  - does not affect the base extraction pass

### v8.13 Action-Policy Rollout Presets

Use these as operator presets for progressive rollout. All are baseline-safe when disabled.

`conservative`:

```jsonc
{
  "contextCompressionActionsEnabled": false,
  "proactiveExtractionEnabled": false,
  "compressionGuidelineLearningEnabled": false,
  "compressionGuidelineSemanticRefinementEnabled": false,
  "proactiveExtractionTimeoutMs": 2500,
  "proactiveExtractionMaxTokens": 900,
  "maxCompressionTokensPerHour": 0
}
```

`balanced`:

```jsonc
{
  "contextCompressionActionsEnabled": true,
  "proactiveExtractionEnabled": true,
  "compressionGuidelineLearningEnabled": true,
  "compressionGuidelineSemanticRefinementEnabled": false,
  "proactiveExtractionTimeoutMs": 2500,
  "proactiveExtractionMaxTokens": 900,
  "maxCompressionTokensPerHour": 1500
}
```

`research-max`:

```jsonc
{
  "contextCompressionActionsEnabled": true,
  "proactiveExtractionEnabled": true,
  "compressionGuidelineLearningEnabled": true,
  "compressionGuidelineSemanticRefinementEnabled": true,
  "compressionGuidelineSemanticTimeoutMs": 2500,
  "proactiveExtractionTimeoutMs": 2500,
  "proactiveExtractionMaxTokens": 900,
  "maxCompressionTokensPerHour": 3000
}
```

Disabled-path compatibility guarantees:
- `contextCompressionActionsEnabled=false` keeps action tooling and action-policy telemetry inactive.
- `proactiveExtractionTimeoutMs=0` or `proactiveExtractionMaxTokens=0` keeps the proactive second pass fully disabled.
- `maxCompressionTokensPerHour=0` remains a hard disable (no implicit non-zero coercion).
- `compressionGuidelineLearningEnabled=false` keeps consolidation behavior baseline-equivalent.

## Budget Mapping Notes

The original v8 roadmap listed several operator knobs that are now split across the live config surface.

| Roadmap knob | Live config surface |
|--------------|---------------------|
| `maxRecallTokens` | `maxMemoryTokens` for token budget, plus `recallBudgetChars` for final assembled-context trimming. |
| `maxRecallMs` | No single global wall-clock cap. Use stage-specific limits such as `recallPlannerTimeoutMs`, `conversationRecallTimeoutMs`, and `rerankTimeoutMs`. |
| `maxCompressionTokensPerHour` | `maxCompressionTokensPerHour` |
| `maxGraphTraversalSteps` | `maxGraphTraversalSteps` |
| `maxArtifactsPerSession` | No dedicated per-session write cap. The nearest shipped controls are `verbatimArtifactsEnabled`, `verbatimArtifactsMaxRecall`, and `verbatimArtifactCategories`. |
| `maxProactiveQuestionsPerExtraction` | `maxProactiveQuestionsPerExtraction` |
| `maxProactiveExtractionMs` | `proactiveExtractionTimeoutMs` |
| `maxProactiveExtractionTokens` | `proactiveExtractionMaxTokens` |
| `indexRefreshBudgetMs` | Use refresh cadence + timeout controls such as `qmdUpdateMinIntervalMs`, `qmdUpdateTimeoutMs`, and `conversationIndexMinUpdateIntervalMs`. |

## v8.14 Hot/Cold Tier Parity + Migration

| Setting | Default | Description |
|---------|---------|-------------|
| `qmdTierMigrationEnabled` | `false` | Enable value-aware migration between hot and cold QMD tiers. |
| `qmdTierDemotionMinAgeDays` | `14` | Minimum age (days) before a hot memory can be considered for demotion. |
| `qmdTierDemotionValueThreshold` | `0.35` | Value threshold at/below which hot memories are eligible for cold demotion. |
| `qmdTierPromotionValueThreshold` | `0.7` | Value threshold at/above which cold memories are eligible for hot promotion. |
| `qmdTierParityGraphEnabled` | `true` | Keep graph-assist behavior parity between hot and cold retrieval paths. |
| `qmdTierParityHiMemEnabled` | `true` | Keep HiMem episode/note handling parity between hot and cold retrieval paths. |
| `qmdTierAutoBackfillEnabled` | `false` | Enable automated cold-tier parity backfill jobs. |

## Gateway Model Source

Route all Engram LLM calls through the OpenClaw gateway's agent model chain instead of Engram's own `openaiApiKey`/`localLlm*` configuration. This lets you define a single fallback chain per agent persona in `openclaw.json` and reuse the gateway's provider credentials.

| Setting | Default | Description |
|---------|---------|-------------|
| `modelSource` | `gateway` for new OpenClaw installs; `plugin` otherwise | `gateway` delegates to a gateway agent's model chain; `plugin` uses Engram's own openai/localLlm config |
| `gatewayAgentId` | `""` | Agent persona ID from `openclaw.json → agents.list[]` for primary LLM calls (extraction, consolidation, summarization). Falls back to `agents.defaults.model` if empty. |
| `fastGatewayAgentId` | `""` | Agent persona ID for fast-tier ops (rerank, entity summaries, compression guidelines). Uses `gatewayAgentId` chain when empty. |

When `modelSource` is `gateway`:

- `localLlmEnabled` and the direct OpenAI client are bypassed for primary LLM dispatch — all LLM calls flow through `FallbackLlmClient` with the configured agent chain
- Extraction and consolidation start on the configured gateway chain directly; the historical "falling back to gateway" wording only applies when Engram is still in `plugin` mode
- The existing `openaiApiKey`, `model`, and `localLlm*` settings are ignored for LLM dispatch but retained as config for backward compatibility; `OPENAI_API_KEY` is not inherited in gateway mode
- `localLlmFast*` settings are also bypassed when `fastGatewayAgentId` is set
- **Reranking** uses the `fastGatewayAgentId` chain (or `gatewayAgentId` if fast is unset) instead of the local LLM — this can dramatically reduce rerank latency when the fast chain points at a cloud provider

### Setup

1. **Define providers** in `agents/main/agent/models.json` with the endpoints and credentials you want Engram to use (e.g., `fireworks`, `zai`, `anthropic`, `lmstudio`).

2. **Create agent personas** in `openclaw.json → agents.list[]`:

```jsonc
{
  "id": "engram-llm",
  "default": false,
  "name": "Engram LLM Chain",
  "model": {
    "primary": "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
    "fallbacks": [
      "zai/glm-5",
      "anthropic/claude-sonnet-4-6",
      "lmstudio/qwen3.5-35b-a3b-mlx-lm"
    ]
  }
},
{
  "id": "engram-llm-fast",
  "default": false,
  "name": "Engram Fast LLM Chain",
  "model": {
    "primary": "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
    "fallbacks": [
      "zai/glm-5-turbo",
      "anthropic/claude-sonnet-4-6",
      "lmstudio/qwen3.5-35b-a3b-mlx-lm"
    ]
  }
}
```

Model strings use the format `provider/model-id` where `provider` matches a key in the `providers` object of your agent's `models.json`. Built-in OpenClaw providers (e.g., `openai-codex`, `google-vertex`, `github-copilot`) work automatically — they don't need explicit entries in `models.json` since the gateway materializes them from its plugin catalogs.

3. **Configure Engram** in `openclaw.json → plugins.entries.openclaw-engram.config`:

```jsonc
{
  "modelSource": "gateway",
  "gatewayAgentId": "engram-llm",
  "fastGatewayAgentId": "engram-llm-fast"
}
```

4. **Restart the gateway** for changes to take effect.

### How the fallback chain works

When a primary model call fails (timeout, HTTP error, empty response), `FallbackLlmClient` tries each fallback in order. The chain stops at the first successful response.

Provider lookup checks the explicit `models.providers` config first, then falls back to the gateway's materialized `models.json` (`~/.openclaw/agents/main/agent/models.json`), which contains all providers including built-in ones registered by gateway plugins (e.g., `openai-codex` with OAuth, `google-vertex`, `github-copilot`). This means any provider the gateway knows about — including OAuth-based providers — can be used in Engram's model chain without additional configuration.

### API key resolution

Provider auth is resolved using OpenClaw's native runtime. Engram first tries the gateway's `getRuntimeAuthForModel()` function, which handles all provider-specific transforms — OAuth token exchange (for `openai-codex`, `github-copilot`, etc.), base URL overrides, profile-based credentials, and secret reference formats — using the same codepath the gateway uses for its own agent sessions.

If the gateway runtime isn't available (e.g., running outside the gateway process), Engram falls back to `resolveProviderApiKey()` for secret ref resolution, then checks the `PROVIDER_NAME_API_KEY` environment variable before skipping the provider.

This means your existing auth setup works automatically — OAuth providers, API keys, 1Password, Vault, env vars, and plain-text keys all work without special Engram configuration.

### Switching back

Set `modelSource` to `plugin` (or remove it) to restore the original behavior where Engram uses its own `localLlm*` and `openaiApiKey` settings.

## Local LLM / OpenAI-Compatible Endpoint

| Setting | Default | Description |
|---------|---------|-------------|
| `localLlmEnabled` | `false` | Enable Engram's local/compatible endpoint when `modelSource` remains `plugin` |
| `localLlmUrl` | `http://localhost:1234/v1` | Base URL for endpoint |
| `localLlmModel` | `local-model` | Model ID |
| `localLlmApiKey` | `(unset)` | Optional API key |
| `localLlmHeaders` | `(unset)` | Extra HTTP headers |
| `localLlmAuthHeader` | `true` | Send `Authorization: Bearer` header when key set |
| `localLlmFallback` | `true` | Fall back to gateway model chain on failure |
| `localLlmTimeoutMs` | `180000` | Total timeout for primary local extraction/consolidation calls |
| `localLlmRetry5xxCount` | `1` | Retry count for transient 5xx responses from the local endpoint |
| `localLlmRetryBackoffMs` | `400` | Base backoff in milliseconds for local endpoint retries |
| `localLlm400TripThreshold` | `5` | Consecutive 4xx responses before the local endpoint is temporarily tripped |
| `localLlm400CooldownMs` | `120000` | Cooldown window before retrying a tripped local endpoint |
| `localLlmMaxContext` | `(unset)` | Override context window size |
| `localLlmFastEnabled` | `false` | Enable a separate fast local tier for short planner/rerank/helper calls |
| `localLlmFastModel` | `""` | Optional model id for the fast local tier |
| `localLlmFastUrl` | `http://localhost:1234/v1` | Optional dedicated base URL for the fast local tier |
| `localLlmFastTimeoutMs` | `15000` | Timeout for the fast local tier |
| `localLlmDisableThinking` | `true` | Suppress chain-of-thought / thinking mode on the main local LLM by sending `chat_template_kwargs: { enable_thinking: false }` (issue #548). Structured-output tasks like extraction and consolidation gain nothing from reasoning tokens; thinking-capable models (Qwen 3.5, Gemma 4, DeepSeek) commonly blow the 60s timeout before emitting content. Set to `false` to restore thinking for narrative tasks. The fast-tier client always disables thinking regardless of this flag. |
| `localLlmHomeDir` | `(unset)` | Optional home-dir override used when resolving local helper binaries |
| `localLmsCliPath` | `(auto)` | Path to `lms` CLI (LM Studio) |
| `localLmsBinDir` | `(auto)` | LM Studio binary directory |

## v2 Features

| Setting | Default | Description |
|---------|---------|-------------|
| `identityEnabled` | `true` | Enable agent identity reflections |
| `injectQuestions` | `false` | Inject open questions into system prompt |
| `commitmentDecayDays` | `90` | Days before fulfilled commitments are removed |

## v8.4 Identity Continuity

| Setting | Default | Description |
|---------|---------|-------------|
| `identityContinuityEnabled` | `false` | Enable identity continuity workflows (anchor/incidents/audits) |
| `identityInjectionMode` | `recovery_only` | Identity context injection mode: `recovery_only`, `minimal`, `full` |
| `identityMaxInjectChars` | `1200` | Maximum identity continuity characters injected into recall |
| `continuityIncidentLoggingEnabled` | `(follows identityContinuityEnabled when unset)` | Explicit override for continuity incident logging |
| `continuityAuditEnabled` | `false` | Enable continuity audit generation workflows |

## v8.5 Active Session Observer

| Setting | Default | Description |
|---------|---------|-------------|
| `sessionObserverEnabled` | `false` | Enable heartbeat observer checks for session growth-triggered extraction |
| `sessionObserverDebounceMs` | `120000` | Minimum milliseconds between observer-triggered extractions per session |
| `sessionObserverBands` | `[{maxBytes:50000,triggerDeltaBytes:4800,triggerDeltaTokens:1200}, {maxBytes:200000,triggerDeltaBytes:9600,triggerDeltaTokens:2400}, {maxBytes:1000000000,triggerDeltaBytes:19200,triggerDeltaTokens:4800}]` | Size-band thresholds used to trigger observer extraction when growth exceeds configured byte/token deltas |

### v8.5 Session Integrity + Recovery Ops

Session integrity diagnostics/repair are CLI-driven and intentionally config-light:
- `openclaw engram session-check`
- `openclaw engram session-repair --dry-run|--apply`

Safety contract:
- Repair defaults to dry-run.
- `--apply` only mutates Engram-managed transcript/checkpoint artifacts.
- OpenClaw session-file mutation requires explicit `--allow-session-file-repair` plus an explicit path and still does not perform automatic pointer rewiring.

### v8.8 Live Graph Dashboard

Dashboard is an optional, separate process and not part of gateway hot-path config.

CLI defaults:
- `openclaw engram dashboard start --host 127.0.0.1 --port 4319`
- `openclaw engram dashboard status`
- `openclaw engram dashboard stop`

Operational safety:
- Bind to localhost by default.
- Explicitly choose non-loopback bind only when network controls are in place.

## v8.7 Custom Memory Routing Rules

| Setting | Default | Description |
|---------|---------|-------------|
| `routingRulesEnabled` | `false` | Enable write-time routing-rule evaluation for extracted facts |
| `routingRulesStateFile` | `state/routing-rules.json` | Relative state file path for persisted route rules |

## v2.2 Advanced Retrieval

See [advanced-retrieval.md](advanced-retrieval.md) for guidance.

| Setting | Default | Description |
|---------|---------|-------------|
| `queryExpansionEnabled` | `false` | Heuristic query expansion (no LLM calls) |
| `queryExpansionMaxQueries` | `4` | Max expanded queries including original |
| `queryExpansionMinTokenLen` | `3` | Minimum token length for expansion |
| `rerankEnabled` | `false` | LLM reranking pass over QMD/embedding results |
| `rerankProvider` | `local` | `local` only in v2.2 |
| `rerankMaxCandidates` | `20` | Max candidates sent to reranker |
| `rerankTimeoutMs` | `8000` | Rerank timeout (ms) |
| `rerankCacheEnabled` | `true` | Cache reranks in-memory |
| `rerankCacheTtlMs` | `3600000` | Rerank cache TTL (ms) |
| `feedbackEnabled` | `false` | Enable `memory_feedback` tool and ranking bias |
| `negativeExamplesEnabled` | `false` | Track and penalize not-useful recalls |
| `recencyWeight` | `0.2` | Recency weight in retrieval ranking (0–1) |
| `boostAccessCount` | `true` | Boost frequently accessed memories in ranking |
| `slowLogEnabled` | `false` | Log slow operations |
| `slowLogThresholdMs` | `30000` | Threshold for slow log entries (ms) |

## v2.4 Context Retention

| Setting | Default | Description |
|---------|---------|-------------|
| `checkpointEnabled` | `true` | Save a working-context checkpoint after each turn for recovery |
| `checkpointTurns` | `15` | Number of recent turns included in checkpoint context |
| `transcriptEnabled` | `true` | Save conversation transcripts to disk |
| `transcriptRetentionDays` | `7` | Days to retain saved transcripts |
| `transcriptSkipChannelTypes` | `["cron"]` | Channel types whose transcripts are not saved |
| `transcriptRecallHours` | `12` | Hours of transcript history to include in recall context |
| `maxTranscriptTurns` | `50` | Max turns of transcript context to inject |
| `maxTranscriptTokens` | `1000` | Token budget cap for transcript recall formatting |
| `hourlySummariesEnabled` | `true` | Generate hourly summaries of conversation activity |
| `hourlySummaryCronAutoRegister` | `false` | Auto-register hourly summary cron job on gateway start |
| `hourlySummariesExtendedEnabled` | `false` | Structured topics/decisions in hourly summaries |
| `hourlySummariesIncludeToolStats` | `false` | Include tool usage stats in summaries |
| `conversationIndexEnabled` | `false` | Index transcript chunks for semantic recall |
| `conversationIndexBackend` | `qmd` | Conversation index backend (`qmd` for QMD collections, `faiss` for the bundled local sidecar) |
| `conversationIndexQmdCollection` | `openclaw-engram-conversations` | QMD collection for conversation index |
| `conversationIndexRetentionDays` | `30` | Days of transcript chunks retained in the semantic conversation index |
| `conversationIndexEmbedOnUpdate` | `false` | Run `qmd embed` on each conversation-index update instead of batching embed runs separately |
| `conversationIndexFaissScriptPath` | `(unset)` | Optional absolute path to FAISS sidecar script |
| `conversationIndexFaissPythonBin` | `(unset)` | Optional Python executable for FAISS sidecar |
| `conversationIndexFaissModelId` | `text-embedding-3-small` | Embedding model id passed to the FAISS sidecar |
| `conversationIndexFaissIndexDir` | `state/conversation-index/faiss` | Relative FAISS artifact directory under `memoryDir` (`index.faiss`, `metadata.jsonl`, `manifest.json`) |
| `conversationIndexFaissUpsertTimeoutMs` | `30000` | Timeout for FAISS upsert operations |
| `conversationIndexFaissSearchTimeoutMs` | `5000` | Timeout for FAISS search operations |
| `conversationIndexFaissHealthTimeoutMs` | `2000` | Timeout for FAISS health checks; degraded health is fail-open |
| `conversationIndexFaissMaxBatchSize` | `512` | Max chunk batch size sent per FAISS upsert |
| `conversationIndexFaissMaxSearchK` | `50` | Max top-K allowed for FAISS search |
| `conversationRecallTopK` | `3` | Top-K relevant transcript chunks to inject |
| `conversationRecallMaxChars` | `2500` | Max characters of conversation context to inject |
| `conversationRecallTimeoutMs` | `800` | Timeout for conversation recall (ms) |
| `conversationIndexMinUpdateIntervalMs` | `900000` | Min interval between index updates |

FAISS notes:
- `conversation_index_update` still writes chunk markdown under `memoryDir/conversation-index/chunks/...`; the FAISS backend additionally upserts those chunks into the local sidecar index.
- The sidecar health check reports `degraded` when Python dependencies or local artifacts are missing. Recall stays fail-open and skips semantic transcript injection instead of breaking hook execution.
- Sentence-transformers embeddings are opt-in via `ENGRAM_FAISS_ENABLE_ST=1`. Without that env var, the sidecar uses deterministic hash embeddings for low-friction local setups.

## v9.1 Evaluation Harness Foundation

| Setting | Default | Description |
|---------|---------|-------------|
| `evalHarnessEnabled` | `false` | Enable Engram's benchmark/evaluation harness bookkeeping |
| `evalShadowModeEnabled` | `false` | Record live recall decisions to the eval store without changing injected output |
| `benchmarkBaselineSnapshotsEnabled` | `false` | Enable versioned baseline snapshot artifacts for the latest completed benchmark runs |
| `benchmarkDeltaReporterEnabled` | `false` | Enable named-baseline delta reports against the current eval store |
| `evalStoreDir` | `{memoryDir}/state/evals` | Root directory for benchmark packs, run summaries, and shadow recall records |
| `objectiveStateMemoryEnabled` | `false` | Enable the objective-state memory foundation for normalized world/tool state snapshots |
| `objectiveStateSnapshotWritesEnabled` | `false` | Allow agent-end file/process/tool writers to persist objective-state snapshots into the store |
| `objectiveStateRecallEnabled` | `false` | Inject prompt-relevant objective-state snapshots into recall context |
| `objectiveStateStoreDir` | `{memoryDir}/state/objective-state` | Root directory for objective-state snapshot artifacts |
| `causalTrajectoryMemoryEnabled` | `false` | Enable the causal-trajectory memory foundation for typed goal-action-observation-outcome chains |
| `causalTrajectoryStoreDir` | `{memoryDir}/state/causal-trajectories` | Root directory for causal-trajectory records |
| `causalTrajectoryRecallEnabled` | `false` | Inject prompt-relevant causal trajectories into recall context |
| `actionGraphRecallEnabled` | `false` | Write action-conditioned causal-stage edges from typed trajectory records into the causal graph |
| `trustZonesEnabled` | `false` | Enable the trust-zone memory foundation and operator-facing promotion path for quarantine, working, and trusted records |
| `quarantinePromotionEnabled` | `false` | Allow explicit trust-zone promotions such as `quarantine -> working` and guarded `working -> trusted` |
| `trustZoneStoreDir` | `{memoryDir}/state/trust-zones` | Root directory for trust-zone records |
| `trustZoneRecallEnabled` | `false` | Inject prompt-relevant working and trusted trust-zone records into recall context |
| `memoryPoisoningDefenseEnabled` | `false` | Enable deterministic provenance trust scoring and corroboration requirements for risky trusted promotions |
| `memoryRedTeamBenchEnabled` | `false` | Enable typed `memory-red-team` benchmark packs and status accounting for poisoning-defense regression suites |
| `harmonicRetrievalEnabled` | `false` | Enable harmonic retrieval blending over abstraction nodes and cue anchors, including the dedicated recall section and `harmonic-search` diagnostics |
| `abstractionAnchorsEnabled` | `false` | Enable typed cue-anchor indexing for abstraction nodes and expose the anchor store through status tooling |
| `abstractionNodeStoreDir` | `{memoryDir}/state/abstraction-nodes` | Root directory for abstraction-node artifacts |
| `verifiedRecallEnabled` | `false` | Inject prompt-relevant memory boxes only when their cited source memories verify as non-archived episodes |
| `semanticRulePromotionEnabled` | `false` | Enable deterministic promotion of explicit `IF ... THEN ...` rules from verified episodic memories via `openclaw engram semantic-rule-promote` |
| `semanticRuleVerificationEnabled` | `false` | Verify promoted semantic rules against their cited source episodes at recall time and inject a dedicated `Verified Rules` section via `openclaw engram semantic-rule-verify` |
| `creationMemoryEnabled` | `false` | Enable the creation-memory foundation, including the typed work-product ledger and its operator-facing write/status commands |
| `memoryUtilityLearningEnabled` | `false` | Enable typed utility-learning telemetry storage, the offline learner commands `openclaw engram utility-status`, `openclaw engram utility-record`, `openclaw engram utility-learning-status`, and `openclaw engram utility-learn`, plus runtime loading of the persisted learner snapshot |
| `promotionByOutcomeEnabled` | `false` | Apply bounded learned utility weights to ranking heuristics and tier-migration thresholds when a learner snapshot is available |
| `commitmentLedgerEnabled` | `false` | Enable the explicit commitment ledger for promises, follow-ups, deadlines, and unfinished obligations |
| `commitmentLifecycleEnabled` | `false` | Enable commitment lifecycle transitions, stale tracking, and resolved-entry cleanup for the commitment ledger |
| `commitmentStaleDays` | `14` | Days before an open commitment without a due date is considered stale in lifecycle status |
| `commitmentLedgerDir` | `{memoryDir}/state/commitment-ledger` | Root directory for commitment ledger entries |
| `resumeBundlesEnabled` | `false` | Enable typed resume-bundle storage plus the operator-facing `resume-bundle-status`, `resume-bundle-record`, and `resume-bundle-build` commands |
| `resumeBundleDir` | `{memoryDir}/state/resume-bundles` | Root directory for resume bundles |
| `workProductRecallEnabled` | `false` | Inject prompt-relevant work-product ledger entries into recall and expose `openclaw engram work-product-recall-search` |
| `workProductLedgerDir` | `{memoryDir}/state/work-product-ledger` | Root directory for work-product ledger entries |

Current foundation slice:
- `openclaw engram benchmark-status` scans `benchmarks/**.json` and `runs/**.json`, validates manifests/run summaries, and reports the latest completed run.
- When `benchmarkBaselineSnapshotsEnabled` is on, Engram also tracks typed `baselines/*.json` artifacts under the eval store and surfaces the latest stored baseline snapshot in `openclaw engram benchmark-status`.
- When both eval flags are on, live recall also writes `shadow/YYYY-MM-DD/<trace-id>.json` records with hashes, counts, chosen source, and recalled memory IDs.
- `openclaw engram benchmark-validate <path>` validates a manifest JSON file or a pack directory with a root `manifest.json`.
- `openclaw engram benchmark-import <path> [--force]` validates first, then imports into `benchmarks/<benchmarkId>/`.
- `openclaw engram benchmark-baseline-snapshot --snapshot-id <id>` captures a versioned baseline snapshot of the latest completed benchmark runs under `baselines/<snapshotId>.json`.
- `openclaw engram benchmark-baseline-report --snapshot-id <id>` compares the current eval store against a named stored baseline snapshot, emits both JSON and markdown summaries, and fails when pass rate, shared metrics, coverage, or eval artifact validity regress relative to that snapshot.
- The required GitHub `eval-benchmark-gate` workflow uses the committed fixture baseline snapshot at `tests/fixtures/eval-ci/store/baselines/required-main.json` as its stable PR-gating reference.
- `openclaw engram benchmark-ci-gate --base <dir> --candidate <dir>` compares two eval-store roots and fails when pass rate, shared metrics, or benchmark coverage regress.
- When `objectiveStateRecallEnabled` is on, Engram can inject a separate `## Objective State` recall section sourced from the objective-state store.
- When `causalTrajectoryMemoryEnabled` is on, Engram can persist typed causal chains into a separate store for later graph/retrieval slices.
- When `causalTrajectoryRecallEnabled` is on, Engram can inject a separate `## Causal Trajectories` recall section sourced from the causal-trajectory store.
- When `actionGraphRecallEnabled` is also on, each newly recorded causal trajectory emits deterministic `goal -> action -> observation -> outcome -> follow_up` edges into the causal graph without changing retrieval behavior yet.
- When `trustZonesEnabled` is on, Engram can persist provenance-bearing records into separate `quarantine`, `working`, and `trusted` storage tiers.
- When `quarantinePromotionEnabled` is also on, Engram exposes an explicit promotion path that blocks direct `quarantine -> trusted` jumps and requires anchored provenance before promoting risky working records into `trusted`.
- When `trustZoneRecallEnabled` is also on, Engram injects a separate `## Trust Zones` recall section sourced from `working` and `trusted` trust-zone records while keeping `quarantine` records out of recall by default.
- When `memoryPoisoningDefenseEnabled` is also on, `openclaw engram trust-zone-status` reports deterministic provenance trust scores derived from source class plus `sourceId` / `evidenceHash` / `sessionKey` anchors so later poisoning defenses can build on explicit signals instead of hidden heuristics.
- With both `memoryPoisoningDefenseEnabled` and `quarantinePromotionEnabled` enabled, risky `working -> trusted` promotions now require at least one independent non-`quarantine` corroborating record with anchored provenance and overlapping `entityRefs` or `tags`.
- When `memoryRedTeamBenchEnabled` is on, benchmark manifests can also declare `benchmarkType: "memory-red-team"` plus `attackClass` and `targetSurface`, and `openclaw engram benchmark-status` reports red-team pack counts and unique attack metadata.
- When `harmonicRetrievalEnabled` is on, Engram can persist typed abstraction nodes into a separate abstraction-node store for later harmonic retrieval slices.
- When `abstractionAnchorsEnabled` is also on, Engram can persist cue-anchor index entries under `{abstractionNodeStoreDir}/anchors` for entities, files, tools, outcomes, constraints, and dates.
- When the harmonic retrieval section is enabled in the recall pipeline, Engram can inject a dedicated `## Harmonic Retrieval` section that explains which abstraction nodes matched and which cue anchors contributed.
- Use `openclaw engram abstraction-node-status` to inspect node storage, `openclaw engram cue-anchor-status` to inspect anchor counts and invalid index records, and `openclaw engram harmonic-search <query>` to preview blended harmonic retrieval matches.
- When `verifiedRecallEnabled` is on, Engram can inject a separate `## Verified Episodes` recall section sourced from recent memory boxes, but only when each surfaced box still cites at least one non-archived source memory whose `memoryKind` remains `episode`.
- Use `openclaw engram verified-recall-search <query>` to preview verified episodic recall matches, including verified memory counts, matched fields, and cited episodic memory IDs.
- When `semanticRulePromotionEnabled` is on, `openclaw engram semantic-rule-promote --memory-id <id>` can promote an explicit `IF ... THEN ...` rule from a non-archived episodic memory into a durable `rule` memory with lineage, `sourceMemoryId`, and duplicate suppression.
- When `semanticRuleVerificationEnabled` is on, Engram can inject a separate `## Verified Rules` recall section sourced from promoted `rule` memories, but only when each surfaced rule still clears a provenance-aware effective-confidence threshold after re-checking its `sourceMemoryId`.
- When both `creationMemoryEnabled` and `commitmentLedgerEnabled` are on, Engram can persist explicit commitment ledger entries and expose them through `openclaw engram commitment-status` and `openclaw engram commitment-record`.
- When `commitmentLifecycleEnabled` is also on, Engram can transition commitment states with `openclaw engram commitment-set-state`, report overdue/stale/decay-eligible counts in `openclaw engram commitment-status`, and apply overdue-expiry plus resolved-entry cleanup through `openclaw engram commitment-lifecycle-run`.
- When both `creationMemoryEnabled` and `resumeBundlesEnabled` are on, Engram can persist explicit typed resume bundles, inspect them with `openclaw engram resume-bundle-status`, write manual shells with `openclaw engram resume-bundle-record`, and assemble bounded bundles from transcript recovery plus recent objective state, work products, and open commitments with `openclaw engram resume-bundle-build`.
- When `creationMemoryEnabled` is on, Engram can persist explicit work-product ledger entries and expose them through `openclaw engram work-product-status` and `openclaw engram work-product-record`.
- When both `creationMemoryEnabled` and `workProductRecallEnabled` are on, Engram can inject a separate `## Work Products` recall section sourced from the typed work-product ledger and expose `openclaw engram work-product-recall-search <query>` for reuse previews.
- When `memoryUtilityLearningEnabled` is on, Engram can persist typed downstream utility telemetry for promotion and ranking decisions, inspect the resulting event ledger with `openclaw engram utility-status`, record explicit benchmark/operator utility observations through `openclaw engram utility-record`, and learn bounded offline promotion/ranking weights through `openclaw engram utility-learn` with the persisted learner snapshot visible in `openclaw engram utility-learning-status`.
- When `promotionByOutcomeEnabled` is also on and a learner snapshot exists, Engram applies bounded learned utility multipliers to ranking heuristic deltas and bounded promotion/demotion threshold nudges to tier migration without re-reading raw utility telemetry on the hot path.
- Use `openclaw engram semantic-rule-verify <query>` to preview verified semantic-rule matches, including verification status, effective confidence, and the cited source memory id.
- Future slices will add automated benchmark runners on top of this store and gate format.

## v3.0 Namespaces

See [namespaces.md](namespaces.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `namespacesEnabled` | `false` | Enable multi-agent namespace isolation |
| `defaultNamespace` | `default` | Namespace for this agent's private memories |
| `sharedNamespace` | `shared` | Namespace for promoted shared memories |
| `namespacePolicies` | `[]` | Array of per-namespace read/write policy objects |

## v4.0 Shared Context

See [shared-context.md](shared-context.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `sharedContextEnabled` | `false` | Enable shared cross-agent context |
| `sharedContextDir` | `(unset)` | Directory for shared context files |
| `sharedContextMaxInjectChars` | `4000` | Max chars injected from shared context |
| `sharedCrossSignalSemanticEnabled` | `false` | Enable optional semantic overlap enhancement during daily curation |
| `sharedCrossSignalSemanticTimeoutMs` | `4000` | Timeout budget for semantic enhancement pass (fail-open on timeout) |
| `sharedCrossSignalSemanticMaxCandidates` | `120` | Max topic-token candidates considered by semantic enhancement |

## v5.0 Compounding

See [compounding.md](compounding.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `compoundingEnabled` | `false` | Enable weekly synthesis and mistake learning |
| `compoundingInjectEnabled` | `true` | Inject compounding output when enabled |

## v6.0 Deduplication & Archival

| Setting | Default | Description |
|---------|---------|-------------|
| `factDeduplicationEnabled` | `true` | Content-hash deduplication |
| `semanticDedupEnabled` | `true` | Write-time semantic similarity guard (issue #373) — embeds each candidate fact, queries the top-K nearest neighbors, and skips the write when cosine similarity ≥ `semanticDedupThreshold`. Fails open when the embedding backend is unavailable. |
| `semanticDedupThreshold` | `0.92` | Cosine similarity threshold in `[0, 1]` above which a candidate fact is treated as a near-duplicate and skipped. |
| `semanticDedupCandidates` | `5` | Number of nearest-neighbor candidates to compare against during the write-time semantic dedup check. |
| `factArchivalEnabled` | `false` | Archive old, low-value facts |
| `factArchivalAgeDays` | `90` | Minimum age to archive |
| `factArchivalMaxImportance` | `0.3` | Maximum importance to archive |
| `factArchivalMaxAccessCount` | `2` | Maximum access count to archive |
| `factArchivalProtectedCategories` | `["commitment","preference","decision","principle","procedure"]` | Never archived |

### Write-time semantic dedup (issue #373)

Exact content-hash dedup catches identical text but lets paraphrases through.
The semantic guard runs in `orchestrator.persistExtraction()` after the hash
miss and before any storage work:

1. Embed the candidate fact via the existing embedding-fallback pipeline.
2. Query the top `semanticDedupCandidates` (default 5) nearest neighbors.
3. If the best cosine similarity is ≥ `semanticDedupThreshold` (default 0.92),
   drop the candidate, bump the existing `dedupedCount` metric, and log a
   debug line naming the colliding neighbor id and score.
4. On any lookup error or missing backend, the guard fails open so writes
   are never blocked by an embedding outage.

The guard shares its decision function with the CLI `remnic dedup` tooling
via `packages/remnic-core/src/dedup/semantic.ts`, so there is a single source
of truth for similarity logic across read-time and write-time code paths.

## v8.2 Graph Recall Activation

| Setting | Default | Description |
|---------|---------|-------------|
| `multiGraphMemoryEnabled` | `false` | Enable graph storage/traversal substrate |
| `graphRecallEnabled` | `false` | Enable planner `graph_mode` expansion |
| `graphExpandedIntentEnabled` | `true` | Escalate broader causal/timeline prompts into `graph_mode` |
| `graphAssistInFullModeEnabled` | `true` | Run bounded graph expansion during `full` recall mode |
| `graphAssistShadowEvalEnabled` | `false` | In `full` mode, run graph assist as shadow-eval (compute + snapshot + telemetry, no injection change) |
| `graphAssistMinSeedResults` | `3` | Minimum seed recalls required for full-mode graph assist |
| `graphWriteSessionAdjacencyEnabled` | `true` | Write fallback time edges between consecutive extracted memories |
| `entityGraphEnabled` | `true` | Enable entity co-reference edges |
| `timeGraphEnabled` | `true` | Enable temporal sequence edges |
| `causalGraphEnabled` | `true` | Enable causal phrase edges |
| `maxGraphTraversalSteps` | `3` | Max spreading-activation BFS hops |
| `graphActivationDecay` | `0.7` | Per-hop decay factor |
| `graphTraversalConfidenceFloor` | `0.2` | Minimum edge confidence required for traversal (issue #681 PR 3/3). Edges below this floor are pruned. Legacy edges without `confidence` are treated as `1.0`. Range `[0, 1]`. |
| `graphTraversalPageRankIterations` | `8` | PageRank-style refinement iterations applied on top of BFS spreading-activation scores (issue #681 PR 3/3). Set to `0` to disable refinement. |
| `graphEdgeDecayEnabled` | `false` | Enable the periodic graph-edge confidence decay maintenance job (issue #681 PR 2/3). When `false` all edges retain their initial confidence indefinitely. |
| `graphEdgeDecayCadenceMs` | `604800000` | How often the decay job runs, in milliseconds (default 7 days). Minimum enforced at `60000` ms. |
| `graphEdgeDecayWindowMs` | `7776000000` | Length of one decay window, in milliseconds (default 90 days). One window of inactivity costs `graphEdgeDecayPerWindow` confidence. Minimum enforced at `60000` ms. |
| `graphEdgeDecayPerWindow` | `0.1` | Fraction of confidence lost per elapsed decay window. Range `[0, 1]`. |
| `graphEdgeDecayFloor` | `0.1` | Minimum confidence an edge can decay to; the job will not reduce confidence below this value. Range `[0, 1]`. Set to `0` to allow full decay to zero. |
| `graphExpansionActivationWeight` | `0.65` | Blend weight for graph activation vs seed QMD score (0-1) |
| `graphExpansionBlendMin` | `0.05` | Lower clamp bound for blended graph-expanded scores (0-1) |
| `graphExpansionBlendMax` | `0.95` | Upper clamp bound for blended graph-expanded scores (0-1) |

## File Hygiene

| Setting | Default | Description |
|---------|---------|-------------|
| `fileHygiene.enabled` | `false` | Enable file hygiene features |
| `fileHygiene.lintEnabled` | `true` | Warn on oversized workspace files (when hygiene is enabled) |
| `fileHygiene.lintPaths` | `["IDENTITY.md","MEMORY.md"]` | Files to monitor (relative to workspaceDir) |
| `fileHygiene.lintBudgetBytes` | `20000` | Budget threshold for warnings |
| `fileHygiene.lintWarnRatio` | `0.8` | Warn at this fraction of budget |
| `fileHygiene.rotateEnabled` | `false` | Rotate oversized files into archive |
| `fileHygiene.rotatePaths` | `["IDENTITY.md"]` | Files to rotate |
| `fileHygiene.rotateMaxBytes` | `18000` | Max size before rotation |
| `fileHygiene.rotateKeepTailChars` | `2000` | Chars to keep as tail excerpt after rotation |
| `fileHygiene.archiveDir` | `.engram-archive` | Archive directory name |
| `fileHygiene.runMinIntervalMs` | `300000` | Min interval between hygiene runs |
| `fileHygiene.warningsLogEnabled` | `false` | Write human-readable hygiene warnings into the workspace instead of logging only to the gateway log |
| `fileHygiene.warningsLogPath` | `hygiene/warnings.md` | Workspace-relative warnings log path used when warning logging is enabled |
| `fileHygiene.indexEnabled` | `false` | Maintain an optional operator-facing workspace index file during hygiene passes |
| `fileHygiene.indexPath` | `ENGRAM_INDEX.md` | Workspace-relative path for the optional generated index file |

## Access Tracking

| Setting | Default | Description |
|---------|---------|-------------|
| `accessTrackingEnabled` | `true` | Track access frequency per memory |
| `boostAccessCount` | `true` | Boost frequently accessed memories in ranking |

## Memory Linking

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryLinkingEnabled` | `false` | LLM-suggested semantic links between memories |

## Summarization

| Setting | Default | Description |
|---------|---------|-------------|
| `summarizationEnabled` | `false` | Summarize old memories when count exceeds threshold |
| `summarizationTriggerCount` | `1000` | Memory count that triggers summarization |

## Extraction Judge (issue #376)

| Setting | Default | Description |
|---------|---------|-------------|
| `extractionJudgeEnabled` | `false` | Enable the LLM-as-judge post-extraction durability filter |
| `extractionJudgeModel` | `""` | Model override for judge; empty = use configured local model |
| `extractionJudgeBatchSize` | `20` | Max candidates per LLM batch call |
| `extractionJudgeShadow` | `false` | Shadow mode: log verdicts without filtering |

## Semantic Chunking (issue #368)

| Setting | Default | Description |
|---------|---------|-------------|
| `semanticChunkingEnabled` | `false` | Enable topic-boundary chunking via sentence embeddings |
| `semanticChunkingConfig` | `(see below)` | Sub-object with chunking parameters |

### `semanticChunkingConfig` keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `targetTokens` | `number` | `200` | Target token count per chunk |
| `minTokens` | `number` | `100` | Minimum token count per chunk |
| `maxTokens` | `number` | `400` | Maximum token count per chunk |
| `smoothingWindowSize` | `number` | `3` | Sliding window size for similarity smoothing |
| `boundaryThresholdStdDevs` | `number` | `1.0` | Standard deviations below mean similarity to trigger a boundary |
| `embeddingBatchSize` | `number` | `32` | Batch size for sentence embedding calls |
| `fallbackToRecursive` | `boolean` | `true` | Fall back to recursive character chunking when embeddings are unavailable |

## Page Versioning (issue #371)

| Setting | Default | Description |
|---------|---------|-------------|
| `versioningEnabled` | `false` | Enable page-level versioning |
| `versioningMaxPerPage` | `50` | Max snapshots per page (0 = unlimited) |
| `versioningSidecarDir` | `".versions"` | Override sidecar directory path (`.versions/` relative to memoryDir when unset) |

## Citations (issue #379)

| Setting | Default | Description |
|---------|---------|-------------|
| `citationsEnabled` | `false` | Emit oai-mem-citation blocks in recall responses |
| `citationsAutoDetect` | `true` | Auto-detect Codex citation context |

## MECE Taxonomy (issue #366)

| Setting | Default | Description |
|---------|---------|-------------|
| `taxonomyEnabled` | `false` | Enable the MECE knowledge directory |
| `taxonomyAutoGenResolver` | `true` | Auto-regenerate RESOLVER.md when taxonomy changes |

## Enrichment Pipeline (issue #365)

| Setting | Default | Description |
|---------|---------|-------------|
| `enrichmentEnabled` | `false` | Enable external entity enrichment pipeline |
| `enrichmentAutoOnCreate` | `false` | Auto-enrich newly created entities |
| `enrichmentMaxCandidatesPerEntity` | `20` | Max enrichment candidates per entity per run |

## Binary Lifecycle (issue #367)

| Setting | Default | Description |
|---------|---------|-------------|
| `binaryLifecycleEnabled` | `false` | Enable binary file lifecycle management |
| `binaryLifecycleGracePeriodDays` | `7` | Days before local cleanup of mirrored files |
| `binaryLifecycleBackendType` | `"none"` | Storage backend: `"none"`, `"filesystem"`, `"s3"` |
| `binaryLifecycleBackendPath` | `""` | Base path for filesystem backend |

## Peer registry (issue #679)

Manages the multi-peer schema (self, human, agent, integration). Full narrative: [peers.md](peers.md).

### Profile reasoner

The async profile reasoner derives structured `profile.md` fields from interaction-log signals.
It runs inside the Dreams REM phase and is **disabled by default**.

| Setting | Default | Description |
|---------|---------|-------------|
| `peerProfileReasonerEnabled` | `false` | Master gate for the async peer profile reasoner. Set to `true` to opt in. Least-privileged default per CLAUDE.md rules #30/#48. |
| `peerProfileReasonerModel` | `"auto"` | Model routing alias used for reasoner LLM calls. `"auto"` uses the platform routing default; operators can pin to a specific model identifier. |
| `peerProfileReasonerMinInteractions` | `5` | Minimum interaction-log entries required before the reasoner processes a peer. **`0` disables the minimum** (process every peer regardless of log depth). |
| `peerProfileReasonerMaxFieldsPerRun` | `8` | Maximum profile fields the reasoner may write per peer per run. **`0` disables field writes** while still allowing the reasoner to run its analysis. |

### Recall injection

Injects a `## Peer Profile` section from the peer registered for the active session.
**Disabled by default.**

| Setting | Default | Description |
|---------|---------|-------------|
| `peerProfileRecallEnabled` | `false` | Gate for peer-profile injection into recall context. Set to `true` to inject the active session's peer profile into every recall. |
| `peerProfileRecallMaxFields` | `5` | Maximum number of profile fields injected per recall. Fields are selected by most-recently-updated provenance timestamp. **`0` disables injection** even when `peerProfileRecallEnabled` is `true`. |

## Procedural memory (issue #519)

Stored as `category: procedure` markdown under `memoryDir/procedures/`. Narrative overview: [procedural-memory.md](procedural-memory.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `procedural.enabled` | `true` | Master gate: default-on since issue #567 PR 4/5 (previously `false`). Set to `false` (or any of `"0"`, `"no"`, `"off"`) to opt out of procedure extraction writes, task-initiation procedure recall injection, and trajectory mining side effects. |
| `procedural.minOccurrences` | `3` | Minimum cluster size for a candidate; clusters smaller than this are skipped. **`0` disables procedural mining** (`runProcedureMining` returns immediately with `skippedReason: "minOccurrences_zero"`). |
| `procedural.successFloor` | `0.75` | Minimum trajectory success rate in `[0, 1]` for miner eligibility. Raised from `0.7` in issue #567 PR 3/5. |
| `procedural.autoPromoteOccurrences` | `8` | When auto-promotion is on, occurrences before `pending_review` → `active`. |
| `procedural.autoPromoteEnabled` | `false` | Allow automatic promotion of miner candidates that meet thresholds. |
| `procedural.lookbackDays` | `14` | Trajectory lookback window for mining (days). Lowered from `30` in issue #567 PR 3/5. |
| `procedural.proceduralMiningCronAutoRegister` | `false` | When `true`, installer may register the nightly procedural mining cron entry. |
| `procedural.recallMaxProcedures` | `2` | Max procedure previews injected on task-initiation recall (`1`–`10`). Lowered from `3` in issue #567 PR 3/5 so procedural injection does not crowd other recall sections. |

## Pattern reinforcement (issue #687)

Cross-session pattern detection: clusters memories by normalized content, reinforces recurring primitives with `reinforcement_count` + `last_reinforced_at`, and optionally boosts their recall score. Narrative overview: [pattern-reinforcement.md](pattern-reinforcement.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `patternReinforcementEnabled` | `false` | Master gate. Set to `true` to enable the maintenance job that detects and reinforces recurring memory patterns across sessions. Default `false` (opt-in). |
| `patternReinforcementCadenceMs` | `604800000` | Minimum milliseconds between pattern-reinforcement runs (default 7 days). Set to `0` to disable cadence gating and allow the job to run on every MCP/cron invocation. |
| `patternReinforcementMinCount` | `3` | Minimum cluster size before a canonical memory is promoted and reinforced. Clamped to `[2, 1000]`; clusters of 1 are degenerate. |
| `patternReinforcementCategories` | `["preference", "fact", "decision"]` | Memory categories the job considers. Set to `[]` to process no categories. Procedure memories are intentionally excluded from the default list to avoid interference with the procedural miner. |
| `reinforcementRecallBoostEnabled` | `false` | When `true`, memories with `reinforcement_count > 0` receive an additive score boost during recall. Default `false` (opt-in). Requires `patternReinforcementEnabled: true` upstream to populate reinforcement counts. |
| `reinforcementRecallBoostWeight` | `0.05` | Per-unit score bonus applied per `reinforcement_count`. Raw boost is `weight × reinforcement_count`, then clipped at `reinforcementRecallBoostMax`. Range `[0, 1]`. |
| `reinforcementRecallBoostMax` | `0.3` | Maximum additive reinforcement boost per recall result. Range `[0, 1]`. Raw boost formula: `min(reinforcementRecallBoostMax, reinforcementRecallBoostWeight × reinforcement_count)`. |

## Codex Marketplace (issue #418)

| Setting | Default | Description |
|---------|---------|-------------|
| `codexMarketplaceEnabled` | `true` | Enable Codex marketplace installation support |

## Memory Extensions (issue #382)

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryExtensionsEnabled` | `true` | Enable third-party memory extension discovery |

## Cross-namespace Query Budget (issue #565)

Per-principal sliding-window rate limiter for cross-namespace recall queries.
When enabled, principals issuing bursts of recalls against namespaces other than
their own are throttled: soft limit emits a warning, hard limit denies the query.
See [Threat model](security/memory-extraction-threat-model.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `recallCrossNamespaceBudgetEnabled` | `false` | Enable per-principal cross-namespace recall budget |
| `recallCrossNamespaceBudgetWindowMs` | `60000` | Sliding window duration in milliseconds |
| `recallCrossNamespaceBudgetSoftLimit` | `10` | Queries per window that trigger a warning (still allowed) |
| `recallCrossNamespaceBudgetHardLimit` | `30` | Queries per window that trigger a denial |

## Recall Audit Anomaly Detection (issue #565)

Anomaly detection on the recall audit trail. Flags suspicious query patterns
(repeat queries, namespace walks, high-cardinality entity probes, rapid-fire)
in recall responses. See [Threat model](security/memory-extraction-threat-model.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `recallAuditAnomalyDetectionEnabled` | `false` | Enable anomaly detection on recall audit trail |
| `recallAuditAnomalyWindowMs` | `300000` | Sliding window for anomaly detectors (5 min) |
| `recallAuditAnomalyRepeatQueryLimit` | `5` | Max identical queries before repeat-query flag |
| `recallAuditAnomalyNamespaceWalkLimit` | `3` | Max distinct namespaces before namespace-walk flag |
| `recallAuditAnomalyHighCardinalityLimit` | `50` | Max candidate memory IDs in a single recall response before high-cardinality flag |
| `recallAuditAnomalyRapidFireLimit` | `30` | Max queries in window before rapid-fire flag |
| `memoryExtensionsRoot` | `""` | Override memory extensions root directory |


## Schema-Complete Default and Recommended Settings

This appendix is flattened from the runtime config schema and the live `parseConfig({})` defaults so the page stays complete even when newer or advanced settings have not yet been expanded in the narrative sections above. Unless noted otherwise, the recommended value matches the shipped default.

| Setting | Default | Recommended |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback in plugin mode)` | unset when `modelSource` is `gateway`; set `false` for local-only plugin mode; otherwise explicit key or `OPENAI_API_KEY` env fallback |
| `openaiBaseUrl` | (unset) | (unset) |
| `model` | `gpt-5.5` | `gpt-5.5` |
| `reasoningEffort` | `low` | `low` |
| `triggerMode` | `smart` | `smart` |
| `bufferMaxTurns` | `5` | `5` |
| `bufferMaxMinutes` | `15` | `15` |
| `consolidateEveryN` | `3` | `3` |
| `highSignalPatterns` | `[]` | `[]` |
| `maxMemoryTokens` | `2000` | `2000` |
| `memoryOsPreset` | (unset) | `balanced` |
| `qmdEnabled` | `true` | `true` |
| `qmdCollection` | `openclaw-engram` | `openclaw-engram` |
| `qmdMaxResults` | `8` | `8` |
| `qmdColdTierEnabled` | `false` | `false` unless you are actively tiering hot/cold QMD collections |
| `qmdColdCollection` | `openclaw-engram-cold` | `openclaw-engram-cold` |
| `qmdColdMaxResults` | `8` | `8` |
| `qmdTierMigrationEnabled` | `false` | `false` unless hot/cold QMD tiering is enabled |
| `qmdTierDemotionMinAgeDays` | `14` | `14` |
| `qmdTierDemotionValueThreshold` | `0.35` | `0.35` |
| `qmdTierPromotionValueThreshold` | `0.7` | `0.7` |
| `qmdTierParityGraphEnabled` | `true` | `true` |
| `qmdTierParityHiMemEnabled` | `true` | `true` |
| `qmdTierAutoBackfillEnabled` | `false` | `false` |
| `embeddingFallbackEnabled` | `true` | `true` |
| `embeddingFallbackProvider` | `auto` | `auto` |
| `qmdPath` | (unset) | (unset) |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | `~/.openclaw/workspace/memory/local` |
| `debug` | `false` | `false` |
| `identityEnabled` | `true` | `true` |
| `identityContinuityEnabled` | `false` | `false` |
| `identityInjectionMode` | `recovery_only` | `recovery_only` |
| `identityMaxInjectChars` | `1200` | `1200` |
| `continuityIncidentLoggingEnabled` | `false` | `false` |
| `continuityAuditEnabled` | `false` | `false` |
| `sessionObserverEnabled` | `false` | `false` until you are ready for heartbeat-triggered extraction |
| `sessionObserverDebounceMs` | `120000` | `120000` |
| `sessionObserverBands` | `[{"maxBytes":50000,"triggerDeltaBytes":4800,"triggerDeltaTokens":1200},{"maxBytes":200000,"triggerDeltaBytes":9600,"triggerDeltaTokens":2400},{"maxBytes":1000000000,"triggerDeltaBytes":19200,"triggerDeltaTokens":4800}]` | `[{"maxBytes":50000,"triggerDeltaBytes":4800,"triggerDeltaTokens":1200},{"maxBytes":200000,"triggerDeltaBytes":9600,"triggerDeltaTokens":2400},{"maxBytes":1000000000,"triggerDeltaBytes":19200,"triggerDeltaTokens":4800}]` |
| `sessionObserverBands[].maxBytes` | `50000` | `50000` |
| `sessionObserverBands[].triggerDeltaBytes` | `4800` | `4800` |
| `sessionObserverBands[].triggerDeltaTokens` | `1200` | `1200` |
| `injectQuestions` | `false` | `false` |
| `commitmentDecayDays` | `90` | `90` |
| `workspaceDir` | `~/.openclaw/workspace` | `~/.openclaw/workspace` |
| `fileHygiene` | (unset) | (unset) |
| `fileHygiene.enabled` | `false` | `true` |
| `fileHygiene.lintEnabled` | `true` | `true` |
| `fileHygiene.lintBudgetBytes` | `20000` | `20000` |
| `fileHygiene.lintWarnRatio` | `0.8` | `0.8` |
| `fileHygiene.lintPaths` | `["IDENTITY.md","MEMORY.md"]` | `["IDENTITY.md","MEMORY.md"]` |
| `fileHygiene.rotateEnabled` | `false` | `false` |
| `fileHygiene.rotateMaxBytes` | `18000` | `18000` |
| `fileHygiene.rotateKeepTailChars` | `2000` | `2000` |
| `fileHygiene.rotatePaths` | `["IDENTITY.md"]` | `["IDENTITY.md"]` |
| `fileHygiene.archiveDir` | `.engram-archive` | `.engram-archive` |
| `fileHygiene.runMinIntervalMs` | `300000` | `300000` |
| `fileHygiene.warningsLogEnabled` | `false` | `false` |
| `fileHygiene.warningsLogPath` | `hygiene/warnings.md` | `hygiene/warnings.md` |
| `fileHygiene.indexEnabled` | `false` | `false` |
| `fileHygiene.indexPath` | `ENGRAM_INDEX.md` | `ENGRAM_INDEX.md` |
| `nativeKnowledge` | (unset) | (unset) |
| `nativeKnowledge.enabled` | `false` | `true` when workspace bootstrap docs exist |
| `nativeKnowledge.includeFiles` | `["IDENTITY.md","MEMORY.md"]` | `["IDENTITY.md","MEMORY.md"]` |
| `nativeKnowledge.maxChunkChars` | `900` | `900` |
| `nativeKnowledge.maxResults` | `4` | `4` |
| `nativeKnowledge.maxChars` | `2400` | `2400` |
| `nativeKnowledge.stateDir` | `state/native-knowledge` | `state/native-knowledge` |
| `nativeKnowledge.openclawWorkspace` | (unset) | (unset) |
| `nativeKnowledge.openclawWorkspace.enabled` | `false` | `true` when you want handoffs/daily summaries in recall |
| `nativeKnowledge.openclawWorkspace.bootstrapFiles` | `["IDENTITY.md","MEMORY.md","USER.md"]` | `["IDENTITY.md","MEMORY.md","USER.md"]` |
| `nativeKnowledge.openclawWorkspace.handoffGlobs` | `["**/*handoff*.md","handoffs/**/*.md"]` | `["**/*handoff*.md","handoffs/**/*.md"]` |
| `nativeKnowledge.openclawWorkspace.dailySummaryGlobs` | `["**/*daily*summary*.md","summaries/**/*.md"]` | `["**/*daily*summary*.md","summaries/**/*.md"]` |
| `nativeKnowledge.openclawWorkspace.automationNoteGlobs` | `[]` | `[]` |
| `nativeKnowledge.openclawWorkspace.workspaceDocGlobs` | `[]` | `[]` |
| `nativeKnowledge.openclawWorkspace.excludeGlobs` | `[]` | `[]` |
| `nativeKnowledge.openclawWorkspace.sharedSafeGlobs` | `[]` | `[]` |
| `nativeKnowledge.obsidianVaults` | `[]` | `[]` |
| `nativeKnowledge.obsidianVaults[].id` | (unset) | set explicitly for every configured vault |
| `nativeKnowledge.obsidianVaults[].rootDir` | (unset) | (unset) |
| `nativeKnowledge.obsidianVaults[].includeGlobs` | `["**/*.md"]` | `["**/*.md"]` |
| `nativeKnowledge.obsidianVaults[].excludeGlobs` | `[".obsidian/**","**/*.canvas","**/*.png","**/*.jpg","**/*.jpeg","**/*.gif","**/*.pdf"]` | `[".obsidian/**","**/*.canvas","**/*.png","**/*.jpg","**/*.jpeg","**/*.gif","**/*.pdf"]` |
| `nativeKnowledge.obsidianVaults[].namespace` | (unset) | (unset) |
| `nativeKnowledge.obsidianVaults[].privacyClass` | (unset) | (unset) |
| `nativeKnowledge.obsidianVaults[].folderRules` | `[]` | `[]` |
| `nativeKnowledge.obsidianVaults[].folderRules[].pathPrefix` | (unset) | (unset) |
| `nativeKnowledge.obsidianVaults[].folderRules[].namespace` | (unset) | (unset) |
| `nativeKnowledge.obsidianVaults[].folderRules[].privacyClass` | (unset) | (unset) |
| `nativeKnowledge.obsidianVaults[].dailyNotePatterns` | `["YYYY-MM-DD"]` | `["YYYY-MM-DD"]` |
| `nativeKnowledge.obsidianVaults[].materializeBacklinks` | `false` | `false` |
| `agentAccessHttp` | `{"enabled":false,"host":"127.0.0.1","port":4318,"maxBodyBytes":131072}` | `{"enabled":false,"host":"127.0.0.1","port":4318,"maxBodyBytes":131072}` |
| `agentAccessHttp.enabled` | `false` | `false` unless you need the local HTTP bridge |
| `agentAccessHttp.host` | `127.0.0.1` | `127.0.0.1` |
| `agentAccessHttp.port` | `4318` | `4318` |
| `agentAccessHttp.authToken` | (unset) | set explicitly whenever `agentAccessHttp.enabled=true` |
| `agentAccessHttp.maxBodyBytes` | `131072` | `131072` |
| `accessTrackingEnabled` | `true` | `true` |
| `accessTrackingBufferMaxSize` | `100` | `100` |
| `recencyWeight` | `0.2` | `0.2` |
| `boostAccessCount` | `true` | `true` |
| `recordEmptyRecallImpressions` | `false` | `false` |
| `recallPlannerEnabled` | `true` | `true` |
| `recallPlannerModel` | `gpt-5.5` | `gpt-5.5` |
| `recallPlannerTimeoutMs` | `1500` | `1500` |
| `recallPlannerUseResponsesApi` | `true` | `true` |
| `recallPlannerMaxPromptChars` | `4000` | `4000` |
| `recallPlannerMaxMemoryHints` | `24` | `24` |
| `recallPlannerShadowMode` | `false` | `false` |
| `recallPlannerTelemetryEnabled` | `true` | `true` |
| `recallPlannerMaxQmdResultsMinimal` | `4` | `4` |
| `recallPlannerMaxQmdResultsFull` | `8` | `8` |
| `intentRoutingEnabled` | `false` | `false` |
| `intentRoutingBoost` | `0.12` | `0.12` |
| `verbatimArtifactsEnabled` | `false` | `true` |
| `verbatimArtifactsMinConfidence` | `0.8` | `0.8` |
| `verbatimArtifactsMaxRecall` | `5` | `5` |
| `verbatimArtifactCategories` | `["decision","correction","principle","commitment"]` | `["decision","correction","principle","commitment"]` |
| `memoryBoxesEnabled` | `false` | `false` |
| `boxTopicShiftThreshold` | `0.35` | `0.35` |
| `boxTimeGapMs` | `1800000` | `1800000` |
| `boxMaxMemories` | `50` | `50` |
| `traceWeaverEnabled` | `false` | `false` |
| `traceWeaverLookbackDays` | `7` | `7` |
| `traceWeaverOverlapThreshold` | `0.4` | `0.4` |
| `boxRecallDays` | `3` | `3` |
| `episodeNoteModeEnabled` | `false` | `false` |
| `queryAwareIndexingEnabled` | `false` | `true` |
| `queryAwareIndexingMaxCandidates` | `200` | `200` |
| `temporalIndexWindowDays` | `30` | `30` |
| `temporalIndexMaxEntries` | `5000` | `5000` |
| `temporalBoostRecentDays` | `7` | `7` |
| `temporalBoostScore` | `0.15` | `0.15` |
| `temporalDecayEnabled` | `true` | `true` |
| `tagMemoryEnabled` | `false` | `false` |
| `tagMaxPerMemory` | `5` | `5` |
| `tagIndexMaxEntries` | `10000` | `10000` |
| `tagRecallBoost` | `0.15` | `0.15` |
| `tagRecallMaxMatches` | `10` | `10` |
| `multiGraphMemoryEnabled` | `false` | `false` |
| `graphRecallEnabled` | `false` | `false` |
| `graphRecallMaxExpansions` | `3` | `3` |
| `graphRecallMaxPerSeed` | `5` | `5` |
| `graphRecallMinEdgeWeight` | `0.1` | `0.1` |
| `graphRecallShadowEnabled` | `false` | `false` |
| `graphRecallSnapshotEnabled` | `false` | `false` |
| `graphRecallShadowSampleRate` | `0.1` | `0.1` |
| `graphRecallExplainToolEnabled` | `false` | `false` |
| `graphRecallStoreColdMirror` | `false` | `false` |
| `graphRecallColdMirrorCollection` | (unset) | (unset) |
| `graphRecallColdMirrorMinAgeDays` | `7` | `7` |
| `graphRecallUseEntityPriors` | `false` | `false` |
| `graphRecallEntityPriorBoost` | `0.2` | `0.2` |
| `graphRecallPreferHubSeeds` | `false` | `false` |
| `graphRecallHubBias` | `0.3` | `0.3` |
| `graphRecallRecencyHalfLifeDays` | `30` | `30` |
| `graphRecallDampingFactor` | `0.85` | `0.85` |
| `graphRecallMaxSeedNodes` | `10` | `10` |
| `graphRecallMaxExpandedNodes` | `30` | `30` |
| `graphRecallMaxTrailPerNode` | `5` | `5` |
| `graphRecallMinSeedScore` | `0.3` | `0.3` |
| `graphRecallExpansionScoreThreshold` | `0.2` | `0.2` |
| `graphRecallExplainMaxPaths` | `3` | `3` |
| `graphRecallExplainMaxChars` | `500` | `500` |
| `graphRecallExplainEdgeLimit` | `5` | `5` |
| `graphRecallExplainEnabled` | `false` | `false` |
| `graphRecallEntityHintsEnabled` | `false` | `false` |
| `graphRecallEntityHintMax` | `3` | `3` |
| `graphRecallEntityHintMaxChars` | `200` | `200` |
| `graphRecallSnapshotDir` | `~/.openclaw/workspace/memory/local/state/graph` | `~/.openclaw/workspace/memory/local/state/graph` |
| `graphRecallEnableTrace` | `false` | `false` |
| `graphRecallEnableDebug` | `false` | `false` |
| `graphExpandedIntentEnabled` | `true` | `true` |
| `graphAssistInFullModeEnabled` | `true` | `true` |
| `graphAssistShadowEvalEnabled` | `false` | `false` |
| `graphAssistMinSeedResults` | `3` | `3` |
| `entityGraphEnabled` | `true` | `true` |
| `timeGraphEnabled` | `true` | `true` |
| `graphWriteSessionAdjacencyEnabled` | `true` | `true` |
| `causalGraphEnabled` | `true` | `true` |
| `maxGraphTraversalSteps` | `3` | `3` |
| `graphActivationDecay` | `0.7` | `0.7` |
| `graphExpansionActivationWeight` | `0.65` | `0.65` |
| `graphExpansionBlendMin` | `0.05` | `0.05` |
| `graphExpansionBlendMax` | `0.95` | `0.95` |
| `maxEntityGraphEdgesPerMemory` | `10` | `10` |
| `delinearizeEnabled` | `true` | `true` |
| `recallConfidenceGateEnabled` | `false` | `false` |
| `recallConfidenceGateThreshold` | `0.12` | `0.12` |
| `causalRuleExtractionEnabled` | `false` | `false` |
| `memoryReconstructionEnabled` | `false` | `false` |
| `memoryReconstructionMaxExpansions` | `3` | `3` |
| `graphLateralInhibitionEnabled` | `true` | `true` |
| `graphLateralInhibitionBeta` | `0.15` | `0.15` |
| `graphLateralInhibitionTopM` | `7` | `7` |
| `temporalMemoryTreeEnabled` | `false` | `false` |
| `tmtHourlyMinMemories` | `3` | `3` |
| `tmtSummaryMaxTokens` | `300` | `300` |
| `queryExpansionEnabled` | `false` | `false` |
| `queryExpansionMaxQueries` | `4` | `4` |
| `queryExpansionMinTokenLen` | `3` | `3` |
| `rerankEnabled` | `false` | `true` |
| `rerankProvider` | `local` | `local` |
| `rerankMaxCandidates` | `20` | `20` |
| `rerankTimeoutMs` | `8000` | `8000` |
| `rerankCacheEnabled` | `true` | `true` |
| `rerankCacheTtlMs` | `3600000` | `3600000` |
| `feedbackEnabled` | `false` | `false` until operators are actively curating recall quality |
| `negativeExamplesEnabled` | `false` | `false` until operators are actively curating negative examples |
| `negativeExamplesPenaltyPerHit` | `0.05` | `0.05` |
| `negativeExamplesPenaltyCap` | `0.25` | `0.25` |
| `chunkingEnabled` | `false` | `false` |
| `chunkingTargetTokens` | `200` | `200` |
| `chunkingMinTokens` | `150` | `150` |
| `chunkingOverlapSentences` | `2` | `2` |
| `contradictionDetectionEnabled` | `false` | `false` |
| `contradictionSimilarityThreshold` | `0.7` | `0.7` |
| `contradictionMinConfidence` | `0.9` | `0.9` |
| `contradictionAutoResolve` | `true` | `true` |
| `memoryLinkingEnabled` | `false` | `false` |
| `threadingEnabled` | `false` | `false` |
| `threadingGapMinutes` | `30` | `30` |
| `summarizationEnabled` | `false` | `false` |
| `summarizationTriggerCount` | `1000` | `1000` |
| `summarizationRecentToKeep` | `300` | `300` |
| `summarizationImportanceThreshold` | `0.3` | `0.3` |
| `summarizationProtectedTags` | `["commitment","preference","decision","principle"]` | `["commitment","preference","decision","principle"]` |
| `topicExtractionEnabled` | `true` | `true` |
| `topicExtractionTopN` | `50` | `50` |
| `transcriptEnabled` | `true` | `true` |
| `captureMode` | `implicit` | `implicit` |
| `transcriptRetentionDays` | `7` | `7` |
| `transcriptSkipChannelTypes` | `["cron"]` | `["cron"]` |
| `transcriptRecallHours` | `12` | `12` |
| `maxTranscriptTurns` | `50` | `50` |
| `maxTranscriptTokens` | `1000` | `1000` |
| `checkpointEnabled` | `true` | `true` |
| `checkpointTurns` | `15` | `15` |
| `compactionResetEnabled` | `false` | `false` |
| `hourlySummariesEnabled` | `true` | `true` |
| `summaryRecallHours` | `24` | `24` |
| `maxSummaryCount` | `6` | `6` |
| `summaryModel` | `gpt-5.5` | `gpt-5.5` |
| `localLlmEnabled` | `false` | `false` unless you have a healthy compatible endpoint |
| `localLlmUrl` | `http://localhost:1234/v1` | `http://localhost:1234/v1` |
| `localLlmModel` | `local-model` | `local-model` |
| `localLlmApiKey` | (unset) | (unset) |
| `localLlmHeaders` | (unset) | (unset) |
| `localLlmAuthHeader` | `true` | `true` |
| `localLlmFallback` | `true` | `true` |
| `localLlmHomeDir` | (unset) | (unset) |
| `localLmsCliPath` | (unset) | (unset) |
| `localLmsBinDir` | (unset) | (unset) |
| `localLlmTimeoutMs` | `180000` | `180000` |
| `slowLogEnabled` | `false` | `false` |
| `slowLogThresholdMs` | `30000` | `30000` |
| `traceRecallContent` | `false` | `false` |
| `extractionDedupeEnabled` | `true` | `true` |
| `extractionDedupeWindowMs` | `300000` | `300000` |
| `extractionMinChars` | `40` | `40` |
| `extractionMinUserTurns` | `1` | `1` |
| `extractionMaxTurnChars` | `4000` | `4000` |
| `extractionMaxFactsPerRun` | `12` | `12` |
| `extractionMaxEntitiesPerRun` | `6` | `6` |
| `extractionMaxQuestionsPerRun` | `3` | `3` |
| `extractionMaxProfileUpdatesPerRun` | `4` | `4` |
| `consolidationRequireNonZeroExtraction` | `true` | `true` |
| `consolidationMinIntervalMs` | `600000` | `600000` |
| `qmdMaintenanceEnabled` | `true` | `true` |
| `qmdMaintenanceDebounceMs` | `30000` | `30000` |
| `qmdAutoEmbedEnabled` | `false` | `false` |
| `qmdEmbedMinIntervalMs` | `3600000` | `3600000` |
| `qmdUpdateTimeoutMs` | `90000` | `90000` |
| `qmdUpdateMinIntervalMs` | `900000` | `900000` |
| `localLlmRetry5xxCount` | `1` | `1` |
| `localLlmRetryBackoffMs` | `400` | `400` |
| `localLlm400TripThreshold` | `5` | `5` |
| `localLlm400CooldownMs` | `120000` | `120000` |
| `localLlmMaxContext` | (unset) | (unset) |
| `localLlmFastEnabled` | `false` | `false` unless you have a separate fast local tier |
| `localLlmFastModel` | `""` | `""` |
| `localLlmFastUrl` | `http://localhost:1234/v1` | `http://localhost:1234/v1` |
| `localLlmFastTimeoutMs` | `15000` | `15000` |
| `localLlmDisableThinking` | `true` | `true` (skip reasoning tokens on structured extraction); set `false` if you want thinking on narrative tasks |
| `hourlySummaryCronAutoRegister` | `false` | `false` |
| `hourlySummariesExtendedEnabled` | `false` | `false` unless structured hourly summaries are useful |
| `hourlySummariesIncludeToolStats` | `false` | `false` |
| `hourlySummariesIncludeSystemMessages` | `false` | `false` |
| `hourlySummariesMaxTurnsPerRun` | `200` | `200` |
| `conversationIndexEnabled` | `false` | `false` unless you want transcript semantic recall |
| `conversationIndexBackend` | `qmd` | `qmd` |
| `conversationIndexQmdCollection` | `openclaw-engram-conversations` | `openclaw-engram-conversations` |
| `conversationIndexRetentionDays` | `30` | `30` |
| `conversationIndexMinUpdateIntervalMs` | `900000` | `900000` |
| `conversationIndexEmbedOnUpdate` | `false` | `false` |
| `conversationIndexFaissScriptPath` | `""` | `""` |
| `conversationIndexFaissPythonBin` | `""` | `""` |
| `conversationIndexFaissModelId` | `text-embedding-3-small` | `text-embedding-3-small` |
| `conversationIndexFaissIndexDir` | `state/conversation-index/faiss` | `state/conversation-index/faiss` |
| `conversationIndexFaissUpsertTimeoutMs` | `30000` | `30000` |
| `conversationIndexFaissSearchTimeoutMs` | `5000` | `5000` |
| `conversationIndexFaissHealthTimeoutMs` | `2000` | `2000` |
| `conversationIndexFaissMaxBatchSize` | `512` | `512` |
| `conversationIndexFaissMaxSearchK` | `50` | `50` |
| `conversationRecallTopK` | `3` | `4` |
| `conversationRecallMaxChars` | `2500` | `2000` |
| `conversationRecallTimeoutMs` | `800` | `800` |
| `evalHarnessEnabled` | `false` | `false` |
| `evalShadowModeEnabled` | `false` | `false` |
| `benchmarkBaselineSnapshotsEnabled` | `false` | `false` |
| `benchmarkStoredBaselineEnabled` | `false` | `false` |
| `benchmarkDeltaReporterEnabled` | `false` | `false` |
| `evalStoreDir` | `~/.openclaw/workspace/memory/local/state/evals` | `~/.openclaw/workspace/memory/local/state/evals` |
| `objectiveStateMemoryEnabled` | `false` | `false` |
| `objectiveStateSnapshotWritesEnabled` | `false` | `false` |
| `objectiveStateRecallEnabled` | `false` | `false` |
| `objectiveStateStoreDir` | `~/.openclaw/workspace/memory/local/state/objective-state` | `~/.openclaw/workspace/memory/local/state/objective-state` |
| `causalTrajectoryMemoryEnabled` | `false` | `false` |
| `causalTrajectoryStoreDir` | `~/.openclaw/workspace/memory/local/state/causal-trajectories` | `~/.openclaw/workspace/memory/local/state/causal-trajectories` |
| `causalTrajectoryRecallEnabled` | `false` | `false` |
| `trustZonesEnabled` | `false` | `false` |
| `quarantinePromotionEnabled` | `false` | `false` |
| `trustZoneStoreDir` | `~/.openclaw/workspace/memory/local/state/trust-zones` | `~/.openclaw/workspace/memory/local/state/trust-zones` |
| `trustZoneRecallEnabled` | `false` | `false` |
| `memoryPoisoningDefenseEnabled` | `false` | `false` |
| `memoryRedTeamBenchEnabled` | `false` | `false` |
| `harmonicRetrievalEnabled` | `false` | `false` |
| `abstractionAnchorsEnabled` | `false` | `false` |
| `abstractionNodeStoreDir` | `~/.openclaw/workspace/memory/local/state/abstraction-nodes` | `~/.openclaw/workspace/memory/local/state/abstraction-nodes` |
| `verifiedRecallEnabled` | `false` | `false` |
| `semanticRulePromotionEnabled` | `false` | `false` |
| `semanticRuleVerificationEnabled` | `false` | `false` |
| `creationMemoryEnabled` | `false` | `false` |
| `memoryUtilityLearningEnabled` | `false` | `false` |
| `promotionByOutcomeEnabled` | `false` | `false` |
| `commitmentLedgerEnabled` | `false` | `false` |
| `commitmentLifecycleEnabled` | `false` | `false` |
| `commitmentStaleDays` | `14` | `14` |
| `commitmentLedgerDir` | `~/.openclaw/workspace/memory/local/state/commitment-ledger` | `~/.openclaw/workspace/memory/local/state/commitment-ledger` |
| `resumeBundlesEnabled` | `false` | `false` |
| `resumeBundleDir` | `~/.openclaw/workspace/memory/local/state/resume-bundles` | `~/.openclaw/workspace/memory/local/state/resume-bundles` |
| `workProductRecallEnabled` | `false` | `false` |
| `workProductLedgerDir` | `~/.openclaw/workspace/memory/local/state/work-product-ledger` | `~/.openclaw/workspace/memory/local/state/work-product-ledger` |
| `workTasksEnabled` | `false` | `false` |
| `workProjectsEnabled` | `false` | `false` |
| `workTasksDir` | `~/.openclaw/workspace/memory/local/work/tasks` | `~/.openclaw/workspace/memory/local/work/tasks` |
| `workProjectsDir` | `~/.openclaw/workspace/memory/local/work/projects` | `~/.openclaw/workspace/memory/local/work/projects` |
| `workIndexEnabled` | `false` | `false` |
| `workIndexDir` | `~/.openclaw/workspace/memory/local/work/index` | `~/.openclaw/workspace/memory/local/work/index` |
| `workTaskIndexEnabled` | `false` | `false` |
| `workProjectIndexEnabled` | `false` | `false` |
| `workIndexAutoRebuildEnabled` | `false` | `false` |
| `workIndexAutoRebuildDebounceMs` | `1000` | `1000` |
| `actionGraphRecallEnabled` | `false` | `false` |
| `namespacesEnabled` | `false` | `false` |
| `defaultNamespace` | `default` | `default` |
| `sharedNamespace` | `shared` | `shared` |
| `principalFromSessionKeyMode` | `map` | `map` |
| `principalFromSessionKeyRules` | `[]` | `[]` |
| `principalFromSessionKeyRules[].match` | (unset) | (unset) |
| `principalFromSessionKeyRules[].principal` | (unset) | (unset) |
| `namespacePolicies` | `[]` | `[]` |
| `namespacePolicies[].name` | (unset) | (unset) |
| `namespacePolicies[].readPrincipals` | (unset) | (unset) |
| `namespacePolicies[].writePrincipals` | (unset) | (unset) |
| `namespacePolicies[].includeInRecallByDefault` | (unset) | (unset) |
| `defaultRecallNamespaces` | `["self","shared"]` | `["self","shared"]` |
| `cronRecallMode` | `all` | `all` |
| `cronRecallAllowlist` | `[]` | `[]` |
| `cronRecallPolicyEnabled` | `true` | `true` |
| `cronRecallNormalizedQueryMaxChars` | `480` | `480` |
| `cronRecallInstructionHeavyTokenCap` | `36` | `36` |
| `cronConversationRecallMode` | `auto` | `auto` |
| `autoPromoteToSharedEnabled` | `false` | `false` |
| `autoPromoteToSharedCategories` | `["fact","correction","decision","preference"]` | `["fact","correction","decision","preference"]` |
| `autoPromoteMinConfidenceTier` | `explicit` | `implied` (recommended) |
| `routingRulesEnabled` | `false` | `false` |
| `routingRulesStateFile` | `state/routing-rules.json` | `state/routing-rules.json` |
| `sharedContextEnabled` | `false` | `false` unless you are actively using cross-agent memory sharing |
| `sharedContextDir` | (unset) | (unset) |
| `sharedContextMaxInjectChars` | `4000` | `4000` |
| `crossSignalsSemanticEnabled` | `false` | `false` |
| `crossSignalsSemanticTimeoutMs` | `4000` | `4000` |
| `sharedCrossSignalSemanticEnabled` | `false` | `false` |
| `sharedCrossSignalSemanticTimeoutMs` | `4000` | `4000` |
| `sharedCrossSignalSemanticMaxCandidates` | `120` | `120` |
| `compoundingEnabled` | `false` | `false` unless you are ready to curate weekly syntheses |
| `compoundingWeeklyCronEnabled` | `false` | `false` |
| `compoundingSemanticEnabled` | `false` | `false` |
| `compoundingSynthesisTimeoutMs` | `15000` | `15000` |
| `compoundingInjectEnabled` | `true` | `true` |
| `factDeduplicationEnabled` | `true` | `true` |
| `semanticDedupEnabled` | `true` | `true` (issue #373 — write-time semantic guard) |
| `semanticDedupThreshold` | `0.92` | `0.92` (tighten to `0.95` for high-precision corpora, loosen to `0.88` for noisy transcripts) |
| `semanticDedupCandidates` | `5` | `5` |
| `factArchivalEnabled` | `false` | `false` unless you have validated archive policy on your corpus |
| `factArchivalAgeDays` | `90` | `90` |
| `factArchivalMaxImportance` | `0.3` | `0.3` |
| `factArchivalMaxAccessCount` | `2` | `2` |
| `factArchivalProtectedCategories` | `["commitment","preference","decision","principle","procedure"]` | `["commitment","preference","decision","principle","procedure"]` |
| `lifecyclePolicyEnabled` | `false` | `false` until you are ready to measure lifecycle outcomes |
| `lifecycleFilterStaleEnabled` | `false` | `false` for the initial lifecycle rollout |
| `lifecyclePromoteHeatThreshold` | `0.55` | `0.55` |
| `lifecycleStaleDecayThreshold` | `0.65` | `0.65` |
| `lifecycleArchiveDecayThreshold` | `0.85` | `0.85` |
| `lifecycleProtectedCategories` | `["decision","principle","commitment","preference","procedure"]` | `["decision","principle","commitment","preference","procedure"]` |
| `lifecycleMetricsEnabled` | `false` | `true` when `lifecyclePolicyEnabled=true` |
| `procedural.enabled` | `true` | `true` (default-on since issue #567 PR 4/5) or `false` to opt out. See [procedural-memory.md](procedural-memory.md). |
| `procedural.minOccurrences` | `3` | `3` (use `0` only to intentionally disable mining; see narrative section) |
| `procedural.successFloor` | `0.75` | `0.75` (raised from `0.7` in issue #567 PR 3/5) |
| `procedural.autoPromoteOccurrences` | `8` | `8` |
| `procedural.autoPromoteEnabled` | `false` | `false` until promotion rules are validated on your corpus |
| `procedural.lookbackDays` | `14` | `14` (lowered from `30` in issue #567 PR 3/5) |
| `procedural.proceduralMiningCronAutoRegister` | `false` | `false` unless you intentionally want installer cron registration |
| `procedural.recallMaxProcedures` | `2` | `2` (lowered from `3` in issue #567 PR 3/5) |
| `patternReinforcementEnabled` | `false` | `false` until you have enough cross-session data to observe clustering benefits. See [pattern-reinforcement.md](pattern-reinforcement.md). |
| `patternReinforcementCadenceMs` | `604800000` | `604800000` (7 days). Lower to `86400000` (1 day) for faster iteration during evaluation; set to `0` to disable cadence gating entirely. |
| `patternReinforcementMinCount` | `3` | `3` (minimum meaningful pattern; clusters of 2 are allowed but `3` reduces false positives on small corpora) |
| `patternReinforcementCategories` | `["preference", "fact", "decision"]` | `["preference", "fact", "decision"]` (procedure excluded intentionally — procedural miner handles that category) |
| `reinforcementRecallBoostEnabled` | `false` | `false` until you confirm pattern reinforcement is producing high-quality canonicals. Enable recall boost only after observing `remnic patterns list` output. |
| `reinforcementRecallBoostWeight` | `0.05` | `0.05` (per-unit score bonus per `reinforcement_count`; raise cautiously and pair with a lower `reinforcementRecallBoostMax` if you want fast saturation) |
| `reinforcementRecallBoostMax` | `0.3` | `0.3` (a 30-point maximum additive boost; lower to `0.1`–`0.15` for conservative uplift) |
| `proactiveExtractionEnabled` | `false` | `false` until you validate the second pass in your environment |
| `contextCompressionActionsEnabled` | `false` | `false` unless you are validating action-policy flows |
| `compressionGuidelineLearningEnabled` | `false` | `false` unless action-policy telemetry is already stable |
| `compressionGuidelineSemanticRefinementEnabled` | `false` | `false` unless deterministic guideline learning is already stable |
| `compressionGuidelineSemanticTimeoutMs` | `2500` | `2500` |
| `maxProactiveQuestionsPerExtraction` | `2` | `2` |
| `proactiveExtractionTimeoutMs` | `2500` | `2500` |
| `proactiveExtractionMaxTokens` | `900` | `900` |
| `proactiveExtractionCategoryAllowlist` | (unset) | (unset) |
| `maxCompressionTokensPerHour` | `1500` | `1500` |
| `behaviorLoopAutoTuneEnabled` | `false` | `false` until you are ready for canary tuning |
| `behaviorLoopLearningWindowDays` | `14` | `14` |
| `behaviorLoopMinSignalCount` | `10` | `10` |
| `behaviorLoopMaxDeltaPerCycle` | `0.1` | `0.1` |
| `behaviorLoopProtectedParams` | `["maxMemoryTokens","qmdMaxResults","qmdColdMaxResults","recallPlannerMaxQmdResultsMinimal","verbatimArtifactsMaxRecall"]` | `["maxMemoryTokens","qmdMaxResults","qmdColdMaxResults","recallPlannerMaxQmdResultsMinimal","verbatimArtifactsMaxRecall"]` |
| `searchBackend` | `qmd` | `qmd` |
| `remoteSearchBaseUrl` | (unset) | (unset) |
| `remoteSearchApiKey` | (unset) | (unset) |
| `remoteSearchTimeoutMs` | `30000` | `30000` |
| `lancedbEnabled` | `false` | `false` |
| `lanceDbPath` | `~/.openclaw/workspace/memory/local/lancedb` | `~/.openclaw/workspace/memory/local/lancedb` |
| `lanceEmbeddingDimension` | `1536` | `1536` |
| `meilisearchEnabled` | `false` | `false` |
| `meilisearchHost` | `http://localhost:7700` | `http://localhost:7700` |
| `meilisearchApiKey` | (unset) | (unset) |
| `meilisearchTimeoutMs` | `30000` | `30000` |
| `meilisearchAutoIndex` | `false` | `false` |
| `oramaEnabled` | `false` | `false` |
| `oramaDbPath` | `~/.openclaw/workspace/memory/local/orama` | `~/.openclaw/workspace/memory/local/orama` |
| `oramaEmbeddingDimension` | `1536` | `1536` |
| `qmdDaemonEnabled` | `true` | `true` |
| `qmdDaemonUrl` | `http://localhost:8181/mcp` | `http://localhost:8181/mcp` |
| `qmdDaemonRecheckIntervalMs` | `60000` | `60000` |
| `qmdIntentHintsEnabled` | `false` | `false` |
| `qmdExplainEnabled` | `false` | `false` |
| `knowledgeIndexEnabled` | `true` | `true` |
| `knowledgeIndexMaxEntities` | `40` | `40` |
| `knowledgeIndexMaxChars` | `4000` | `4000` |
| `entityRetrievalEnabled` | `true` | `true` |
| `entityRetrievalMaxChars` | `2400` | `2400` |
| `entityRetrievalMaxHints` | `2` | `2` |
| `entityRetrievalMaxSupportingFacts` | `6` | `6` |
| `entityRetrievalMaxRelatedEntities` | `3` | `3` |
| `entityRetrievalRecentTurns` | `6` | `6` |
| `entityRelationshipsEnabled` | `true` | `true` |
| `entityActivityLogEnabled` | `true` | `true` |
| `entityActivityLogMaxEntries` | `20` | `20` |
| `entityAliasesEnabled` | `true` | `true` |
| `entitySummaryEnabled` | `true` | `true` |
| `recallBudgetChars` | `8000` | `8000` |
| `recallPipeline` | `[{"id":"shared-context","enabled":false,"maxChars":4000},{"id":"profile","enabled":true,"consolidateTriggerLines":100,"consolidateTargetLines":50},{"id":"identity-continuity","enabled":false},{"id":"entity-retrieval","enabled":true,"maxChars":2400,"maxHints":2,"maxSupportingFacts":6,"maxRelatedEntities":3,"recentTurns":6},{"id":"knowledge-index","enabled":true,"maxChars":4000,"maxEntities":40},{"id":"verbatim-artifacts","enabled":false},{"id":"memory-boxes","enabled":false},{"id":"temporal-memory-tree","enabled":false},{"id":"objective-state","enabled":false,"maxResults":4,"maxChars":1800},{"id":"causal-trajectories","enabled":false,"maxResults":3,"maxChars":2200},{"id":"trust-zones","enabled":false,"maxResults":3,"maxChars":1800},{"id":"harmonic-retrieval","enabled":false,"maxResults":3,"maxChars":2200},{"id":"verified-episodes","enabled":false,"maxResults":3,"maxChars":1800},{"id":"verified-rules","enabled":false,"maxResults":3,"maxChars":1800},{"id":"work-products","enabled":false,"maxResults":3,"maxChars":1800},{"id":"memories","enabled":true,"maxResults":8},{"id":"compression-guidelines","enabled":false},{"id":"native-knowledge","enabled":false,"maxResults":4,"maxChars":2400},{"id":"transcript","enabled":true,"maxTurns":50,"maxTokens":1000,"lookbackHours":12},{"id":"summaries","enabled":true,"maxCount":6,"lookbackHours":24},{"id":"conversation-recall","enabled":false,"topK":3,"maxChars":2500,"timeoutMs":800},{"id":"compounding","enabled":false,"maxPatterns":40,"maxRubrics":4},{"id":"questions","enabled":false}]` | `[{"id":"shared-context","enabled":false,"maxChars":4000},{"id":"profile","enabled":true,"consolidateTriggerLines":100,"consolidateTargetLines":50},{"id":"identity-continuity","enabled":false},{"id":"entity-retrieval","enabled":true,"maxChars":2400,"maxHints":2,"maxSupportingFacts":6,"maxRelatedEntities":3,"recentTurns":6},{"id":"knowledge-index","enabled":true,"maxChars":4000,"maxEntities":40},{"id":"verbatim-artifacts","enabled":false},{"id":"memory-boxes","enabled":false},{"id":"temporal-memory-tree","enabled":false},{"id":"objective-state","enabled":false,"maxResults":4,"maxChars":1800},{"id":"causal-trajectories","enabled":false,"maxResults":3,"maxChars":2200},{"id":"trust-zones","enabled":false,"maxResults":3,"maxChars":1800},{"id":"harmonic-retrieval","enabled":false,"maxResults":3,"maxChars":2200},{"id":"verified-episodes","enabled":false,"maxResults":3,"maxChars":1800},{"id":"verified-rules","enabled":false,"maxResults":3,"maxChars":1800},{"id":"work-products","enabled":false,"maxResults":3,"maxChars":1800},{"id":"memories","enabled":true,"maxResults":8},{"id":"compression-guidelines","enabled":false},{"id":"native-knowledge","enabled":false,"maxResults":4,"maxChars":2400},{"id":"transcript","enabled":true,"maxTurns":50,"maxTokens":1000,"lookbackHours":12},{"id":"summaries","enabled":true,"maxCount":6,"lookbackHours":24},{"id":"conversation-recall","enabled":false,"topK":3,"maxChars":2500,"timeoutMs":800},{"id":"compounding","enabled":false,"maxPatterns":40,"maxRubrics":4},{"id":"questions","enabled":false}]` |
| `recallPipeline[].id` | `shared-context` | `shared-context` |
| `recallPipeline[].enabled` | `false` | `false` |
| `recallPipeline[].maxChars` | `4000` | `4000` |
| `recallPipeline[].consolidateTriggerLines` | (unset) | (unset) |
| `recallPipeline[].consolidateTargetLines` | (unset) | (unset) |
| `recallPipeline[].maxEntities` | (unset) | (unset) |
| `recallPipeline[].maxResults` | (unset) | (unset) |
| `recallPipeline[].maxTurns` | (unset) | (unset) |
| `recallPipeline[].maxTokens` | (unset) | (unset) |
| `recallPipeline[].lookbackHours` | (unset) | (unset) |
| `recallPipeline[].maxCount` | (unset) | (unset) |
| `recallPipeline[].topK` | (unset) | (unset) |
| `recallPipeline[].timeoutMs` | (unset) | (unset) |
| `recallPipeline[].maxPatterns` | (unset) | (unset) |
| `extractionJudgeEnabled` | `false` | `false` |
| `extractionJudgeModel` | `""` | `""` |
| `extractionJudgeBatchSize` | `20` | `20` |
| `extractionJudgeShadow` | `false` | `false` |
| `semanticChunkingEnabled` | `false` | `false` |
| `semanticChunkingConfig` | `{"targetTokens":200,"minTokens":100,"maxTokens":400,"smoothingWindowSize":3,"boundaryThresholdStdDevs":1.0,"embeddingBatchSize":32,"fallbackToRecursive":true}` | `{"targetTokens":200,"minTokens":100,"maxTokens":400,"smoothingWindowSize":3,"boundaryThresholdStdDevs":1.0,"embeddingBatchSize":32,"fallbackToRecursive":true}` |
| `semanticChunkingConfig.targetTokens` | `200` | `200` |
| `semanticChunkingConfig.minTokens` | `100` | `100` |
| `semanticChunkingConfig.maxTokens` | `400` | `400` |
| `semanticChunkingConfig.smoothingWindowSize` | `3` | `3` |
| `semanticChunkingConfig.boundaryThresholdStdDevs` | `1.0` | `1.0` |
| `semanticChunkingConfig.embeddingBatchSize` | `32` | `32` |
| `semanticChunkingConfig.fallbackToRecursive` | `true` | `true` |
| `versioningEnabled` | `false` | `false` |
| `versioningMaxPerPage` | `50` | `50` |
| `versioningSidecarDir` | `".versions"` | `".versions"` |
| `citationsEnabled` | `false` | `false` |
| `citationsAutoDetect` | `true` | `true` |
| `taxonomyEnabled` | `false` | `false` |
| `taxonomyAutoGenResolver` | `true` | `true` |
| `enrichmentEnabled` | `false` | `false` |
| `enrichmentAutoOnCreate` | `false` | `false` |
| `enrichmentMaxCandidatesPerEntity` | `20` | `20` |
| `binaryLifecycleEnabled` | `false` | `false` |
| `binaryLifecycleGracePeriodDays` | `7` | `7` |
| `binaryLifecycleBackendType` | `"none"` | `"none"` |
| `binaryLifecycleBackendPath` | `""` | `""` |
| `codexMarketplaceEnabled` | `true` | `true` |
| `memoryExtensionsEnabled` | `true` | `true` |
| `memoryExtensionsRoot` | `""` | `""` |
