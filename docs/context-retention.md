# Context retention

Remnic hardens long-running sessions by making hourly summaries richer and enabling optional semantic recall over past transcripts.

## Extended hourly summaries

Config (all default off):
- `hourlySummariesExtendedEnabled`
- `hourlySummariesIncludeToolStats`
- `hourlySummariesMaxTurnsPerRun`

Output:
- `memoryDir/summaries/hourly/<sessionKey>/<YYYY-MM-DD>.md`
- Each hour is stored as a section with structured subsections.

Tool stats:
- Remnic captures tool names during `agent_end` and stores a per-session JSONL under `memoryDir/state/tool-usage/...`.
- Extended summaries can aggregate those counts per hour.

## Scheduling hourly summaries

Remnic exposes tool `memory_summarize_hourly`. The recommended scheduling approach is an OpenClaw cron job that runs an **isolated agent turn** and calls the tool.

Remnic intentionally does not silently modify `~/.openclaw/cron/jobs.json` unless `hourlySummaryCronAutoRegister: true`.

## Conversation semantic recall (optional)

Config (default off):
- `conversationIndexEnabled`
- `conversationIndexBackend` (`qmd` default; `faiss` is a live local sidecar backend)
- `conversationIndexQmdCollection` (must exist in `~/.config/qmd/index.yml` when backend is `qmd`)
- `conversationIndexFaissScriptPath`, `conversationIndexFaissPythonBin`, `conversationIndexFaissModelId`, `conversationIndexFaissIndexDir`
- `conversationIndexFaissUpsertTimeoutMs`, `conversationIndexFaissSearchTimeoutMs`, `conversationIndexFaissHealthTimeoutMs`
- `conversationIndexFaissMaxBatchSize`, `conversationIndexFaissMaxSearchK`
- `conversationIndexRetentionDays`
- `conversationRecallTopK`
- `conversationRecallMaxChars`
- `conversationRecallTimeoutMs`

How it works:
1. `conversation_index_update` chunks transcript history into markdown docs under:
   - `memoryDir/conversation-index/chunks/<sessionKey>/<YYYY-MM-DD>/*.md`
2. When `conversationIndexBackend` is `qmd`, Remnic updates and searches the configured QMD collection.
3. When `conversationIndexBackend` is `faiss`, Remnic shells out to the bundled Python sidecar and stores local artifacts under:
   - `memoryDir/state/conversation-index/faiss/index.faiss`
   - `memoryDir/state/conversation-index/faiss/metadata.jsonl`
   - `memoryDir/state/conversation-index/faiss/manifest.json`

Notes:
- This feature is designed to be fail-open. If indexing/search fails or times out, no context is injected.
- FAISS health is also fail-open. Missing Python dependencies, missing sidecar artifacts, or search-side dimension mismatches degrade recall safely instead of breaking hooks.
- Sentence-transformers embeddings are opt-in with `ENGRAM_FAISS_ENABLE_ST=1`. Without that env var, the FAISS sidecar uses deterministic hash embeddings.
