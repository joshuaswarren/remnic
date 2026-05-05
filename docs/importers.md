# Memory importers — bring your memory to Remnic

Issue [#568](https://github.com/joshuaswarren/remnic/issues/568) ships a
family of optional importer packages that pull personal memory out of
external platforms and land it in Remnic as first-class memories.

Five sources are supported today:

| Source  | Package                   | Source label | Input                                     |
|---------|---------------------------|--------------|-------------------------------------------|
| ChatGPT | `@remnic/import-chatgpt`  | `chatgpt`    | Data-export JSON (memories + conversations) |
| Claude  | `@remnic/import-claude`   | `claude`     | Data-export JSON (projects + conversations) |
| Gemini  | `@remnic/import-gemini`   | `gemini`     | Google Takeout `My Activity.json`            |
| mem0    | `@remnic/import-mem0`     | `mem0`       | REST API (paginated) or offline JSON dump    |
| Supermemory | `@remnic/import-supermemory` | `supermemory` | JSON export from Supermemory Memories API |

Each importer is an **à-la-carte optional runtime companion** of the
`@remnic/cli` package. They are never bundled into the base CLI install,
and installing `@remnic/cli` alone will not pull any of them in. Runtime
loading goes through a computed-specifier dynamic import so npm users
who never install an adapter package receive a friendly install hint
rather than a `MODULE_NOT_FOUND`. Install only the adapter you actually
need.

> Some adapter packages may be declared as optional peer dependencies of
> `@remnic/cli` in specific release trains (so workspace + pnpm installs
> stay linked), but that wiring is not guaranteed at the package-manager
> level — always follow the `npm install @remnic/import-<source>` step
> below rather than relying on peer resolution.

```bash
# Install the CLI (core + base)
npm install -g @remnic/cli

# Add the importer you actually need
npm install -g @remnic/import-chatgpt
# or any mix of: @remnic/import-claude, @remnic/import-gemini, @remnic/import-mem0, @remnic/import-supermemory
```

If you run `remnic import --adapter <name>` without the matching package
installed, the CLI prints a clean install hint — never a
`MODULE_NOT_FOUND` stack.

## Shared CLI surface

All importers share one entrypoint:

```bash
remnic import --adapter <name> [options]
```

| Flag                        | Applies to      | Description                                                             |
|-----------------------------|-----------------|-------------------------------------------------------------------------|
| `--adapter <name>`          | all             | Required. One of `chatgpt`, `claude`, `gemini`, `mem0`, `supermemory`.                 |
| `--file <path>`             | file-based      | Path to the export file (leading `~` is expanded).                      |
| `--dry-run`                 | all             | Parse + transform only; print a plan and never write.                   |
| `--batch-size <n>`          | all             | How many memories per orchestrator batch. Default 25, range 1–500.     |
| `--rate-limit <rps>`        | API (mem0)      | Requests per second when walking a paginated API.                      |
| `--include-conversations`   | chatgpt, claude | Also import conversation summaries (one memory per conversation).       |

Invalid flag values are rejected with a user-facing error rather than
silently defaulting (CLAUDE.md rule 51).

## Source-specific notes

### ChatGPT (`@remnic/import-chatgpt`)

- Accepts OpenAI's data-export JSON files (either the top-level `memory`
  object, a bare array of saved memories, or a `conversations.json`).
- **Saved memories** are imported 1:1 by default — every active entry
  becomes one memory. Soft-deleted records are skipped.
- **Conversation summaries** are opt-in via `--include-conversations`.
  Each conversation is reduced to a single memory summarizing the
  user-authored turns along the active `current_node` → parent chain
  (abandoned branches are excluded).

### Claude (`@remnic/import-claude`)

- Accepts `projects.json`, `conversations.json`, or a combined bundle.
- **Project docs** are imported 1:1 (each `docs[].content` becomes one
  memory with `metadata.kind = "project_doc"`).
- **Project prompt templates** are imported when non-empty
  (`metadata.kind = "project_prompt_template"`).
- **Conversation summaries** are opt-in. Only human-authored turns are
  included (assistant responses are discarded).

### Gemini (`@remnic/import-gemini`)

