# API Reference

Remnic exposes one local service layer through HTTP and MCP adapters, a set of agent tools registered with the OpenClaw gateway, and an OpenClaw-hosted command surface. This page is the reference for all three. For the standalone `remnic` command-line tool, see the [CLI reference](cli.md).

## Standalone CLI Commands

The canonical CLI is `remnic`; the legacy `engram` binary remains as a forwarder during the rename window, and every command works under either name. The full standalone reference — all 35 top-level commands, their subcommands, and flags — lives in the [CLI reference](cli.md).

This page documents the shared access layer (HTTP + MCP), the agent tools, and the [`openclaw engram`](#cli-commands) hosted command surface.

---

## Universal Access Layer

Remnic exposes one shared local service layer through both HTTP and MCP adapters. The HTTP server is bearer-token protected by default and binds to loopback unless you override `agentAccessHttp.host`.

### HTTP

Two infrastructure routes carry no request envelope and sit outside the op-gated catalog: `GET /engram/v1/health` (service health plus projection/search availability) and `POST /mcp` (the [MCP-over-HTTP](#mcp-over-http) JSON-RPC delegate). Every other route below is op-gated and shares the write envelope, rate limits, and validation described later on this page.

**Recall and query**

- `POST /engram/v1/recall` — shared recall entrypoint
- `POST /engram/v1/recall/explain` — last recall snapshot plus intent/graph debug state
- `GET /engram/v1/recall/tier-explain` — tier-explain document for a session
- `GET /engram/v1/recall/xray` — recall with X-ray attribution capture (`q` required)
- `GET /engram/v1/recall/timings` — recent recall timing samples
- `POST /engram/v1/action-confidence` — read-only ask/draft/act/refuse/escalate decision

**Memories and entities**

- `POST /engram/v1/memories` — explicit memory write path
- `GET /engram/v1/memories` — browse memories with query/status/category filters
- `POST /engram/v1/memories/search` — ranked semantic search over memories (the QMD-backed `memory_search` surface; `GET /engram/v1/memories` is a substring browse). Optional `mode` (`search` │ `hybrid` │ `bm25` │ `vector`) selects the ranking; omitted means the backend default
- `GET /engram/v1/memories/:id` — fetch one memory
- `GET /engram/v1/memories/:id/timeline` — fetch one memory's lifecycle timeline
- `POST /engram/v1/suggestions` — queue review-first memory suggestions
- `GET /engram/v1/entities` — list entities
- `GET /engram/v1/entities/:id` — fetch one entity

**Corrections**

- `POST /engram/v1/correction/plan` — plan a natural-language memory correction
- `POST /engram/v1/correction/apply` — apply a planned correction
- `GET /engram/v1/correction/pending` — list pending corrections

**Observe and LCM**

- `POST /engram/v1/observe` — feed conversation messages into the LCM archive and extraction pipeline
- `POST /engram/v1/extraction/flush` — force-drain buffered extraction for one scoped session
- `POST /engram/v1/lcm/search` — full-text search over LCM-archived conversations
- `POST /engram/v1/lcm/compaction/flush` — drain pending LCM observations before a host compaction
- `POST /engram/v1/lcm/compaction/record` — record a completed host compaction checkpoint
- `GET /engram/v1/lcm/status` — LCM availability and stats

**Trust zones**

- `GET /engram/v1/trust-zones/status` — store status, counts, and latest record summary
- `GET /engram/v1/trust-zones/records` — browse trust-zone records with zone/source/query filters
- `POST /engram/v1/trust-zones/promote` — dry-run or apply a trust-zone promotion
- `POST /engram/v1/trust-zones/demo-seed` — explicitly seed an opt-in demo dataset

**Review, governance, and quality**

- `GET /engram/v1/review-queue` — latest governance review bundle when present
- `POST /engram/v1/review-disposition` — operator review-decision write path
- `GET /engram/v1/review/contradictions` — list contradiction-review items
- `GET /engram/v1/review/contradictions/:id` — one contradiction pair
- `POST /engram/v1/review/resolve` — resolve a contradiction pair
- `POST /engram/v1/contradiction-scan` — run an on-demand contradiction scan
- `GET /engram/v1/maintenance` — health plus latest governance artifact summary
- `GET /engram/v1/quality` — memory quality status

**Coding agent**

- `POST /engram/v1/coding-context` — attach or clear a session's coding context
- `POST /engram/v1/coding/decisions` — record or list coding decision records
- `POST /engram/v1/coding/architecture` — get or refresh the architecture card
- `POST /engram/v1/coding/delta` — session delta since last seen

**Capsules and offline sync**

- `POST /engram/v1/capsules/export` — export a portable capsule archive
- `POST /engram/v1/capsules/import` — import a capsule archive
- `GET` or `POST /engram/v1/offline-sync/snapshot` — offline sync snapshot
- `POST /engram/v1/offline-sync/files` — list files for offline sync
- `POST /engram/v1/offline-sync/file-content` — read file content
- `POST /engram/v1/offline-sync/apply-file-content` — apply file content
- `POST /engram/v1/offline-sync/apply` — apply an offline sync batch
- `GET /engram/v1/offline-sync/snapshot-stream` — snapshot stream (SSE)

**Wearables**

- `GET /engram/v1/wearables/status` — wearable source status
- `POST /engram/v1/wearables/sync` — sync one source or all sources
- `GET /engram/v1/wearables/transcript` — full transcript for a day
- `GET /engram/v1/wearables/transcripts/search` — search stored transcripts
- `GET /engram/v1/wearables/memories` — transcript-derived memories

**Graph, peers, dreams, and console**

- `GET /engram/v1/adapters` — host-adapter status
- `GET /engram/v1/procedural/stats` — procedural-memory stats
- `GET /engram/v1/graph/snapshot` — read-only graph snapshot
- `GET /engram/v1/graph/events` — graph event stream (SSE)
- `GET /engram/v1/peers` — list peers
- `GET /engram/v1/peers/:id` — fetch one peer
- `PUT /engram/v1/peers/:id` — create or update a peer
- `DELETE /engram/v1/peers/:id` — delete a peer
- `GET /engram/v1/peers/:id/profile` — fetch a peer's cognitive profile
- `GET /engram/v1/dreams/status` — Dreams pipeline telemetry
- `POST /engram/v1/dreams/run` — run one Dreams phase
- `GET /engram/v1/console/state` — runtime console state snapshot
- `POST /engram/v1/chat/message` — chat message (SSE)
- `GET /engram/v1/chat/events/:id` — chat event stream (SSE)

**Citations**

- `POST /v1/citations/observed` — record observed citation usage for attribution tracking (note: no `/engram/v1` prefix)

Recall request fields:

- `query` (required)
- `sessionKey`
- `namespace`
- `topK`
- `mode` (`auto`, `no_recall`, `minimal`, `full`, `graph_mode`)
- `includeDebug`
- `cwd` (string, optional) — absolute path to the working directory. When provided and no coding context exists for the session, the server resolves git context automatically (see [Coding agent mode](coding-agent.md#project-detection)).
- `projectTag` (string, optional) — project name (e.g. `"acme-webshop"`). Creates a `tag:<name>` coding context. Takes precedence over `cwd` when both are provided.

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
- `projectTag` (string, optional) — project name (e.g. `"acme-webshop"`). Creates a `tag:<name>` coding context. Takes precedence over `cwd` when both are provided.

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
- `namespace` (string, optional) — target namespace for a single flush
- `namespaces` (array of strings, optional, 1–64 entries, no duplicates) — target namespaces for one quota-counted batch flush; each namespace is resolved and authorized independently. Mutually exclusive with `namespace`; supplying both, or duplicate entries, returns HTTP 400.
- `cwd` (string, optional) — working directory used for project scope resolution
- `projectTag` (string, optional) — project tag used for project scope resolution

Response (HTTP 200):

- Single flush: `enabled`, `flushed`, `sessionKey`, `namespace`, and optional `reason`
- Batch flush: `enabled`, `flushed`, `sessionKey`, `namespaces`, and `results` entries with `status`, `namespace`, and (for fulfilled entries) `result`
- A batch flush still returns HTTP 200 when an individual namespace fails or is denied; that namespace appears in `results` with `status: "rejected"`, and `enabled`/`flushed` are `false` for the batch.

#### `POST /engram/v1/extraction/flush`

Force-drain SmartBuffer extraction for a session. This route works when LCM is disabled.

Request fields:

- `sessionKey` (string, required) — conversation session identifier
- `namespace` (string, optional) — target namespace
- `cwd` (string, optional) — working directory used for project scope resolution
- `projectTag` (string, optional) — project tag used for project scope resolution
- `deadlineMs` (number, optional) — absolute deadline in Unix milliseconds

Response (HTTP 200):

- `flushed` — whether the force-flush completed
- `sessionKey` — echo of the session key
- `namespace` — legacy resolved namespace
- `effectiveNamespace` — scoped write namespace used for extraction

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

Run via `openclaw engram <command>` when Remnic is hosted inside OpenClaw. This is a curated subset of the roughly 100 hosted subcommands; the [operations guide](operations.md) covers the operator workflows, and the standalone `remnic` binary is documented in the [CLI reference](cli.md).

| Command | Description |
|---------|-------------|
| `stats` | Show memory counts, buffer state, and QMD status |
| `search <query>` | Search memories from the terminal |
| `recall <query>` | Run a full recall |
| `doctor` | Diagnose the hosted install |
| `flush-access` | Flush pending access-tracking updates to disk |
| `access-stats [--top N]` | Show the most-accessed memories |
| `export [--format json\|md\|sqlite] [--out <path>]` | Export memories to a portable file |
| `import [--from <path>] [--format auto\|json\|md\|sqlite]` | Import memories from a portable file |
| `backup` | Snapshot the memory directory |
| `purge` | Delete memories (requires confirmation) |
| `bulk-import --source weclone` | Bulk-import from a registered hosted source (for example WeClone) |
| `access <http-serve\|http-stop\|http-status\|mcp-serve>` | Manage the HTTP and MCP access surfaces |
| `continuity <incidents\|incident-open\|incident-close>` | Manage continuity incidents |
| `action-audit [--namespace <name>] [--limit N]` | Show namespace-aware memory action outcomes and policy decisions |
| `action-confidence [--confidence N] [--risk <level>] [--context <readiness>]` | Evaluate the ask/draft/act/refuse/escalate advisory policy |
| `trust-zone-status` | Show trust-zone store status and aggregate counts |
| `trust-zone-promote --record-id <id> --target-zone <zone> --reason <text> [--dry-run]` | Preview or apply a trust-zone promotion |
| `trust-zone-demo-seed [--scenario enterprise-buyer-v1\|agentic-commerce-v1] [--recorded-at <iso>] [--dry-run]` | Explicitly preview or seed an opt-in trust-zone demo dataset |

`access` manages the HTTP and MCP access surfaces (`http-serve`, `http-stop`, `http-status`, `mcp-serve`); the separate `access-stats` command reports the most-accessed memories. The two are distinct commands — do not conflate them.

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
| 429 | `write_rate_limited` | Write rate limit exceeded (default: 30 requests per 60 seconds; tunable via `agentAccessHttp.writeRateLimitMaxRequests` / `writeRateLimitWindowMs`, or `server.*` for the standalone daemon — issue #1937) |
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
| `before_prompt_build` | Before prompt construction | Recall relevant memories, inject into system prompt |
| `agent_end` | After each agent turn | Buffer the turn, maybe trigger extraction |
