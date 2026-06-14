# API Reference

## Standalone CLI Commands

The canonical CLI is `remnic`. The legacy `engram` binary remains as a forwarder during the rename window, and the standalone commands below are still available through either name.

| Command | Description |
|---------|-------------|
| `remnic init` | Create `remnic.config.json` in the current directory |
| `remnic status [--json]` | Show server/daemon status and health |
| `remnic query <text> [--json] [--explain]` | Query memories; `--explain` shows per-tier latency breakdown |
| `remnic doctor` | Run diagnostics (Node version, config, API key, memory dir, daemon status) |
| `remnic config` | Show current resolved configuration |
| `remnic daemon <start\|stop\|restart>` | Manage the background HTTP server |
| `remnic tree <generate\|watch\|validate>` | Workspace context tree operations |
| `remnic onboard [dir] [--json]` | Analyze a project directory (language detection, doc discovery, ingestion plan) |
| `remnic curate <path> [--json]` | Curate files into memory with duplicate/contradiction detection |
| `remnic review <list\|approve\|dismiss\|flag> [id]` | Review inbox management |
| `remnic sync <run\|watch> [--source <dir>]` | Diff-aware filesystem sync |
| `remnic dedup [--json]` | Find duplicate memories |
| `remnic connectors <list\|install\|remove\|doctor> [id]` | Manage host adapter connectors |
| `remnic space <list\|switch\|create\|delete\|push\|pull\|share\|promote\|audit>` | Manage personal, project, and team memory spaces |
| `remnic benchmark <run\|check\|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]` | Run benchmarks, check for regressions, generate reports |
| `remnic versions <list\|show\|diff\|revert> <page-path> [version-id(s)]` | Page version history management |
| `remnic taxonomy <show\|resolver\|add\|remove> [args]` | MECE taxonomy knowledge directory management |
| `remnic enrich <entity-name\|--all\|audit\|providers> [--dry-run]` | External entity enrichment pipeline |
| `remnic binary <scan\|status\|run\|clean> [--dry-run\|--force]` | Binary file lifecycle operations |

All commands accept `--json` for machine-readable output. The CLI resolves configuration from:

1. `REMNIC_CONFIG_PATH` environment variable (`ENGRAM_CONFIG_PATH` is still accepted in v1.x)
2. `./remnic.config.json` in the current directory
3. `~/.config/remnic/config.json` (default)

See the [Platform Migration Guide](guides/platform-migration.md) for detailed setup and usage instructions.

---

## Universal Access Layer

Remnic exposes one shared local service layer through both HTTP and MCP adapters. The HTTP server is bearer-token protected by default and binds to loopback unless you override `agentAccessHttp.host`.

### HTTP

Core routes:

- `GET /engram/v1/health` — service health plus projection/search availability
- `POST /engram/v1/recall` — shared recall entrypoint
- `POST /engram/v1/recall/explain` — last recall snapshot plus intent/graph debug state
- `POST /engram/v1/memories` — explicit memory write path
- `POST /engram/v1/suggestions` — queue review-first memory suggestions
- `GET /engram/v1/memories` — browse memories with query/status/category filters
- `GET /engram/v1/memories/:id` — fetch one memory
- `GET /engram/v1/memories/:id/timeline` — fetch one memory lifecycle timeline
- `GET /engram/v1/entities` — list entities
- `GET /engram/v1/entities/:name` — fetch one entity
- `GET /engram/v1/review-queue` — latest governance review bundle when present
- `GET /engram/v1/maintenance` — health plus latest governance artifact summary
- `GET /engram/v1/trust-zones/status` — trust-zone store status, counts, and latest record summary
- `GET /engram/v1/trust-zones/records` — browse trust-zone records with zone/source/query filters
- `POST /engram/v1/trust-zones/promote` — dry-run or apply a trust-zone promotion
- `POST /engram/v1/trust-zones/demo-seed` — explicitly seed an opt-in buyer demo dataset
- `POST /engram/v1/review-disposition` — operator review decision write path
- `POST /engram/v1/observe` — feed conversation messages into LCM archive and extraction pipeline
- `POST /engram/v1/lcm/search` — full-text search over LCM-archived conversations
- `POST /engram/v1/lcm/compaction/flush` — drain pending LCM observations before a host compaction
- `POST /engram/v1/lcm/compaction/record` — record a completed host compaction checkpoint
- `GET /engram/v1/lcm/status` — LCM availability and stats
- `POST /v1/citations/observed` — Record observed citation usage for attribution tracking