- Accepts Google Takeout's `My Activity.json` (Gemini Apps section).
- Google Takeout exports **only the user's prompts** — assistant
  responses are not included in any Takeout. Each prompt becomes one
  memory with `metadata.kind = "prompt"`.
- Short prompts under 10 characters are dropped by default to filter
  trivial affirmations. Override with `--min-prompt-length` (library
  API) when needed.
- Legacy "Bard" activity records are included (pre-rebrand exports).

### mem0 (`@remnic/import-mem0`)

- API-first: reads `MEM0_API_KEY` (and optional `MEM0_BASE_URL` for
  self-hosted) and walks `/v1/memories/` across pagination. `--rate-limit`
  is honored between page requests.
- Also accepts offline replay dumps via `--file`, both the flat
  `{results: [...]}` shape and a multi-page recording
  `{pages: [...]}` shape used for record/replay tests.
- Pagination supports both cursor (`next`) and numeric (`page`+`total`)
  response shapes.

## Dry-run first

Every importer supports `--dry-run` for a zero-write preview:

```bash
remnic import --adapter chatgpt --file ~/chatgpt-export/memory.json --dry-run
# Dry-run: would import 147 memories from 'chatgpt'.
# (no memories were written; re-run without --dry-run to commit)
```

Dry-run never instantiates the orchestrator's write target, so it runs
instantly even on machines where the memory directory isn't set up.

## Provenance

Every imported memory carries provenance metadata that flows through the
orchestrator into recall and attribution:

- `sourceLabel` — the platform name (`chatgpt`, `claude`, `gemini`, `mem0`)
- `sourceId` — stable source-side id for idempotent re-imports
- `sourceTimestamp` — the export's original timestamp (ISO 8601)
- `importedFromPath` — the file path or API endpoint URL
- `importedAt` — when the import ran (stamped by `runImporter`)
- `metadata.kind` — `saved_memory`, `project_doc`, `prompt`, etc.

Running an importer a second time does NOT create duplicates — Remnic's
orchestrator deduplicates by content hash during ingestion.

## Privacy

Imported memories live in your Remnic memory directory alongside memories
captured from live sessions.

**Important caveat (Codex review on PR #608):** after an importer writes
records to the orchestrator, Remnic's normal extraction pipeline runs on
them. If your orchestrator is configured to use a **remote** model
provider (OpenAI, Anthropic, or any other hosted LLM) for extraction,
imported content **will be transmitted** to that provider as part of
extraction — the same way live-session content is. Importing from local
files (ChatGPT / Claude / Gemini exports) is therefore NOT an
absolute-local operation when a remote extraction model is configured.

Per-path behavior:

- **Parsing + transform + storage** is always local to your machine.
- **Extraction** (the model call that decides what to keep) follows
  whatever provider your orchestrator is configured with. To keep
  imports fully local, configure a local extraction model or disable
  extraction on the imported batch.
- **mem0 API** additionally round-trips to your configured mem0
  endpoint (which may be self-hosted or hosted).
- **Dry-run** (`--dry-run`) never writes or extracts, so it is the
  safest way to preview what an importer would pick up.


### Supermemory (`@remnic/import-supermemory`)

- Accepts JSON exports produced from Supermemory memories list endpoints.
- Works with both direct array payloads and object payloads containing `memories`, `results`, or `data`.
- Imports `content` first; falls back to `summary` or `title` when `content` is missing.
- Preserves `containerTags` and source metadata under `metadata.sourceMetadata`.

#### Supermemory → Remnic quick migration

1. Export your Supermemory memories to JSON (example uses the current API hostname):

```bash
curl -sS https://api.supermemory.ai/v3/memories/list \
  -H "Authorization: Bearer $SUPERMEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"page":1,"limit":1000}' > supermemory-memories.json
```

2. Install the Remnic importer package:

```bash
npm install -g @remnic/import-supermemory
```

3. Preview import first, then commit:

```bash
remnic import --adapter supermemory --file ./supermemory-memories.json --dry-run
remnic import --adapter supermemory --file ./supermemory-memories.json
```

If your export spans multiple pages, concatenate them into one object `{ "memories": [...] }` (or one flat array) before import.