Recall request fields:

- `query` (required)
- `sessionKey`
- `namespace`
- `topK`
- `mode` (`auto`, `no_recall`, `minimal`, `full`, `graph_mode`)
- `includeDebug`
- `cwd` (string, optional) — absolute path to the working directory. When provided and no coding context exists for the session, the server resolves git context automatically (see [Coding agent mode](coding-agent.md#project-detection)).
- `projectTag` (string, optional) — project name (e.g. `"blend-supply"`). Creates a `tag:<name>` coding context. Takes precedence over `cwd` when both are provided.

Recall response fields:

- `results`
- `count`
- `traceId`
- `plannerMode`
- `fallbackUsed`
- `sourcesUsed`
- `budgetsApplied`
- `latencyMs`

Write request envelope:

- `schemaVersion`
- `idempotencyKey`
- `dryRun`

Write endpoints share the same explicit-capture validation and duplicate suppression as the OpenClaw tooling, enforce request-size limits, and are rate-limited before mutation paths run.

#### Trust-zone routes

`GET /engram/v1/trust-zones/status`

- returns `{ namespace, status }`
- `status.records.byZone` shows quarantine/working/trusted counts
- when poisoning defense is enabled, trust-score bands and aggregate provenance scores are included

`GET /engram/v1/trust-zones/records`

Query parameters:

- `q` — free-text search over summary, tags, entity refs, and metadata
- `zone` — `quarantine`, `working`, or `trusted`
- `kind` — `memory`, `artifact`, `state`, `trajectory`, or `external`
- `sourceClass` — `tool_output`, `web_content`, `subagent_trace`, `system_memory`, `user_input`, or `manual`
- `limit`
- `offset`
- `namespace`

Each returned record includes:

- provenance summary (`sourceClass`, `sourceId`, `evidenceHashPresent`, `anchored`)
- trust score details when poisoning defense is enabled
- next-step promotion readiness (`nextPromotionTarget`, `nextPromotionAllowed`, `nextPromotionReasons`)
- corroboration counts for risky `working -> trusted` promotions

`POST /engram/v1/trust-zones/promote`

Request fields:

- `recordId` (required)
- `targetZone` (required; `working` or `trusted`)
- `promotionReason` (required)
- `recordedAt`
- `summary`
- `dryRun`
- `namespace`

`POST /engram/v1/trust-zones/demo-seed`

Request fields:

- `scenario` (optional, default: `enterprise-buyer-v1`; also supports `agentic-commerce-v1`)
- `recordedAt` (optional base ISO timestamp for demo records)
- `dryRun`
- `namespace`

This route is intentionally explicit and never runs automatically. Use it only when you want seeded demo data in the selected namespace.
`agentic-commerce-v1` is the synthetic commerce walkthrough for buyer preferences, exclusions, shipping urgency, and ask-before-checkout boundaries.

#### `POST /engram/v1/observe`

Feed conversation messages into the memory pipeline (LCM archive + extraction).

Request fields:

- `sessionKey` (string, required) — conversation session identifier
- `messages` (array, required) — array of `{ role: "user" | "assistant", content: string }` objects; must be non-empty
- `messages[].sourceFormat` (string, optional) — source payload format; supports `openai`, `anthropic`, `openclaw`, `pi`, `lossless-claw`, and `remnic`
- `messages[].parts` (array, optional) — structured tool/file/message parts used by coding-agent integrations
- `namespace` (string, optional) — target namespace; defaults to the resolved namespace from the principal
- `skipExtraction` (boolean, optional) — when `true`, messages are archived in LCM but not sent through extraction
- `cwd` (string, optional) — absolute path to the working directory. When provided and no coding context exists for the session, the server resolves git context automatically (see [Coding agent mode](coding-agent.md#project-detection)).
- `projectTag` (string, optional) — project name (e.g. `"blend-supply"`). Creates a `tag:<name>` coding context. Takes precedence over `cwd` when both are provided.

Response (HTTP 202):

- `accepted` — number of messages accepted
- `sessionKey` — echo of the session key
- `namespace` — resolved namespace
- `lcmArchived` — whether messages were archived in LCM
- `extractionQueued` — whether messages were queued for extraction

Rate-limited to 30 requests per minute. See the [Standalone Server Guide](guides/standalone-server.md#the-observe-endpoint) for details.

#### `POST /engram/v1/lcm/search`

Full-text search over LCM-archived conversation messages.

Request fields:

- `query` (string, required) — search query
- `sessionKey` (string, optional) — filter results to a specific session
- `namespace` (string, optional) — filter by namespace
- `limit` (number, optional, default: 10) — maximum results

Response (HTTP 200):

- `query` — echo of the search query
- `namespace` — resolved namespace
- `results` — array of `{ sessionId, content, turnIndex }` objects
- `count` — number of results returned
- `lcmEnabled` — whether LCM is enabled; if `false`, results will be empty

#### `POST /engram/v1/lcm/compaction/flush`

Drain pending LCM observation work for a session before a host compacts its local context. Pi uses this from `session_before_compact` so Remnic has the latest turns before the compacted checkpoint is generated.

Request fields:

- `sessionKey` (string, required) — conversation session identifier
- `namespace` (string, optional) — target namespace

Response (HTTP 200):

- `enabled` — whether LCM is enabled
- `flushed` — whether a flush was performed
- `sessionKey` — echo of the session key
- `namespace` — resolved namespace
- `reason` (optional) — present when LCM is disabled

#### `POST /engram/v1/lcm/compaction/record`

Record the token delta for a completed host compaction. This lets Remnic correlate host-side compaction events with LCM checkpoints and later search/recall behavior.

Request fields:

- `sessionKey` (string, required) — conversation session identifier
- `namespace` (string, optional) — target namespace
- `tokensBefore` (integer, required) — non-negative token count before compaction
- `tokensAfter` (integer, required) — non-negative token count after compaction

Response (HTTP 200):

- `enabled` — whether LCM is enabled
- `recorded` — whether the compaction event was recorded
- `sessionKey` — echo of the session key
- `namespace` — resolved namespace
- `reason` (optional) — present when LCM is disabled

#### `GET /engram/v1/lcm/status`

Returns LCM availability and statistics.

Response (HTTP 200):

- `enabled` — whether LCM is enabled
- `archiveAvailable` — whether the LCM archive is accessible
- `stats` (optional) — `{ totalTurns }` when LCM is enabled

#### `POST /v1/citations/observed`

Record that cited memories were used by the agent. Used for citation attribution tracking.

Request fields:

- `sessionId` (string, optional) — Session identifier
- `namespace` (string, optional) — Target namespace
- `citations` (object, required) — Citation data containing:
  - `entries` (array, optional) — Array of `{ path: string, lineStart: number, lineEnd: number, note?: string }` objects
  - `rolloutIds` (string[], optional) — Rollout IDs from the oai-mem-citation block

Response (HTTP 200):

- `ok` (boolean) — Whether the request succeeded
- `submitted` (number) — Number of citation entries submitted
- `matched` (number) — Number of entries matched to existing memories
- `entriesReceived` (number) — Number of citation entries in the request
- `rolloutIdsReceived` (number) — Number of rollout IDs in the request

#### `X-Engram-Principal` Header

When the server is started with `--trust-principal-header`, requests can include an `X-Engram-Principal` header to override the authenticated principal for that request. This determines namespace read/write access. Without `--trust-principal-header`, the header is silently ignored.

### MCP

Run the server with:

```bash
openclaw engram access mcp-serve
```

Available MCP tools:

- `remnic.recall` — accepts optional `cwd` and `projectTag` for automatic project detection
- `remnic.recall_explain`
- `remnic.memory_get`
- `remnic.memory_timeline`
- `remnic.memory_store`
- `remnic.suggestion_submit`
- `remnic.entity_get`
- `remnic.review_queue_list`
- `remnic.observe` — accepts optional `cwd` and `projectTag` for automatic project detection
- `remnic.lcm_search`
- `remnic.lcm_compaction_flush`
- `remnic.lcm_compaction_record`
- `remnic.day_summary`
- `remnic.set_coding_context` — attach or clear a session's coding context; accepts a full `codingContext` object or a `projectTag` shorthand

The legacy `engram.*` aliases remain available through the v1.x compatibility window.

The MCP adapter calls the same `EngramAccessService` methods used by HTTP, so equivalent request classes return the same structured payloads.

#### `remnic.observe`

Feed conversation messages into Remnic's memory pipeline (LCM archive + extraction).

**Parameters:**
- `sessionKey` (string, required) — conversation session identifier
- `messages` (array, required) — array of `{ role: "user" | "assistant", content: string }` objects
- `messages[].sourceFormat` (string, optional) — source payload format, including `pi`
- `messages[].parts` (array, optional) — structured tool/file/message parts
- `namespace` (string, optional) — target namespace
- `skipExtraction` (boolean, optional) — skip extraction, archive in LCM only
- `cwd` (string, optional) — absolute working directory path for automatic git context resolution
- `projectTag` (string, optional) — project name for non-git sessions (creates a `tag:<name>` coding context)

**Returns:** `{ accepted, sessionKey, namespace, lcmArchived, extractionQueued }`

#### `remnic.lcm_search`

Search the LCM conversation archive for matching content using full-text search.

**Parameters:**
- `query` (string, required) — search query
- `sessionKey` (string, optional) — filter to a specific session
- `namespace` (string, optional) — filter by namespace
- `limit` (number, optional) — max results to return

**Returns:** `{ query, namespace, results: [{ sessionId, content, turnIndex }], count, lcmEnabled }`

#### `remnic.lcm_compaction_flush`

Flush pending LCM observation work before a host-side context compaction.

**Parameters:**
- `sessionKey` (string, required) — conversation session identifier
- `namespace` (string, optional) — target namespace

**Returns:** `{ enabled, flushed, sessionKey, namespace, reason? }`

#### `remnic.lcm_compaction_record`

Record a host-side compaction event after the host has produced the compacted checkpoint.

**Parameters:**
- `sessionKey` (string, required) — conversation session identifier
- `namespace` (string, optional) — target namespace
- `tokensBefore` (integer, required) — non-negative token count before compaction
- `tokensAfter` (integer, required) — non-negative token count after compaction

**Returns:** `{ enabled, recorded, sessionKey, namespace, reason? }`

#### `remnic.day_summary`

Generate a structured end-of-day summary from memory content.

**Parameters:**
- `memories` (string, optional) — Pre-collected memory text; when omitted or empty, auto-gathers today's facts and hourly summaries from storage
- `sessionKey` (string, optional) — Session identifier
- `namespace` (string, optional) — Target namespace

**Returns:** Structured summary of the day's memory activity.

### MCP over HTTP

The HTTP server also exposes an MCP JSON-RPC endpoint at `POST /mcp`, allowing remote MCP clients (e.g., Codex CLI, Claude Code) to use Engram tools over HTTP instead of STDIO:

```bash
openclaw engram access http-serve --host 0.0.0.0 --port 4318 --token "$TOKEN"
```

Clients send standard MCP JSON-RPC requests to `http://<host>:4318/mcp` with an `Authorization: Bearer <token>` header. Advertised MCP tools include both canonical `remnic.*` names and legacy `engram.*` aliases where supported. Write operations (`engram.memory_store`, `engram.suggestion_submit`, `engram.observe`, `engram.lcm_compaction_flush`, `engram.lcm_compaction_record`) are rate-limited consistently with the REST write endpoints - dry runs and idempotency replays do not count toward the limit.

**Namespace-enabled deployments:** If you have `namespacesEnabled: true`, pass `--principal <name>` to set the authenticated principal for all MCP connections. The principal must appear in `writePrincipals` for the target namespace. Without `--principal`, the principal resolves to `"default"`, which may not have write access:

```bash
openclaw engram access http-serve --host 0.0.0.0 --principal generalist --token "$TOKEN"
```

Deployments with `namespacesEnabled: false` (the default) do not need `--principal` — all writes are permitted.

## Agent Tools

These tools are registered with the OpenClaw gateway and are callable by agents.

### `memory_search`

Search memories by semantic similarity.

**Parameters:**
- `query` (string, required) — The search query.
- `limit` (number, optional, default: 10) — Max results to return.
- `category` (string, optional) — Filter by memory category.
- `namespace` (string, optional) — Filter by namespace.
- `collection` (string, optional) — QMD collection override for direct MCP/access calls.

When namespaces are enabled, unqualified searches use the authenticated principal's readable recall namespaces. Passing `collection: "global"` remains ACL-scoped to those readable namespaces; it does not bypass namespace isolation. Namespace-derived collection names are accepted only when they match a readable requested namespace. Arbitrary custom collections are rejected in namespace mode because Remnic cannot prove they are namespace-safe. Deployments without namespaces may still search a named custom QMD collection directly.

**Returns:** Array of matching memories with scores, paths, and content snippets.

---

### `memory_store`

Manually store a memory without going through the extraction pipeline.

**Parameters:**
- `content` (string, required) — The memory content.
- `category` (string, required) — One of: `fact`, `preference`, `correction`, `entity`, `decision`, `relationship`, `principle`, `commitment`, `moment`, `skill`.
- `confidence` (number, optional, default: 0.9) — Confidence score 0–1.
- `tags` (string[], optional) — Tags to attach.

`memory_store` shares the same explicit-capture validation, sanitization, duplicate handling, lifecycle logging, and review-queue fallback used by `memory_capture`.

**Returns:** The stored memory's ID and file path, or the duplicate/review item identifier when Engram suppresses a direct write.

---

### `memory_capture`

Create a structured explicit memory note that obeys `captureMode` policy.

Prefer this tool over inline notes when tool use is available. In `explicit` mode it is the primary write path; in `hybrid` mode it bypasses buffering and persists immediately when validation passes.

**Parameters:**
- `content` (string, required) — One durable fact, decision, correction, commitment, or other standalone note.
- `category` (string, optional, default: `fact`) — One of: `fact`, `preference`, `correction`, `entity`, `decision`, `relationship`, `principle`, `commitment`, `moment`, `skill`, `rule`.
- `confidence` (number, optional, default: `0.95`) — Confidence score 0–1.
- `namespace` (string, optional) — Requested namespace, subject to namespace policy.
- `tags` (string[], optional) — Tags to attach.
- `entityRef` (string, optional) — Related entity id.
- `ttl` (string, optional) — ISO timestamp or relative duration like `30m`, `12h`, `7d`, or `2w`.
- `sourceReason` (string, optional) — Human/operator rationale recorded in lifecycle metadata.

Validation rules:
- content must be 10–4000 chars
- nested `<memory_note>` blocks are rejected
- unsafe categories, secrets, credentials, and invalid namespace targets are rejected
- exact duplicates are suppressed before write

If a direct write is rejected, Engram queues a sanitized `pending_review` memory instead of silently dropping the request.

**Returns:** The accepted memory id, duplicate target id, or queued review item id.

---

### `memory_profile`

Retrieve the current behavioral profile.

**Parameters:** None.

**Returns:** The contents of `profile.md`.

---

### `memory_entities`

List all tracked entities.

**Parameters:**
- `type` (string, optional) — Filter by entity type (person, company, project, place).

**Returns:** Array of entity summaries with names, types, and fact counts.

---

### `memory_promote`

Promote a memory to a shared namespace so other agents can access it.

**Parameters:**
- `memoryId` (string, required) — The ID of the memory to promote.
- `targetNamespace` (string, optional, default: `shared`) — Destination namespace.

**Returns:** The new path in the shared namespace.

---

### `memory_feedback`

Record explicit feedback on a recalled memory.

**Parameters:**
- `memoryId` (string, required) — The ID of the memory.
- `signal` (string, required) — One of: `thumbs_up`, `thumbs_down`.
- `note` (string, optional) — Optional explanation.

**Returns:** Confirmation with updated memory status.

---

### `memory_action_apply`

Record a memory-action telemetry event with optional safe dry-run mode.

**Parameters:**
- `action` (string, required) — One of: `store_episode`, `store_note`, `update_note`, `create_artifact`, `summarize_node`, `discard`, `link_graph`.
- `outcome` (string, optional, default: `applied`) — One of: `applied`, `skipped`, `failed`.
- `reason` (string, optional) — Operator rationale or note.
- `memoryId` (string, optional) — Targeted memory ID if applicable.
- `namespace` (string, optional) — Namespace to write telemetry into.
- `sourcePrompt` (string, optional) — Prompt text used only for hash telemetry.
- `dryRun` (boolean, optional, default: `false`) — Validate/report action without persisting telemetry.

**Returns:** Confirmation text; in dry-run, reports what would be recorded.

---

### `action_confidence`

Return a read-only interruption-budgeting decision: `ask`, `draft`, `act`,
`refuse`, or `escalate`.

**HTTP:** `POST /remnic/v1/action-confidence` or
`POST /engram/v1/action-confidence`

**MCP:** `remnic.action_confidence` or `engram.action_confidence`

**Parameters:**
- `confidence` (number, optional) - Overall confidence score 0-1.
- `risk` (string, optional) - One of: `low`, `medium`, `high`, `irreversible`, `restricted`.
- `contextReadiness` (string, optional) - One of: `none`, `partial`, `sufficient`.
- `retrievedMemories` (array, optional) - Provenance/safety summaries for recalled memories.
- `currentContextScopes` (array, optional) - Current user-context scopes.
- `userRules` (array, optional) - Matched `ask-before`, `do-not-use-outside-this-context`, `never`, or `requires-escalation` rules.

**Returns:** The decision, confidence, blockers, reasons, factor breakdown, and
`attentionPolicy: "interruption_budgeting"`.

---

### `identity_anchor_get`

Read the identity continuity anchor document used for recovery-safe identity context.

**Parameters:** None.

**Returns:** Current identity anchor markdown, or guidance if missing/disabled.

---

### `identity_anchor_update`

Conservatively merge updates into identity anchor sections (non-destructive by default).

**Parameters:**
- `identityTraits` (string, optional) — Updates for `Identity Traits`.
- `communicationPreferences` (string, optional) — Updates for `Communication Preferences`.
- `operatingPrinciples` (string, optional) — Updates for `Operating Principles`.
- `continuityNotes` (string, optional) — Updates for `Continuity Notes`.

**Returns:** Updated anchor content with merged sections.

---

### `continuity_incident_open`

Open a continuity incident with symptom and optional context fields.

**Parameters:**
- `symptom` (string, required)
- `triggerWindow` (string, optional)
- `suspectedCause` (string, optional)

**Returns:** Created incident record summary.

---

### `continuity_incident_close`

Close an existing continuity incident with required fix and verification fields.

**Parameters:**
- `id` (string, required)
- `fixApplied` (string, required)
- `verificationResult` (string, required)
- `preventiveRule` (string, optional)

**Returns:** Closed incident record summary, or not-found message.

---

### `continuity_incident_list`

List continuity incidents with optional state filtering.

**Parameters:**
- `state` (`open` | `closed` | `all`, optional, default `open`)
- `limit` (number, optional, default `25`, max `200`)

**Returns:** Formatted incident list.

---

### `continuity_loop_add_or_update`

Add or update a continuity improvement loop entry in `identity/improvement-loops.md`.

**Parameters:**
- `id` (string, required) — Stable loop identifier.
- `cadence` (`daily` | `weekly` | `monthly` | `quarterly`, required)
- `purpose` (string, required)
- `status` (`active` | `paused` | `retired`, required)
- `killCondition` (string, required)
- `lastReviewed` (string, optional, ISO timestamp)
- `notes` (string, optional)

**Returns:** Saved loop summary.

---

### `continuity_loop_review`

Update review metadata on an existing continuity loop entry.

**Parameters:**
- `id` (string, required)
- `status` (`active` | `paused` | `retired`, optional)
- `notes` (string, optional)
- `reviewedAt` (string, optional, ISO timestamp)

**Returns:** Updated loop summary, or not-found message.

---

## CLI Commands

Run via `openclaw engram <command>`:

| Command | Description |
|---------|-------------|
| `flush` | Force-flush the buffer and run extraction now |
| `search <query>` | Search memories from the terminal |
| `stats` | Show memory counts, buffer state, and QMD status |
| `export [--format json\|sqlite\|md]` | Export all memories to a portable file |
| `import <file>` | Import memories from a portable file |
| `purge` | Delete all memories (requires confirmation) |
| `continuity incidents [--state open\|closed\|all] [--limit N]` | List continuity incidents |
| `continuity incident-open --symptom <text> [--trigger-window <text>] [--suspected-cause <text>]` | Open a continuity incident |
| `continuity incident-close --id <id> --fix-applied <text> --verification-result <text> [--preventive-rule <text>]` | Close a continuity incident |
| `action-audit [--namespace <name>] [--limit N]` | Show namespace-aware memory action outcomes and policy decisions |
| `action-confidence [--confidence N] [--risk low\|medium\|high\|irreversible\|restricted] [--context none\|partial\|sufficient]` | Evaluate ask/draft/act/refuse/escalate advisory policy |
| `trust-zone-status` | Show trust-zone store status and aggregate counts |
| `trust-zone-promote --record-id <id> --target-zone <zone> --reason <text> [--dry-run]` | Preview or apply a trust-zone promotion |
| `trust-zone-demo-seed [--scenario enterprise-buyer-v1\|agentic-commerce-v1] [--recorded-at <iso>] [--dry-run]` | Explicitly preview or seed an opt-in trust-zone buyer demo dataset |
| `versions <list\|show\|diff\|revert> <page-path> [version-id(s)]` | Page version history management |
| `taxonomy <show\|resolver\|add\|remove> [args]` | MECE taxonomy knowledge directory management |
| `enrich <entity-name\|--all\|audit\|providers> [--dry-run]` | External entity enrichment pipeline |
| `binary <scan\|status\|run\|clean> [--dry-run\|--force]` | Binary file lifecycle operations |

## Error Responses

All error responses follow a consistent JSON structure:

```json
{
  "error": "human-readable error description",
  "code": "machine-readable error code",
  "details": [{ "field": "fieldName", "message": "field-specific error" }]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `error` | string | Human-readable summary of what went wrong |
| `code` | string | Machine-readable error code for programmatic handling |
| `details` | array | Optional. Present on validation errors with per-field breakdown |

### Common error codes

| HTTP Status | Code | Meaning |
|-------------|------|---------|
| 400 | `validation_error` | Request body failed schema validation; `details` has per-field errors |
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `invalid_json_object` | Request body is not a JSON object |
| 400 | `input_error` | Business logic validation failure (from service layer) |
| 401 | `unauthorized` | Missing or invalid bearer token |
| 404 | `not_found` | Unknown endpoint or resource |
| 413 | `request_body_too_large` | Body exceeds `maxBodyBytes` (default: 128KB) |
| 429 | `write_rate_limited` | Write rate limit exceeded (30 requests per 60 seconds) |
| 500 | `internal_error` | Unexpected server error |

### Correlation IDs

Every response includes an `X-Request-Id` header with a UUIDv4 correlation ID. Use this when reporting issues — it links to the server-side log entry for that request.

### Validation errors

Write endpoints (`recall`, `observe`, `memories`, `suggestions`, `review-disposition`, `trust-zones/promote`, `trust-zones/demo-seed`, `lcm/search`, `lcm/compaction/flush`, `lcm/compaction/record`) validate request bodies against Zod schemas before processing. A validation error returns HTTP 400 with `code: "validation_error"` and a `details` array:

```json
{
  "error": "request validation failed",
  "code": "validation_error",
  "details": [
    { "field": "confidence", "message": "Number must be less than or equal to 1" }
  ]
}
```

### Versioning

The v1 API is stable. Breaking changes will use a new path prefix (e.g., `/engram/v2/`). Additive changes (new optional fields, new endpoints) may appear at any time.

## Plugin Hooks

| Hook | When it fires | What Engram does |
|------|--------------|-----------------|
| `gateway_start` | Gateway process starts | Initialize storage, probe QMD, load buffer |
| `before_agent_start` | Before each agent session | Recall relevant memories, inject into system prompt |
| `agent_end` | After each agent turn | Buffer the turn, maybe trigger extraction |
