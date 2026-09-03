# Config Reference

All settings live in `openclaw.json` under `plugins.entries.openclaw-remnic.config`. (Installs created before the rename may still use the legacy `openclaw-engram` entry key; Remnic reads either.)

Use `openclaw engram config-review` for opinionated tuning recommendations and `openclaw engram doctor` for runtime or configuration problems. The narrative sections below explain the major feature groups; the schema-complete appendix at the bottom is the authoritative default-and-recommended matrix for every shipped config key. Remnic ships 751 schema-validated top-level options plus 4 tuning presets, so treat the appendix as the source of truth and reach for a preset before hand-tuning individual keys.

## Core

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback in plugin mode)` | Optional OpenAI API key, `${ENV_VAR}` reference, or `false` to disable direct OpenAI entirely. When `modelSource` is `gateway`, Remnic does not inherit `OPENAI_API_KEY`; gateway provider auth is used instead. |
| `openaiBaseUrl` | `(env fallback)` | Override OpenAI API base URL (e.g. for proxies or compatible endpoints); falls back to `OPENAI_BASE_URL` env var |
| `llmBridgeClientConfigPath` | (unset) | Path to the Hermes loopback-bridge client JSON. Parsed into `backgroundGeneration` only. Never copied onto `openaiBaseUrl`. |
| `backgroundGeneration.endpoint` | (unset) | Chat-completions URL for the Hermes loopback bridge. Consumed only by hourly background generation. |
| `backgroundGeneration.token` | (unset) | Loopback bearer from the generated client file. |
| `backgroundGeneration.timeoutSeconds` | `120` | Absolute deadline for one background-generation request. |
| `backgroundGeneration.timeout_seconds` | `120` | Snake-case alias of `timeoutSeconds` from the generated Hermes client file. |
| `model` | `gpt-5.5` | OpenAI model for extraction and consolidation |
| `reasoningEffort` | `low` | `none`, `low`, `medium`, `high` |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage root |
| `workspaceDir` | `~/.openclaw/workspace` | Workspace root (IDENTITY.md location) |
| `captureMode` | `implicit` | Memory write policy: `implicit`, `explicit`, or `hybrid` |
| `debug` | `false` | Enable debug logging |
| `inlineSourceAttributionEnabled` | `false` | Append inline source markers on persisted facts. |
| `inlineSourceAttributionFormat` | `[Source: agent={agent}, session={sessionId}, ts={ts}]` | Template for those markers. |
| `inlineSourceAttributionFormatHistory` | `[]` | Prior templates still stripped during merge after a format change. |

OpenClaw installs default new Remnic entries to `modelSource: "gateway"` so LLM calls use the gateway agent model chain instead of requiring a Remnic-specific OpenAI API key.

## Active recall

| Setting | Default | Description |
|---------|---------|-------------|
| `activeRecallPromptAppend` | `(unset)` | Optional guidance appended to the active-recall prompt |
| `activeRecallPromptOverride` | `(unset)` | Legacy custom instruction retained for compatibility |
| `activeRecallPromptReplacement` | `(unset)` | Optional complete replacement prompt for the active-recall builder |

`activeRecallPromptReplacement` takes precedence over `activeRecallPromptOverride` when both are set.

## External connectors

| Setting | Default | Description |
|---------|---------|-------------|
| `connectors.googleDrive.clientSecret` | `""` | OAuth2 client secret for the Google Drive connector; use a secret reference |
| `connectors.googleDrive.refreshToken` | `""` | OAuth2 refresh token for the Google Drive connector; use a secret reference |
| `connectors.gmail.clientSecret` | `""` | OAuth2 client secret for the Gmail connector; use a secret reference |
| `connectors.gmail.refreshToken` | `""` | OAuth2 refresh token for the Gmail connector; use a secret reference |


## Screen activity

The activity subsystem is off by default. It synchronizes redacted text snapshots from explicitly configured local capture daemons; it does not persist screenshots or input events.

| Setting | Default | Description |
|---------|---------|-------------|
| `activity.enabled` | `false` | Master gate. When false, Remnic neither contacts activity sources nor writes activity rows or digests. |
| `activity.timezone` | `UTC` | IANA timezone for local-day synchronization and digest grouping. |
| `activity.syncDays` | `1` | Number of local days to synchronize per run; integer from 1 through 90. |
| `activity.autoSyncIntervalMinutes` | `15` | Periodic in-process auto-sync cadence in minutes; integer from 1 through 1440. |
| `activity.sources` | `[]` | Trusted capture-daemon sources. Required when `activity.enabled` is true. |
| `activity.sources.machineLabel` | `(required)` | Stable capture-machine label used to isolate rows and cursors. |
| `activity.sources.baseUrl` | `(required)` | HTTP or HTTPS URL of the local capture daemon; must target a loopback host (`localhost`, `127.0.0.0/8`, or `::1`) since the bearer token travels in the request. |
| `activity.sources.token` | `(unset)` | Literal bearer token sent to a trusted local capture daemon over loopback. This parser does not resolve secret references or `${ENV_VAR}` placeholders; omit the field when the daemon needs no auth. |
| `activity.timeline.enabled` | `false` | Master gate for timeline-card derivation (issue #2049). When false, no timeline cards are built or exposed. |
| `activity.timeline.analysis.enabled` | `false` | Independent gate for optional AI analysis over deterministic timeline cards (issue #2050). Gated separately from capture, timeline derivation, and memory creation: disabled makes zero provider calls and writes zero analysis artifacts. |
| `activity.timeline.analysis.provider` | `(required when enabled)` | Explicit provider id: `"local"` routes to the local LLM client; any other identifier routes to the configured remote provider registry pinned to exactly this provider (no chain fallback). Single provider segment only (letters, digits, `._:-`; no `/`); at most 120 characters. An invalid explicit provider fails, never silently defaults. |
| `activity.timeline.analysis.model` | `(required when enabled)` | Model id (letters, digits, `._:-/`); at most 120 characters. May include `/`. |
| `activity.timeline.analysis.timeoutMs` | `15000` | Per-request timeout in ms. Integer 1000..120000. |
| `activity.timeline.analysis.preferences` | `[]` | Up to 16 free-form user preference strings, each non-blank and ≤200 characters, passed to the analysis prompt. The OpenClaw config schema enforces the same bounds. Never secrets: prompt payloads are evidence-only — no screenshots, audio, OCR text, keystrokes, clipboard contents, or media are ever sent. |
| `activity.timeline.journal.enabled` | `false` | Master gate for every `remnic journal` action — show, edit-path, seed, and extract all refuse before any journal read when false (issues #1984, #1987). Journal files live at `journal/<YYYY-MM-DD>.md` and are excluded from generic recall. |
| `activity.timeline.journal.source` | `"memoryDir"` | Where journal text is read from (issue #1987): `"memoryDir"` reads `journal/<YYYY-MM-DD>.md`; `"vault"` reads the `activity.timeline.vault.readback.journalSection` section of the daily vault note. `"vault"` requires `activity.timeline.vault.enabled: true` and a resolvable `dailyNotePath` — parse fails naming every missing prerequisite. Legacy `"file"` is accepted as an alias of `"memoryDir"` and emits a deprecation warning. |
| `activity.timeline.journal.extractionMode` | `"off"` | Review-only journal extraction (issue #1987): `"review"` runs a pass over changed journal text producing `pending_review` candidates only (tags `journal`, `journal-day:<date>`; `valid_at` pinned to the day; `structuredAttributes.journalSource` records the source). No auto mode by design. |
| `activity.timeline.qa.enabled` | `false` | Gate for `remnic timeline range|search` (issue #1983). |
| `activity.timeline.qa.maxRangeDays` | `31` | Maximum `timeline_range` span in days. Integer 1..366. |
| `activity.timeline.vault.enabled` | `false` | Master gate for the markdown-vault publisher (issue #1985). When false, no vault reads or writes ever occur. |
| `activity.timeline.vault.vaultPath` | `(required when enabled)` | Vault root, absolute or `~` path. Must exist and be a directory; a symlinked root is rejected. |
| `activity.timeline.vault.dailyNotePath` | `"{yyyy}-{MM}-{dd}.md"` | Vault-relative daily-note path template. Tokens: `{yyyy} {yy} {M} {MM} {d} {dd} {ww} {MMM} {MMMM} {ddd} {dddd}` (English month/weekday names). Unknown tokens are rejected at config load naming the token and the full valid set; `..` segments and absolute templates are rejected. |
| `activity.timeline.vault.weeklyNotePath` | `""` | Weekly-note path template; empty means weekly-note publishing is disabled. Required (non-empty) when any enabled publish target is `"weekly"`. |
| `activity.timeline.vault.createMissingNotes` | `false` | Create a missing note from `noteTemplate` before publishing, creating any missing parent directories inside the vault. Default is update-existing-only. |
| `activity.timeline.vault.noteTemplate` | `""` | Vault-relative template file whose contents seed a note created by `activity.timeline.vault.createMissingNotes`; empty means a new note starts empty. Validated at config load when note creation is enabled: absolute paths, `..` segments, and unknown date tokens are rejected, and a template resolving outside the vault is refused before anything is written. |
| `activity.timeline.vault.sectionStrategy` | `"markers"` | `"markers"` owns the bytes between an HTML-comment marker pair; `"heading"` owns a uniquely-named heading's body (duplicate headings are refused with both line numbers). Markers and headings inside fenced code blocks are ignored, so a fenced `## Timeline` example or marker sample is never published over. |
| `activity.timeline.vault.publish.timeline.enabled` | `true` | Gate for the day timeline artifact — the live target, which publishes the persisted day recap. Paired with `activity.timeline.vault.publish.timeline.target` (`"daily"`) and `activity.timeline.vault.publish.timeline.section` (`Timeline`). |
| `activity.timeline.vault.publish.timeline.target` | `"daily"` | Note file that receives the timeline artifact: `"daily"` or `"weekly"`. |
| `activity.timeline.vault.publish.timeline.section` | `"Timeline"` | Managed-region (or heading) name for the timeline artifact. Non-empty, trimmed, unique among enabled sections on the same target file, and free of `:` (the marker grammar's delimiter), a line break, or `-->`. |
| `activity.timeline.vault.publish.standup.enabled` | `false` | Gate for the standup artifact; the target lights up when the standup renderer lands (timeline phase 3). |
| `activity.timeline.vault.publish.standup.target` | `"daily"` | Note file that receives the standup artifact. |
| `activity.timeline.vault.publish.standup.section` | `"Standup"` | Managed-region (or heading) name for the standup artifact. |
| `activity.timeline.vault.publish.weekly.enabled` | `false` | Gate for the weekly review artifact; lights up when the weekly renderer lands (timeline phase 4). |
| `activity.timeline.vault.publish.weekly.target` | `"weekly"` | Note file that receives the weekly review. An enabled `"weekly"` target requires a non-empty `weeklyNotePath`, else config load fails naming it; a disabled one never does. |
| `activity.timeline.vault.publish.weekly.section` | `"Weekly Review"` | Managed-region (or heading) name for the weekly review. |
| `activity.timeline.vault.publish.locations.enabled` | `false` | Gate for the location day line; lights up with the location day renderer. |
| `activity.timeline.vault.publish.locations.target` | `"daily"` | Note file that receives the location day line. |
| `activity.timeline.vault.publish.locations.section` | `"Locations"` | Managed-region (or heading) name for the location day line. |
| `activity.timeline.vault.insertUnderHeading` | `""` | Markers strategy: heading under which missing marker pairs are auto-inserted. Empty means never insert — an unmarked note is skipped with reason `no marker`, never guessed. Headings inside fenced code blocks are ignored, so a region is never inserted into a code example. |
| `activity.timeline.vault.wikilinks.places` | `false` | Render place names as `[[Places/<Name>|<Name>]]` wikilinks when the locations target lights up. |
| `activity.timeline.vault.wikilinks.placesFolder` | `"Places"` | Vault folder for place wikilink targets. |
| `activity.timeline.vault.properties.mode` | `"off"` | `"off"` writes no properties; `"frontmatter"` adds/updates only prefix-owned keys via targeted line edits (key order and formatting of everything else preserved byte-exactly); `"dataview-inline"` appends `key:: value` lines inside the managed region. |
| `activity.timeline.vault.properties.prefix` | `"remnic_"` | Property key prefix (e.g. `remnic_focus_minutes`). |
| `activity.timeline.vault.readback.journalSection` | `""` | Heading whose section of the daily note is the user's journal (issue #1987). Arbitrary user-chosen text — any language, emoji, or punctuation — matched exactly. Required non-empty when `activity.timeline.journal.source` is `"vault"`. Legacy `activity.timeline.journal.heading` is copied here when this key is empty and ignored (with a deprecation warning) when this key is set. |
| `activity.timeline.journal.heading` | _(unset)_ | Deprecated alias of `activity.timeline.vault.readback.journalSection`. Used only when the new key is absent; the new key wins if both are present. |
| `activity.timeline.vault.autoPublish` | `true` | Publish after each successful artifact generation, once those hooks land. The `remnic timeline publish` CLI is always available. |

### Timeline cards (issue #2049)

The timeline layer derives replayable day cards from stored activity
snapshots — it never creates a second evidence store. All intervals are
half-open `[start, end)` UTC; day bounds reuse the digest's DST-aware window,
so a spring-forward day is 23 hours and a fall-back day is 25. Determinism
rules, in order:

- Cards are built per capture machine from observations sorted by capture
  instant and content hash, never by array position.
  Two adjacent observations merge only when they share the exact
  `(app, windowTitle)` pair and are at most 2 minutes apart; a user pause
  between them also closes the card.
- A card ends at its last observation plus at most 15 minutes of dwell
  (matching the digest dwell cap), clipped by the next observation on the
  machine, a pause, or the day end — cards never overlap on a track.
- Any uncovered remainder between cards on a machine becomes a derived idle
  card with no evidence; a user-declared pause becomes a pause card and wins
  over idle covering the same minutes. Nothing is invented for gaps: idle and
  pause cards are flagged by `kind` and carry no evidence references, and the
  day's leading/trailing uncovered ranges stay card-free.
- Card ids hash machine, first/last evidence identity, and bounds — not
  wall-clock or position — so identical evidence replays into byte-identical
  cards across runs and process restarts.
- Classification is a deterministic first pass over app / browser-domain /
  window-title signals; unmatched activity stays visible in the reserved
  `system.unknown` category (confidence 0) instead of being reassigned.
- Manual category/title corrections are keyed by stable card id, stored in
  `state/activity-timeline.sqlite`, survive rebuilds, and are reverted by an
  explicit reset.

## Location

The location subsystem is off by default. It buckets place observations from registered providers into local-day documents; core ships no provider client — a host adapter registers providers (issue #2044).

| Setting | Default | Description |
|---------|---------|-------------|
| `location.enabled` | `false` | Master gate. When false, Remnic neither contacts location providers nor reads or writes any location state. |
| `location.timezone` | `UTC` | IANA timezone for local-day bucketing of observations. |
| `location.syncDays` | `1` | Number of local days to synchronize per run; integer from 1 through 90. |
| `location.retainCoordinates` | `false` | When false (default), place coordinates are dropped before any persistence or rendering; only place labels are kept. |
| `location.minimumOverlapSeconds` | `300` | Minimum overlap in seconds for a location tag match. `0` disables the floor. |
| `location.minimumConfidence` | `0.7` | Minimum provider-reported place confidence in `[0,1]` for a tagging match. |
| `location.tagging` | `{ enabled: false, backfillEnabled: false }` | Provider-owned location tagging gates. |
| `location.tagging.enabled` | `false` | When false, no memory is tagged with location context. Requires `location.enabled`. |
| `location.tagging.backfillEnabled` | `false` | Extra gate for the historical backfill command. Requires `location.tagging.enabled`. |
| `location.sources` | `[]` | Location sources. Required when `location.enabled` is true. |
| `location.sources.id` | `(required)` | Registered provider id (lowercase kebab: `a-z`, `0-9`, hyphens); must be unique across sources. |
| `location.sources.enabled` | `true` | Set false to short-circuit this source only; other sources still sync. |

### Surfaces that consume location context (issue #2925)

With `location.enabled` and `location.tagging.enabled` both on:

- Wearable conversations whose provider supplied no location get the matched
  dominant-overlap place label in their `*Location:*` transcript line. A
  source-provided or manual value is never overwritten, and non-dominant,
  conflicting, or below-threshold matches leave the field empty.
- `day_summary` accepts `includeLocation: true` (MCP/HTTP) to append a
  labels-only `## Location context` section to the gathered facts for the
  summary. Without the flag the gathered input is byte-identical to a
  no-location build.
- `briefing` accepts `includeLocation: true` (CLI `--include-location`,
  MCP/HTTP) to append the same labels-only section, anchored on the local day
  containing the briefing window's start in `location.timezone`.

Only place labels and dwell durations are ever rendered; coordinates and raw
location records never reach day summaries, briefings, or wearable outputs.

## OKF

| Setting | Default | Description |
|---------|---------|-------------|
| `okf` | `{ conformanceEnabled: true, sweepEnabled: false, indexFilesEnabled: false }` | Open Knowledge Format conformance block. |
| `okf.conformanceEnabled` | `true` | Emit inert `type` on writes and add Profile frontmatter. `false` disables emission. |
| `okf.sweepEnabled` | `false` | Opt-in backfill of missing `type` without bumping `updated`. |
| `okf.indexFilesEnabled` | `false` | Generate `index.md` files in the live store. `false` removes generated indexes. |

## Wearables

| Setting | Default | Description |
|---------|---------|-------------|
| `wearables.offTheRecordMarkers` | `{}` | Optional object that configures extra off-the-record marker phrases. |
| `wearables.offTheRecordMarkers.start` | `[]` | Array of strings that adds extra start phrases. |
| `wearables.offTheRecordMarkers.end` | `[]` | Array of strings that adds extra end phrases. |
| `wearables.offTheRecordMarkers.useBuiltIns` | `true` | Boolean that keeps built-in marker phrases enabled. |
| `wearables.fillerTokens` | `[]` | Array of strings that adds filler tokens when `cleanup.stripFillers` is on. |

## Trust scoring

| Setting | Default | Description |
|---------|---------|-------------|
| `trustScoreWeights.memoryWorth` | `(default)` | Weight for memory-worth evidence |
| `trustScoreWeights.provenance` | `(default)` | Weight for provenance evidence |
| `trustScoreWeights.faithfulness` | `(default)` | Weight for faithfulness evidence |
| `trustScoreWeights.corroboration` | `(default)` | Weight for corroboration evidence |
| `trustScoreWeights.contradiction` | `(default)` | Weight for contradiction evidence |
| `trustScoreWeights.domainCalibration` | `(default)` | Weight for domain-calibration evidence |
| `trustScoreWeights.feedback` | `(default)` | Weight for feedback evidence |
| `trustScoreWeights.recency` | `(default)` | Weight for recency evidence |

`captureMode` behavior:

- `implicit`: normal extraction/write behavior.
- `explicit`: normal conversation turns never create memories; only structured explicit capture writes or queues review items.
- `hybrid`: explicit capture writes immediately, while the normal extraction pipeline remains available.

## Memory OS Presets

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryOsPreset` | `(unset)` | Optional advanced preset: `conservative`, `balanced`, `research-max`, or `local-llm-heavy`. Preset values seed the advanced config surface before explicit per-setting overrides are applied. |

Preset intent:

- `conservative` keeps recall budgets lower and leaves experimental learning/graph features off. It also pins `procedural.enabled: false`, opting out of procedural memory even though the global default is `true` (issue #567). The `procedural` block is deep-merged, so a partial user override cannot silently re-enable it — set `procedural.enabled: true` explicitly if you want it back.
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
| `agentAccessHttp.writeRateLimitMaxRequests` | `30` | Max write requests (memory stores, observes) per rolling window before the HTTP API returns `429 write_rate_limited`. Positive integer; invalid values are rejected at config parse time (issue #1937). |
| `agentAccessHttp.writeRateLimitWindowMs` | `60000` | Rolling window for the write rate limit, in milliseconds. Positive integer (issue #1937). |
| `supportPassport.enabled` | `false` | Enable What Helps Me owner routes, MCP tools, public helper grants, and browser assets. See [support-passport.md](support-passport.md). |
| `supportPassport.trustedProxyAddresses` | `[]` | Exact reverse-proxy IP addresses allowed to supply `X-Forwarded-For` for public helper limits. Leave empty without a trusted proxy. |
| `server.adminConsoleEnabled` | `false` | Standalone daemon: serve the browser admin console at `/remnic/ui/` (and `/engram/ui/`). Env: `REMNIC_ADMIN_CONSOLE_ENABLED` (legacy `ENGRAM_ADMIN_CONSOLE_ENABLED`). |
| `server.adminConsolePublicDir` | `(unset)` | Standalone daemon: directory of packaged admin-console static assets. Env: `REMNIC_ADMIN_CONSOLE_PUBLIC_DIR` (legacy `ENGRAM_ADMIN_CONSOLE_PUBLIC_DIR`). |
| `server.adminConsolePrefillToken` | `false` | Standalone daemon: inject the primary auth token into the admin console shell on trusted launch surfaces. Env: `REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN` (legacy `ENGRAM_ADMIN_CONSOLE_PREFILL_TOKEN`). |
| `server.adminConsoleMemoryReviewEnabled` | `false` | Standalone daemon: enable the admin-console memory review deck UI and its three deck HTTP routes. Default off. Does not disable existing review operations. Env: `REMNIC_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED` (legacy `ENGRAM_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED`). |

When `agentAccessHttp.enabled` is on (or `openclaw engram access http-serve` is running), the same loopback server also serves the browser-based admin console shell at `/engram/ui/`. The shell is static, ships with packaged plugin builds, and still requires the configured bearer token over `/engram/v1/...` for memory data and operator actions.

The memory review deck is a separate gate. Set `server.adminConsoleMemoryReviewEnabled` (or `REMNIC_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED`; legacy `ENGRAM_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED`) to serve that UI and its three deck routes. Existing review operations stay available when the gate is off.

Access-layer safety notes:

- HTTP startup fails closed when no bearer token is configured.
- Request bodies are capped by `agentAccessHttp.maxBodyBytes`.
- Explicit write routes are rate-limited (tunable via `agentAccessHttp.writeRateLimitMaxRequests` / `agentAccessHttp.writeRateLimitWindowMs`; standalone daemon: `server.writeRateLimitMaxRequests` / `server.writeRateLimitWindowMs`) and support `schemaVersion`, `idempotencyKey`, and `dryRun` envelopes.
- The stdio MCP server (`openclaw engram access mcp-serve`) uses the same internal access service as HTTP, so recall/read/write behavior stays aligned across both transports.
- MCP is intentionally zero-config on the Remnic side: launch `openclaw engram access mcp-serve` from the client and it will use the same local memory directory, namespace rules, and explicit-capture policy as the in-process plugin runtime.

## Buffer & Triggers

| Setting | Default | Description |
|---------|---------|-------------|
| `triggerMode` | `smart` | `smart`, `every_n`, or `time_based` |
| `bufferMaxTurns` | `5` | Max buffered turns before forced extraction |
| `bufferMaxMinutes` | `15` | Max minutes before forced extraction |
| `bufferSaveDebounceMs` | `3000` | Debounce (ms) for persisting the smart buffer to `state/buffer.json` on a trailing edge; `0` = save every turn. Extraction trigger/clear and shutdown force an immediate flush. Under sustained activity a pending save is forced after at most 5× this window so the crash-loss window stays bounded. Must be an integer in `[0, 2147483647]` (Node's 32-bit `setTimeout` limit); out-of-range / non-integer / non-numeric values are rejected at config load. |
| `highSignalPatterns` | `[]` | Additional regex patterns for immediate extraction |
| `consolidateEveryN` | `3` | Run consolidation every N extractions |

> **Overflow policy (provider outage).** While the extraction circuit breaker is open during a prolonged provider outage, buffered turns are retained (not dropped) so no extractable turn is lost — they are re-extracted once the provider recovers. Buffered *session entries* are bounded to `MAX_BUFFER_ENTRY_COUNT` (200); once exceeded, the oldest empty session entries are pruned oldest-first and the pruning is logged loudly (a `warn`) so overflow degrades observably rather than silently. See the `extractionBreaker*` / `extractionRetry*` settings under **Local LLM**.

## Extraction Guardrails

| Setting | Default | Description |
|---------|---------|-------------|
| `extractionDedupeEnabled` | `true` | Skip extraction if the same buffer was already extracted recently |
| `extractionSourceGroundingEnabled` | `true` | Keep extracted facts, profile updates, and questions only when supported by observed source turns; disable to preserve legacy behavior |
| `extractionDedupeWindowMs` | `300000` | Dedup window in milliseconds (default 5 minutes) |
| `extractionMinChars` | `40` | Minimum buffer character count to trigger extraction |
| `extractionMinUserTurns` | `1` | Minimum user turns in buffer before extraction |
| `extractionMaxTurnChars` | `4000` | Truncate each turn to this many chars before sending to LLM |
| `extractionMaxFactsPerRun` | `12` | Cap on facts extracted per LLM call |
| `extractionMaxEntitiesPerRun` | `6` | Cap on entities extracted per LLM call |
| `extractionMaxQuestionsPerRun` | `3` | Cap on curiosity questions generated per LLM call |
| `extractionMaxProfileUpdatesPerRun` | `4` | Cap on profile update statements per LLM call |
| `beforeResetTimeoutMs` | `2000` | Max time (ms, clamped to `[100, 30000]`) to wait for a reset-triggered flush before returning control to the host. Operators running a local LLM for extraction often want this higher — a 7B model on CPU can take 2–5s per extraction, and the default can abort the queued follow-up flush before it completes. See issue #549 for the error-vs-debug log-level behavior around these aborts. |

## Memory Subjects (issue #2372)

Subject says *whom* a memory is about — `user` (preferences, relationships,
moments, commitments) or `agent` (procedures, principles, tool-usage lessons,
debugging strategies). Scope says where a memory lives; subject is what
decides where it may safely go.

| Setting | Default | Description |
|---------|---------|-------------|
| `subjectClassification.enabled` | `false` | Stamp `subject` on new memories: deterministic category defaults with an optional extractor token for fact/decision-like facts. Off = no field written and behavior byte-identical to before. |
| `subjectGuard` | `"warn"` | Promotion guard for `user`-subject (or unstamped — fail closed) memories into shared layers (`team-project`, `server-shared`, team spaces). `"warn"` promotes with a recorded warning, `"enforce"` rejects naming the `--allow-user-subject` override, `"off"` disables. Deliberately defaults on while classification defaults off, so enabling classification later warns without a second flag flip. |
| `promotionCandidates.minAccessCount` | `3` | `accessCount` threshold that counts as a reuse signal for `remnic promotion-candidates` / `engram.promotion_candidates`. Reinforcement (`reinforcement_count > 0`) or Memory Worth (`mw_success > mw_fail`) also qualify. |

Invalid values are rejected, never silently defaulted: a non-object
`subjectClassification`, an unrecognized `subjectGuard`, or a negative
`promotionCandidates.minAccessCount` fails config parsing.

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
| `oramaCjkSegmentation` | `true` | Segment space-free scripts (CJK/Thai) into character n-grams in the Orama lexical index (issue #2187) |
| `remoteSearchBaseUrl` | `http://localhost:8181` | Remote search service URL |
| `remoteSearchApiKey` | `(none)` | Remote search API key |
| `remoteSearchTimeoutMs` | `30000` | Remote search request timeout |

See [Search Backends](search-backends.md) for detailed configuration and comparison.

## External compiled wikis

`externalWikis` registers read-only compiled knowledge trees for explicit,
on-demand search. Configuring a root does not add its files to memory storage,
QMD, hot facts, or default recall. See [External wiki search](external-wikis.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `externalWikis` | `[]` | Configured external wiki roots. |
| `externalWikis[].id` | required | Stable lowercase id matching `[a-z0-9][a-z0-9_-]{0,63}`. |
| `externalWikis[].rootDir` | required | Absolute path or `~/` path outside `memoryDir`. |
| `externalWikis[].enabled` | `true` | Include this root in explicit external wiki searches. |
| `externalWikis[].label` | unset | Optional display label. |
| `externalWikis[].pagesDir` | `"wiki"` | Root-relative directory containing markdown concept pages. |
| `externalWikis[].indexFile` | `"INDEX.md"` | Root-relative catalog file. |
| `externalWikis[].indexInQmd` | `false` | Reserved dedicated-index flag; filesystem search remains available. |
| `externalWikis[].includeInDefaultRecall` | `false` | Must remain `false`; `true` is rejected. |

```json
{
  "externalWikis": [
    {
      "id": "engineering",
      "rootDir": "/srv/knowledge/engineering",
      "label": "Engineering knowledge"
    }
  ]
}
```

## Retrieval & Recall Budget

| Setting | Default | Description |
|---------|---------|-------------|
| `recallBudgetChars` | `maxMemoryTokens * 4` | **Character headroom for assembled recall context.** The default keeps the old four-characters-per-token capacity for Latin text. Recall assembly also enforces `maxMemoryTokens` with the shared script-aware estimator, so wide-script content stays within the token cap. |
| `recallProfileMaxRatio` | `0.3` | Maximum fraction of `recallBudgetChars` available to the behavioral profile. The profile truncates at a line boundary so query-specific memory results can claim the remaining budget. Set to `1` to disable the share cap. |
| `maxMemoryTokens` | `2000` | Token cap enforced during recall assembly and used to derive `recallBudgetChars` when that setting is absent. **Prefer setting `recallBudgetChars` directly** when you need a custom character cap. |
| `recallMaxConcurrentPerPrincipal` | `4` | Maximum concurrent recalls executed per principal (issue #1906); recalls beyond the cap queue FIFO. `0` = unlimited; set `1` to restore exact serialization. |
| `recallSingleFlightEnabled` | `true` | Coalesce identical concurrent recalls for the same principal into a single in-flight execution (issue #1906); each caller still receives its own cloned response. Set `false` to restore per-request execution. |
| `recallCoreDeadlineMs` | `75000` | **Per-section deadline for optional core recall providers.** `entity-retrieval` and `verbatim-artifacts` scan the memory tree, which can take minutes on a large or network/bind-mounted store; when one exceeds this budget the section is dropped, logged as `timeout(<ms>)` in the recall section metrics, and signalled to stop, while the rest of the recall still returns (issue #2291). Lower it (for example `5000`) when recall is consumed by a **synchronous** prompt-injection hook that cannot wait. `0` disables the bound. **The effective value is capped at 80% of the request budget still remaining when the section starts** — see the note below. |
| `recallEnrichmentDeadlineMs` | `25000` | Shared budget for the deferred enrichment sections assembled after the core phase. `0` disables the bound. |
| `recallOuterTimeoutMs` | `75000` | Outer ceiling for a whole recall request; on breach the recall is aborted and fails rather than degrading. `0` disables the bound. |
| `qmdEnabled` | `true` | Use QMD for hybrid search |
| `qmdCollection` | `openclaw-engram` | QMD collection name |
| `externalWikis` | `[]` | External compiled-wiki roots for on-demand search. Each item requires `id` and an absolute or `~/` `rootDir`; optional fields are `enabled`, `label`, `pagesDir`, `indexFile`, `indexInQmd`, and the false-only `includeInDefaultRecall` guard. |
| `wikiMergeIntoRecall` | `false` | Reserved guard for external compiled wikis. `true` is rejected; use on-demand wiki search instead. |
| `qmdMaxResults` | `8` | Final result cap after over-scanning and ranking (fetch size may be larger) |
| `qmdColdTierEnabled` | `false` | Query a secondary cold QMD collection after hot recall misses; generic recall never reads archive records |
| `qmdColdCollection` | `openclaw-engram-cold` | QMD collection name used for cold-tier recall |
| `qmdColdMaxResults` | `8` | Final result cap for cold-tier recall before merging into the normal ranking pipeline |
| `qmdPath` | `(auto)` | Absolute path to `qmd` binary (bypasses PATH) |
| `qmdSupportedVersion` | `2.5.3` | Highest QMD version this Remnic build will auto-install |
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
| `recallBudgetChars` | `maxMemoryTokens * 4` | Hard character headroom for assembled recall context (final safety trim before system prompt injection). When unset, the parser derives four characters per `maxMemoryTokens` token for Latin-script headroom, and recall assembly enforces `maxMemoryTokens` with the shared script-aware estimator. |
| `recallProfileMaxRatio` | `0.3` | Maximum fraction of the final recall character budget available to the behavioral profile; set to `1` to disable the share cap |
| `recallPipeline` | `(built-in ordered defaults)` | Ordered section controls for recall assembly, including per-section caps and knobs |
| `recallDirectAnswerEnabled` | `false` | Opt in to the direct-answer retrieval tier (issue #518). When enabled, the tier runs in observation mode: it annotates recall tier explain data without short-circuiting the QMD path. See [Retrieval Explain](./retrieval-explain.md). |
| `recallDirectAnswerTokenOverlapFloor` | `0.55` | Minimum query↔memory token-overlap ratio required for direct-answer eligibility. Set to `0` to disable the gate. |
| `recallDirectAnswerImportanceFloor` | `0.7` | Minimum calibrated importance score required for direct-answer eligibility. Set to `0` to disable the gate. `verificationState: "user_confirmed"` bypasses this check. |
| `recallDirectAnswerAmbiguityMargin` | `0.15` | If the second-best candidate scores within this ratio of the top, direct-answer defers to the hybrid tier. |
| `recallDirectAnswerEligibleTaxonomyBuckets` | `["decisions","principles","conventions","runbooks","entities"]` | Taxonomy category IDs eligible for direct-answer routing. Set to `[]` to disable the gate without unsetting `enabled`. |
| `recallStateViews` | `false` | Opt in to state-aware recall views (issue #1952). On change-intent queries ("when did", "used to", "switched", "changed" and conjugations), recall admits a superseded memory when its successor is also in the candidate set, labels rows `current`/`historical`/`transition`, and renders historical rows with a `[superseded <date> by <id>]` prefix. A superseded row never renders without its successor. Exact `false`/`0`/`"false"` disable; non-change queries and the disabled flag keep output byte-identical. The MCP `recall` tool also accepts a per-call `stateView` boolean that ORs with this flag. #2859 pair semantics: pairs reconcile before the user cap/MMR (orphan removal never underfills; a predecessor admitted with its successor counts as ONE evidence packet toward the cap), reverse chains derive from the successor `supersedes` back-pointer, chain identities are namespace-qualified (identical ids across namespaces never cross-anchor), and asOf labels use the temporal validity boundary (`invalidAt`, `supersededAt` only as legacy fallback), not the write-time stamp. |
| `recallStandingBlock` | `false` | Opt in to the prefix-cache-stable standing memory block (issue #2971): a byte-stable index over pinned/high-value memories that hosts inject before per-turn recall so the LLM prefix cache survives across turns. The builder refuses clock/date/counter content at build time (a changed word at the prefix front reprices the whole cache). Exact `false`/`0`/`"false"` disable. Default false keeps recall output byte-identical; the builder ships in `@remnic/core` now and recall-path injection lands in a later wiring slice. |
| `standingBlockFreshDays` | `14` | Days a memory stays in the standing block's full-text fresh band (counted from its last content change) before it compresses to a short recognition hook. |
| `standingBlockMaxChars` | `2048` | Hard character budget for the standing memory block. Pinned lines that cannot fit refuse the build rather than truncate. |
| `recallRecognitionTier` | `false` | Opt in to the full-index recognition tier (issue #2975): namespaces whose recognition index is present and at or under `recognitionIndexMaxEntries` recall by recognizing against the whole compact index (one model call names the relevant ids) instead of vector search; absent or oversized indexes fall back to vector search deterministically, and a failing recognizer degrades loudly (labeled `recognizer_unavailable`) to vector search. Exact `false`/`0`/`"false"` disable. Default false keeps recall byte-identical; the deterministic tier machinery ships in `@remnic/core` now and recall-path wiring lands in a later slice. |
| `recognitionIndexMaxEntries` | `500` | Inclusive entry threshold for the full-index recognition tier: a namespace's recognition index with at most this many entries engages recognition; more entries route to vector search. |
| `hotMemoriesCacheEnabled` | `true` | Serve `readAllMemories()` from a version-keyed in-process cache of the full parsed corpus (issue #1902), eliminating repeated full-corpus disk scans on the recall hot path. Cross-process coherence is preserved by an on-disk corpus version sentinel; single-file writes patch the cache in place. Set `false` to force disk scans on memory-constrained hosts (behavior then matches the pre-#1902 scan path). Version invalidation is the primary coherence mechanism; `hotMemoriesCacheTtlMs` bounds staleness from external edits. |
| `hotMemoriesCacheTtlMs` | `60000` | Max age (ms) a hot-cache entry is served before a fresh disk scan (issue #1902). The version sentinel gives immediate coherence for writers that go through StorageManager or the corpus-bump helper, but direct filesystem edits (manual, git checkout, external tools) don't bump it; this TTL bounds how long such an edit stays stale. Set `0` to disable the TTL (version invalidation only; max performance for pure-daemon deployments with no external edits). |

**Prefix-cache stability (issue #2971).** A standing memory block keeps the
system prompt prefix byte-identical between turns so provider prefix caches
stay warm; measured on a local OpenAI-compatible server, an identical
4k-token prefix reprices at 0.14 s vs 0.68 s cold, and one changed word at
the front costs the whole cache. Three rules keep it stable: the block
carries no clock, date, or counter (the builder refuses one at build time);
hosts rebuild it only when the memory store changes, never per turn; and
hosts order the prompt standing block first, then per-turn dynamic recall,
then any content that ticks (personas carrying a clock). Line order is band
rank then id, so appending a memory never moves existing lines.

**Effective core section deadline.** A section budget only helps if it expires
*before* the request ceiling that cancels everything, and sections start after
planning and namespace resolution — so the budget is resolved when each section
starts, against the request budget still left at that moment. When
`recallCoreDeadlineMs > 0` and the request is bounded, the effective value is
`min(recallCoreDeadlineMs, floor(remaining * 0.8))`, where `remaining` is
`recallOuterTimeoutMs` minus the time the request has already spent. With both
defaults at `75000` a section starting immediately gets **60000**; one starting 20
seconds in gets **44000**. Raising `recallCoreDeadlineMs` past that share has no
effect — raise `recallOuterTimeoutMs` too. The effective value is what appears as
`deadlineMs` in the recall section metric log, so the number in force is always
observable. Either bound set to `0` is left alone: `recallCoreDeadlineMs: 0`
leaves the sections unbounded, and `recallOuterTimeoutMs: 0` (unbounded request)
means there is no remainder to reserve headroom against, so the configured
`recallCoreDeadlineMs` applies verbatim. A request already over budget degrades
its optional sections immediately.

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
| `maxResults` | `number` | `memories` / `episodic-context` sections; cap injected result/episode count |
| `recentTurns` | `number` | `entity-retrieval` section only; transcript follow-up window |
| `maxTurns` | `number` | `transcript` / `episodic-context` sections (episodic: max raw turns per episode) |
| `maxTokens` | `number` | `transcript` section only |
| `lookbackHours` | `number` | `transcript` / `summaries` section only |
| `maxCount` | `number` | `summaries` section only |
| `topK` | `number` | `conversation-recall` section only |
| `timeoutMs` | `number` | `conversation-recall` section only |
| `maxPatterns` | `number` | `compounding` section only |

### Recall Budget Tuning

The recall budget controls how much context Remnic injects into each agent prompt. Getting this right is critical — too small and memories are silently truncated; too large and you waste context window space.

**How it works (v9.0.66+):** Remnic assembles recall context in pipeline section order (shared-context → profile → entity retrieval → knowledge index → ... → memories → transcripts → summaries). The budget-aware assembler reserves space for the `memories` section so earlier sections cannot fully exhaust the budget. However, the reservation is minimal (heading-sized). If the total budget is too small, earlier sections still crowd out memory content.

**Common pitfall:** The default character budget is `maxMemoryTokens * 4` = **8,000 chars**. Recall assembly also enforces the separate `maxMemoryTokens` cap with the shared script-aware estimator, so wide-script content uses its full token allowance. Set both `recallBudgetChars` and `maxMemoryTokens` when you need a larger budget for English-heavy context.

**Recommended values:**

| Model context window | Suggested `maxMemoryTokens` | Suggested `recallBudgetChars` | Reasoning |
|---------------------|-----------------------------|-------------------------------|-----------|
| 8K–16K tokens | `4000` | `16000` | Tight budget; consider capping profile via `recallPipeline` |
| 32K–128K tokens | `8000`–`16000` | `32000`–`64000` | Room for all sections including memories |
| 200K+ tokens (Claude Opus/Sonnet, GPT-5) | `16000`–`32000` | `64000`–`128000` | Generous budget; 16K–32K tokens is a small fraction of context |

**Example config for large-context models:**

```jsonc
{
  "maxMemoryTokens": 16000,
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

## Span-Mode Extraction

| Setting | Default | Description |
|---------|---------|-------------|
| `extraction.spanMode` | `"off"` | `"off"` (default) — extraction generates full content restatements as before. `"shadow"` — request span offsets AND content; materialize + compare and log agreement telemetry, but persist the generated content unchanged (zero behavior change; use to evaluate on live traffic). `"on"` — persist materialized frame+span content (verbatim source slice plus a ≤15-word frame), falling back per fact to the generated frame when a span fails validation. Spans are validated against a hash of the exact per-turn text the model saw (offset drift is rejected), materialized before sanitize/grounding/dedup, and never persisted as offsets. Unrecognized values are rejected at config parse (bench-gated feature, issue #2333). |

## Coding Knowledge

| Setting | Default | Description |
|---------|---------|-------------|
| `codingKnowledge.enabled` | `false` | Master gate for Track A coding-knowledge surfaces. Off (default) means no Track A surface fires. |
| `codingKnowledge.decisionRecords` | `true` | Decision-record surfaces and standing decision briefing titles. Effective only under the master gate. |
| `codingKnowledge.architectureCard` | `true` | Architecture-card build/refresh and briefing injection. Effective only under the master gate. |
| `codingKnowledge.sessionDelta` | `true` | Last-seen-head persistence and delta briefing line. Effective only under the master gate. |
| `codingKnowledge.architectureCardLlmSummary` | `false` | Opt-in LLM summary pass on the architecture card. Effective only under the master and card gates. |
| `codingKnowledge.structuralProvider` | `"none"` | Structural-context provider selection (`"none"`, `"subprocess"`, `"native"`). |
| `codingKnowledge.structuralProviderCommand` | `""` | Subprocess binary path for `"subprocess"` provider. |
| `codingKnowledge.codegraphTools` | `false` | Enable codegraph tools. Effective only under the master gate. |
| `codingKnowledge.codegraphDbDir` | `""` | Storage directory override for codegraph database. |

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
| `recallPlannerLlmEnabled` | `false` | Opt in to **LLM-based** recall planning (issue #1367). When off, recall mode is decided by the regex heuristic. When on, `recallPlannerModel` classifies recall intent via the gateway/fallback LLM chain (provider-agnostic) and falls back to the heuristic on timeout/error. Requires `recallPlannerEnabled`. See [Heuristic vs LLM planning](architecture/retrieval-pipeline.md#heuristic-vs-llm-planning-issue-1367-option-c). |
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

## Dependency-aware supersession propagation (issue #2326)

| Setting | Default | Description |
|---------|---------|-------------|
| `dependencyPropagation.enabled` | `false` | Enable bounded one-hop revalidation of active memories that depend on a superseded or invalidated memory. |
| `dependencyPropagation.linkTypes` | `["supports","follows"]` | Link types used to find dependents. `references` is valid but opt-in. |
| `dependencyPropagation.maxDependents` | `10` | Maximum active dependents revalidated per event. `0` disables propagation. |
| `dependencyPropagation.timeoutMs` | `20000` | Maximum duration, in milliseconds, of the single batched revalidation call. |
| `dependencyPropagation.dryRun` | `false` | Discover and revalidate dependents, but do not write supersession changes. |

The parser accepts boolean-like strings such as `"false"`, `"0"`, `"no"`, and `"off"`. It rejects malformed blocks, link arrays, booleans, and integers.

## v8.3 Lifecycle Policy Engine

| Setting | Default | Description |
|---------|---------|-------------|
| `lifecyclePolicyEnabled` | `true` | Enable lifecycle scoring + transitions + retrieval weighting. Default-on since issue #686; set `false` to fully disable lifecycle behavior. |
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
| `activeContextTransformLlmEnabled` | `false` | Permit `method=llm` SUMMARY plans; `auto` degrades to deterministic when off (issue #2347). |
| `activeContextMaxMessages` | `200` | Max messages in one active-context snapshot (hard cap 1000). |
| `activeContextMaxSnapshotChars` | `200000` | Max content chars in one active-context snapshot (hard cap 1000000). |
| `activeContextSummaryMaxTokens` | `512` | Max output tokens for one SUMMARY replacement (hard cap 4096). |
| `activeContextMinRetainedMessages` | `3` | Floor on messages retained after a plan applies (hard cap 50). |
| `activeContextPlanTtlMinutes` | `15` | Plan and retained-snapshot TTL in minutes (hard cap 1440). |
| `activeContextRetentionMaxBytes` | `1000000` | Max bytes for the adapter-local retained source snapshot (hard cap 10000000). |
| `compressionGuidelineLearningEnabled` | `false` | Enable adaptive compression guideline learning loop. |
| `maxProactiveQuestionsPerExtraction` | `2` | Hard cap on proactive self-questions per extraction (`0` disables). |
| `proactiveExtractionTimeoutMs` | `2500` | Hard timeout for proactive question generation plus bounded answer synthesis (`0` disables the second pass). |
| `proactiveExtractionMaxTokens` | `900` | Token budget applied to each proactive extraction sub-call (`0` disables the second pass). |
| `proactiveExtractionCategoryAllowlist` | unset | Optional category allowlist for proactive second-pass writes; when set, lower-confidence or off-category proactive facts are dropped before persistence. |
| `proactiveExtractionSkipWhenLocalLlmBusy` | `true` | Skip the optional proactive second pass when the local LLM background lane is already busy, instead of queueing behind an in-flight extraction and losing its shorter deadline (issue #2011). `false` always attempts the second pass. |
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
- `proactiveExtractionSkipWhenLocalLlmBusy`:
  - default on; skips the optional proactive pass when the local LLM background lane is already running or queueing an extraction
  - avoids arming a short deadline the queued pass would lose on a saturated single-lane host (issue #2011); the base extraction is always kept
  - only applies when the local LLM is the active extractor (the cloud fallback path has no single-lane saturation)

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

Route all Remnic LLM calls through the OpenClaw gateway's agent model chain instead of Remnic's own `openaiApiKey`/`localLlm*` configuration. This lets you define a single fallback chain per agent persona in `openclaw.json` and reuse the gateway's provider credentials.

| Setting | Default | Description |
|---------|---------|-------------|
| `modelSource` | `gateway` for new OpenClaw installs; `plugin` otherwise | `gateway` delegates to a gateway agent's model chain; `plugin` uses Remnic's own openai/localLlm config |
| `gatewayAgentId` | `""` | Agent persona ID from `openclaw.json → agents.list[]` for primary LLM calls (extraction, consolidation, summarization). Falls back to `agents.defaults.model` if empty. |
| `fastGatewayAgentId` | `""` | Agent persona ID for fast-tier ops (rerank, entity summaries, compression guidelines). Uses `gatewayAgentId` chain when empty. |
| `taskModelChain` | _(unset)_ | Optional inline `{ "primary", "fallbacks": [] }` model chain for Remnic's background tasks (extraction, extraction judge, fact/profile/identity consolidation, summarization, semantic consolidation, calibration, causal consolidation). Resolves through gateway providers. When set, it overrides `gatewayAgentId`/`agents.defaults.model` for these tasks only. **Requires `modelSource: "gateway"`** — ignored (with a startup warning) in `plugin` mode. |
| `bridgeMode` | `embedded` | OpenClaw bridge mode (issue #2120). `embedded` boots the full in-process orchestrator. `delegate` backs memory injection, turn observe, lifecycle flushes, the support passport gateway model route, and the memory-slot capability (prompt builder, memory runtime, flush plan, public artifacts) with a running standalone Remnic daemon over HTTP and skips the embedded orchestrator. `auto` picks `delegate` only when a healthy same-host daemon reports the SAME `memoryDir`, and stays `embedded` otherwise. The `REMNIC_BRIDGE_MODE` env var overrides this key. A failed daemon preflight falls back to `embedded`. Tool/CLI registration and heartbeat/dreams surfaces remain embedded-only in delegate mode. |
| `bridgeHealthTimeoutMs` | `10000` | Total timeout in milliseconds for the OpenClaw delegate preflight. The plugin probes the cheap authenticated liveness route first and uses the remaining budget for the detailed health route only when an older daemon returns 404. |

When `modelSource` is `gateway`:

- `localLlmEnabled` and the direct OpenAI client are bypassed for primary LLM dispatch — all LLM calls flow through `FallbackLlmClient` with the configured agent chain
- Extraction and consolidation start on the configured gateway chain directly; the historical "falling back to gateway" wording only applies when Remnic is still in `plugin` mode
- The existing `openaiApiKey`, `model`, and `localLlm*` settings are ignored for LLM dispatch but retained as config for backward compatibility; `OPENAI_API_KEY` is not inherited in gateway mode
- `localLlmFast*` settings are also bypassed when `fastGatewayAgentId` is set
- **Reranking** uses the `fastGatewayAgentId` chain (or `gatewayAgentId` if fast is unset) instead of the local LLM — this can dramatically reduce rerank latency when the fast chain points at a cloud provider

#### Task-specific model chain (`taskModelChain`)

By default, gateway-mode background work — extraction, the extraction judge, fact/profile/identity consolidation, summarization, semantic consolidation, calibration, and causal consolidation — shares the `gatewayAgentId` persona chain, or `agents.defaults.model` when no persona is set. That ties lightweight memory tasks to whatever chain the main agent uses, which is often larger/pricier than these tasks need. (The one exception: `semanticConsolidationModel: "fast"` keeps using `fastGatewayAgentId` — an explicit fast-tier choice is honored over `taskModelChain`.)

Set `taskModelChain` to give those tasks their own cheap/fast chain **without** defining a persona or touching `agents.defaults.model`:

```jsonc
{
  "modelSource": "gateway",
  "taskModelChain": {
    "primary": "zai/glm-4.7-flash",
    "fallbacks": ["fireworks/accounts/fireworks/models/glm-5p1"]
  }
}
```

Notes:

- Models resolve through the same `models.providers` auth/routing as everything else — only the chain differs.
- `taskModelChain` takes precedence over `gatewayAgentId` for these tasks; the main agent persona is unaffected.
- A reachable `agents.defaults.model` is appended as an implicit last resort to a `taskModelChain` only, so an exhausted task chain never blocks a flush. Persona/default chains are never augmented this way.
- It **only applies in `gateway` mode.** In `plugin` mode it is ignored and Remnic logs a startup warning. Plugin-mode users who hit non-OpenAI model-ID failures at the direct client should switch to `modelSource: "gateway"` and use `taskModelChain` (see issue #1365).
- A present-but-malformed value (missing `primary`, wrong types) is rejected at config-parse time rather than silently ignored.

#### Codex subscription provider (`codex-subscription`)

Built-in provider (issue #2784) that runs extraction and consolidation LLM
calls through the `codex` CLI, authenticated by your Codex subscription
login — no OpenAI API key and no codex-openai-proxy. Reference it in any
gateway-mode model chain:

```jsonc
{
  "modelSource": "gateway",
  "taskModelChain": {
    "primary": "codex-subscription/gpt-5.5"
  }
}
```

Behavior:

- Credentials come exclusively from `codex login` (ChatGPT account). The
  provider never reads, accepts, or logs tokens; an `apiKey` in the provider
  config is rejected with a pointer to `codex login`.
- Requests run sandboxed and ephemeral (`codex exec` with tools, hooks,
  plugins, memories, and web search disabled), so extraction cannot touch
  your machine and transcript text cannot cause browsing.
- Ambient `OPENAI_API_KEY` / `OPENAI_BASE_URL` are stripped from the child
  environment so the subscription login — not metered API auth — is used.
- Optional provider overrides via `models.providers["codex-subscription"]`:
  `executable` (or `REMNIC_CODEX_EXECUTABLE` env), `reasoningEffort`
  (`low` | `medium` | `high` | `xhigh`, default `medium`), and
  `retryOptions.timeoutMs` (positive integer; the request deadline when the
  caller does not set one — an explicit call timeout always wins). The
  deadline covers the login precheck and the exec subprocess as one budget,
  including waits on a login check another request already started: each
  request times out on its own budget without cancelling the shared check.
- Not logged in → the provider fails fast with `codex login` guidance; an
  expired or revoked session fails with re-auth guidance. Timeouts surface
  as `TimeoutError` and survive the model chain (a sole/last
  `codex-subscription` model propagates the typed error instead of an empty
  result); caller cancellations keep their original abort reason. A cached
  login is revalidated whenever the Codex auth store changes on disk, so a
  later API-key login cannot be masked by an earlier ChatGPT cache entry.
- Relative `HOME`/`CODEX_HOME` values resolve against the daemon's working
  directory before either subprocess starts (same rule as the executable
  path), so the login precheck and the exec child always see the same auth
  home. Detached Codex child process groups are tracked by the owning
  runtime's runner. The owning server or plugin runtime invokes
  `terminateActiveCodexSubscriptionChildren` and `beginCodexSubscriptionShutdown`
  on its own runner at shutdown,
  so stopping one Remnic instance cannot kill another instance's in-flight
  subscription requests. A SIGKILL timer starts before orchestrator drain.
  The provider does not install process signal
  listeners or call `process.exit`.
- A host or benchmark run that registers its own `codex-cli` transport
  always wins; Remnic registers its subprocess transport only when the seam
  is free. The core default process runner does not override a
  runtime-owned runner.

### Setup

1. **Define providers** in `agents/main/agent/models.json` with the endpoints and credentials you want Remnic to use (e.g., `fireworks`, `zai`, `anthropic`, `lmstudio`).

2. **Create agent personas** in `openclaw.json → agents.list[]`:

```jsonc
{
  "id": "engram-llm",
  "default": false,
  "name": "Remnic LLM Chain",
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
  "name": "Remnic Fast LLM Chain",
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

3. **Configure Remnic** in `openclaw.json → plugins.entries.openclaw-remnic.config`:

```jsonc
{
  "modelSource": "gateway",
  "gatewayAgentId": "remnic-llm",
  "fastGatewayAgentId": "remnic-llm-fast"
}
```

4. **Restart the gateway** for changes to take effect.

### How the fallback chain works

When a primary model call fails (timeout, HTTP error, empty response), `FallbackLlmClient` tries each fallback in order. The chain stops at the first successful response.

Provider lookup checks the explicit `models.providers` config first, then falls back to the gateway's materialized `models.json` (`~/.openclaw/agents/main/agent/models.json`), which contains all providers including built-in ones registered by gateway plugins (e.g., `openai-codex` with OAuth, `google-vertex`, `github-copilot`). This means any provider the gateway knows about — including OAuth-based providers — can be used in Remnic's model chain without additional configuration.

### API key resolution

Provider auth is resolved using OpenClaw's native runtime. Remnic first tries the gateway's `getRuntimeAuthForModel()` function, which handles all provider-specific transforms — OAuth token exchange (for `openai-codex`, `github-copilot`, etc.), base URL overrides, profile-based credentials, and secret reference formats — using the same codepath the gateway uses for its own agent sessions.

If the gateway runtime isn't available (e.g., running outside the gateway process), Remnic falls back to `resolveProviderApiKey()` for secret ref resolution, then checks the `PROVIDER_NAME_API_KEY` environment variable before skipping the provider.

This means your existing auth setup works automatically — OAuth providers, API keys, 1Password, Vault, env vars, and plain-text keys all work without special Remnic configuration.

### Switching back

Set `modelSource` to `plugin` (or remove it) to restore the original behavior where Remnic uses its own `localLlm*` and `openaiApiKey` settings.

## Local LLM / OpenAI-Compatible Endpoint

| Setting | Default | Description |
|---------|---------|-------------|
| `localLlmEnabled` | `false` | Enable Remnic's local/compatible endpoint when `modelSource` remains `plugin` |
| `localLlmUrl` | `http://localhost:1234/v1` | Base URL for endpoint |
| `localLlmModel` | `local-model` | Model ID |
| `localLlmApiKey` | `(unset)` | Optional API key |
| `localLlmApiKeyEnv` | `(unset)` | Optional environment-variable name for a local API key; if it is unset, local auth remains unset so read-only CLI commands can load config |
| `localLlmHeaders` | `(unset)` | Extra HTTP headers |
| `localLlmAuthHeader` | `true` | Send `Authorization: Bearer` header when key set |
| `taskLlmTimeoutMs` | `180000` | Timeout for the gateway/task LLM chain. In `modelSource: "gateway"` this is the primary extraction timeout. See [Task LLM naming](task-llm-naming.md). |
| `taskLlmFallback` | `true` | When the local LLM path fails or is unavailable, use the gateway/task LLM chain. |
| `localLlmFallback` | `true` | Legacy alias for `taskLlmFallback`. Read only when `taskLlmFallback` is absent. |
| `localLlmTimeoutMs` | `180000` | Timeout for a single attempt at a primary local extraction/consolidation call. 5xx retries and their backoff can push one logical completion past this value. Also sizes the HTTP connection's header/body inactivity budget, so values above 300s take effect instead of being capped by undici's default (issue #2148). Exception: when the host process installs its own global dispatcher (a `ProxyAgent`, `MockAgent`, or other custom transport), Remnic leaves it in place rather than displacing it, and that dispatcher's own budget — undici's 300s default unless it was built with a wider one — governs instead. Raising this value past 300s on such a setup requires widening the host dispatcher too. Legacy alias for `taskLlmTimeoutMs` on the gateway/task chain when that key is absent. |
| `localLlmRetry5xxCount` | `1` | Retry count for transient 5xx responses from the local endpoint |
| `localLlmRetryBackoffMs` | `400` | Base backoff in milliseconds for local endpoint retries |
| `localLlm400TripThreshold` | `5` | Consecutive 4xx responses before the local endpoint is temporarily tripped |
| `localLlm400CooldownMs` | `120000` | Cooldown window before retrying a tripped local endpoint |
| `extractionRetryEnabled` | `true` | Master gate for extraction retry backoff + circuit breaker. When `false`, restores pre-change behavior exactly: the extractor is called on every triggered observe with no gate (config-only rollback, no redeploy). |
| `extractionRetryScheduleMs` | `[60000, 300000, 1800000, 7200000]` | Per-fingerprint exponential backoff schedule (1m, 5m, 30m, 2h), indexed by attempt. After a failed extraction, that fingerprint is not re-attempted until its backoff elapses. |
| `extractionRetryMaxBackoffMs` | `21600000` | Upper bound (6h) on any single backoff interval, and the long-park interval once `parse_empty` exhausts its attempt cap. |
| `extractionRetryJitterRatio` | `0.2` | Multiplicative jitter (±ratio) applied to each backoff interval to avoid synchronized retries. |
| `extractionParseEmptyMaxAttempts` | `3` | Attempts for a `parse_empty` fingerprint (provider responded but produced no parseable output) before it is long-parked for `extractionRetryMaxBackoffMs`. Still never marked processed. |
| `extractionBreakerFailureThreshold` | `5` | Consecutive provider failures before the process-level circuit breaker opens and short-circuits extraction for all fingerprints. |
| `extractionBreakerCooldownMs` | `300000` | Breaker open cooldown (5m) for transient provider failures (429/5xx/network). A half-open probe after cooldown closes the breaker on one success. |
| `extractionBreakerAuthCooldownMs` | `1800000` | Breaker open cooldown (30m) for auth/config failures (401/403 or "no models configured"), which open the breaker immediately instead of hot-looping. |
| `localLlmMaxContext` | `(unset)` | Override context window size |
| `localLlmFastEnabled` | `false` | Enable a separate fast local tier for short planner/rerank/helper calls |
| `localLlmFastModel` | `""` | Optional model id for the fast local tier |
| `localLlmFastUrl` | `http://localhost:1234/v1` | Optional dedicated base URL for the fast local tier |
| `localLlmFastTimeoutMs` | `15000` | Timeout for the fast local tier |
| `localLlmDisableThinking` | `true` | Suppress thinking on supported local backends for extraction and other terse structured operations. Short extraction can opt back in through `localLlmThinkingThresholdChars`. Consolidation and the fast tier are unaffected. |
| `localLlmThinkingThresholdChars` | `3000` | Enable thinking for local extraction only when the transcript is shorter than this length. Set to `0` to keep thinking suppressed for every extraction. Consolidation is unaffected. |
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
- `--apply` only mutates Remnic-managed transcript/checkpoint artifacts.
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
- Sentence-transformers embeddings are opt-in via `REMNIC_FAISS_ENABLE_ST=1` (legacy `ENGRAM_FAISS_ENABLE_ST=1` still works). Without that env var, the sidecar uses deterministic hash embeddings for low-friction local setups.

## v9.1 Evaluation Harness Foundation

| Setting | Default | Description |
|---------|---------|-------------|
| `evalHarnessEnabled` | `false` | Enable Remnic's benchmark/evaluation harness bookkeeping |
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
| `memoryInjectionDefenseMode` | `custom` | Packaged core defense: `off`, `fencing`, `quarantine`, or `layered`; `custom` preserves the independent flags below |
| `originAuthorityEnabled` | `false` | Gate the recall-time authority fence for origins in `untrustedOrigins`; origin metadata is always recorded |
| `injectionScreenEnabled` | `true` | Screen candidate facts with deterministic rules and queue findings as `pending_review` |
| `untrustedOrigins` | `["tool_output", "import:*", "unknown"]` | Origin classes that receive the authority fence during recall rendering |
| `memoryRedTeamBenchEnabled` | `false` | Enable typed `memory-red-team` benchmark packs and status accounting for poisoning-defense regression suites |
| `harmonicRetrievalEnabled` | `false` | Enable harmonic retrieval and construct abstraction nodes after extraction |
| `abstractionAnchorsEnabled` | `false` | Enable cue-anchor storage, status, and retrieval |
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
- When `benchmarkBaselineSnapshotsEnabled` is on, Remnic also tracks typed `baselines/*.json` artifacts under the eval store and surfaces the latest stored baseline snapshot in `openclaw engram benchmark-status`.
- When both eval flags are on, live recall also writes `shadow/YYYY-MM-DD/<trace-id>.json` records with hashes, counts, chosen source, and recalled memory IDs.
- `openclaw engram benchmark-validate <path>` validates a manifest JSON file or a pack directory with a root `manifest.json`.
- `openclaw engram benchmark-import <path> [--force]` validates first, then imports into `benchmarks/<benchmarkId>/`.
- `openclaw engram benchmark-baseline-snapshot --snapshot-id <id>` captures a versioned baseline snapshot of the latest completed benchmark runs under `baselines/<snapshotId>.json`.
- `openclaw engram benchmark-baseline-report --snapshot-id <id>` compares the current eval store against a named stored baseline snapshot, emits both JSON and markdown summaries, and fails when pass rate, shared metrics, coverage, or eval artifact validity regress relative to that snapshot.
- The required GitHub `eval-benchmark-gate` workflow uses the committed fixture baseline snapshot at `tests/fixtures/eval-ci/store/baselines/required-main.json` as its stable PR-gating reference.
- `openclaw engram benchmark-ci-gate --base <dir> --candidate <dir>` compares two eval-store roots and fails when pass rate, shared metrics, or benchmark coverage regress.
- When `objectiveStateRecallEnabled` is on, Remnic can inject a separate `## Objective State` recall section sourced from the objective-state store.
- When `causalTrajectoryMemoryEnabled` is on, Remnic can persist typed causal chains into a separate store for later graph/retrieval slices.
- When `causalTrajectoryRecallEnabled` is on, Remnic can inject a separate `## Causal Trajectories` recall section sourced from the causal-trajectory store.
- When `actionGraphRecallEnabled` is also on, each newly recorded causal trajectory emits deterministic `goal -> action -> observation -> outcome -> follow_up` edges into the causal graph without changing retrieval behavior yet.
- When `trustZonesEnabled` is on, Remnic can persist provenance-bearing records into separate `quarantine`, `working`, and `trusted` storage tiers.
- When `quarantinePromotionEnabled` is also on, Remnic exposes an explicit promotion path that blocks direct `quarantine -> trusted` jumps and requires anchored provenance before promoting risky working records into `trusted`.
- When `trustZoneRecallEnabled` is also on, Remnic injects a separate `## Trust Zones` recall section sourced from `working` and `trusted` trust-zone records while keeping `quarantine` records out of recall by default.
- When `memoryPoisoningDefenseEnabled` is also on, `openclaw engram trust-zone-status` reports deterministic provenance trust scores derived from source class plus `sourceId` / `evidenceHash` / `sessionKey` anchors so later poisoning defenses can build on explicit signals instead of hidden heuristics.
- With both `memoryPoisoningDefenseEnabled` and `quarantinePromotionEnabled` enabled, risky `working -> trusted` promotions now require at least one independent non-`quarantine` corroborating record with anchored provenance and overlapping `entityRefs` or `tags`.
- When `memoryRedTeamBenchEnabled` is on, benchmark manifests can also declare `benchmarkType: "memory-red-team"` plus `attackClass` and `targetSurface`, and `openclaw engram benchmark-status` reports red-team pack counts and unique attack metadata.
- With harmonic retrieval enabled, each extraction creates one episode node and one topic node per extracted entity. The anchor flag controls cue-anchor writes.
- Construction includes only active persisted facts. It excludes facts held for review.
- Each fact contributes up to three model cues. Its `entityRef` and `validAt` add deterministic entity and date cues.
- Construction upserts records atomically in each writable namespace. Consolidation removes cue anchors that reference no live node.
- Construction failures emit a warning and never fail fact persistence. Disabling harmonic retrieval prevents node writes. Disabling anchors prevents anchor writes.
- When the harmonic retrieval section is enabled in the recall pipeline, Remnic can inject a dedicated `## Harmonic Retrieval` section that explains which abstraction nodes matched and which cue anchors contributed.
- When `episodicContextEnabled` is on and LCM is enabled, recall appends a `## Source Episodes` section: the top recalled facts' structured `sources` provenance is resolved to archive turn ranges, overlapping ranges in one session merge into a single episode, and each episode injects its raw user/assistant turns (cleaned, per-turn 300-char cap). Set `maxResults` or `maxTurns` to `0` in the `episodic-context` `recallPipeline` entry to disable the section.
- Use `openclaw engram abstraction-node-status` to inspect node storage, `openclaw engram cue-anchor-status` to inspect anchor counts and invalid index records, and `openclaw engram harmonic-search <query>` to preview blended harmonic retrieval matches.
- Cue anchors created before per-source attribution contribute only while every source memory on their target node remains active. New extraction upserts add exact attribution. A mixed active/inactive legacy node fails closed until extraction rebuilds its anchors.
- When `verifiedRecallEnabled` is on, Remnic can inject a separate `## Verified Episodes` recall section sourced from recent memory boxes, but only when each surfaced box still cites at least one non-archived source memory whose `memoryKind` remains `episode`.
- Use `openclaw engram verified-recall-search <query>` to preview verified episodic recall matches, including verified memory counts, matched fields, and cited episodic memory IDs.
- When `semanticRulePromotionEnabled` is on, `openclaw engram semantic-rule-promote --memory-id <id>` can promote an explicit `IF ... THEN ...` rule from a non-archived episodic memory into a durable `rule` memory with lineage, `sourceMemoryId`, and duplicate suppression.
- When `semanticRuleVerificationEnabled` is on, Remnic can inject a separate `## Verified Rules` recall section sourced from promoted `rule` memories, but only when each surfaced rule still clears a provenance-aware effective-confidence threshold after re-checking its `sourceMemoryId`.
- When both `creationMemoryEnabled` and `commitmentLedgerEnabled` are on, Remnic can persist explicit commitment ledger entries and expose them through `openclaw engram commitment-status` and `openclaw engram commitment-record`.
- When `commitmentLifecycleEnabled` is also on, Remnic can transition commitment states with `openclaw engram commitment-set-state`, report overdue/stale/decay-eligible counts in `openclaw engram commitment-status`, and apply overdue-expiry plus resolved-entry cleanup through `openclaw engram commitment-lifecycle-run`.
- When both `creationMemoryEnabled` and `resumeBundlesEnabled` are on, Remnic can persist explicit typed resume bundles, inspect them with `openclaw engram resume-bundle-status`, write manual shells with `openclaw engram resume-bundle-record`, and assemble bounded bundles from transcript recovery plus recent objective state, work products, and open commitments with `openclaw engram resume-bundle-build`.
- When `creationMemoryEnabled` is on, Remnic can persist explicit work-product ledger entries and expose them through `openclaw engram work-product-status` and `openclaw engram work-product-record`.
- When both `creationMemoryEnabled` and `workProductRecallEnabled` are on, Remnic can inject a separate `## Work Products` recall section sourced from the typed work-product ledger and expose `openclaw engram work-product-recall-search <query>` for reuse previews.
- When `memoryUtilityLearningEnabled` is on, Remnic can persist typed downstream utility telemetry for promotion and ranking decisions, inspect the resulting event ledger with `openclaw engram utility-status`, record explicit benchmark/operator utility observations through `openclaw engram utility-record`, and learn bounded offline promotion/ranking weights through `openclaw engram utility-learn` with the persisted learner snapshot visible in `openclaw engram utility-learning-status`.
- When `promotionByOutcomeEnabled` is also on and a learner snapshot exists, Remnic applies bounded learned utility multipliers to ranking heuristic deltas and bounded promotion/demotion threshold nudges to tier migration without re-reading raw utility telemetry on the hot path.
- Use `openclaw engram semantic-rule-verify <query>` to preview verified semantic-rule matches, including verification status, effective confidence, and the cited source memory id.
- Future slices will add automated benchmark runners on top of this store and gate format.

### Memory-poisoning hardening (#1955)

The hardening path has three layers:

1. Origin metadata is always recorded on writes; `originAuthorityEnabled` gates only the recall-time authority fence.
2. The recall renderer wraps content from origins selected by `untrustedOrigins` in a data-only authority fence.
3. The deterministic injection screen sends suspicious candidate facts to `pending_review` when `injectionScreenEnabled` is `true`. It never drops a candidate.

Set `memoryInjectionDefenseMode` to apply the measured H5 treatment directly in core Remnic:

- `off`: fence off, screen off;
- `fencing`: fence on, screen off;
- `quarantine`: fence off, screen on;
- `layered`: fence on, screen on;
- `custom`: preserve `originAuthorityEnabled`, `injectionScreenEnabled`, and `untrustedOrigins`.

Packaged modes fence every attacker-controlled boundary (`user`, `tool_output`, `connector:*`, `import:*`, and `unknown`) unless `untrustedOrigins` is explicitly set. No bench package is loaded at runtime.

Run `remnic security audit-memory` to inspect stored memories for origin gaps, authority-sensitive content, and injection-screen findings. The command is read-only unless its command help states otherwise.

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
| `sharedContextAllowBindingAuthority` | `false` | Allow shared-context items to carry binding authority. Writers must still request it explicitly. MCP and OpenClaw tool surfaces can request `binding`; the write is rejected unless this flag is true |
| `sharedContextEnabled` | `false` | Enable shared cross-agent context. Accepts boolean and CLI string forms (`true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`); a deployment already carrying the string `"true"` (previously ignored by the strict parser) now activates on upgrade. An unrecognized value warns and stays off — malformed input never silently enables |
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
| `semanticMerge` | — | Must be an object when present; a present non-object value (`semanticMerge: true`, `"enabled"`, an array, `null`, `undefined`) is rejected at parse time. Only an absent block falls back to the defaults below. Presence is own-property presence throughout this block: a key inherited through the prototype chain never applies, and a present-but-`undefined` value is rejected rather than treated as absent. |
| `semanticMerge.enabled` | `false` | Judge-mediated merge-on-write (issue #2330). Master gate; with it off there is no lookup and no judge call — byte-identical behavior to before the feature. |
| `semanticMerge.minSimilarity` | `0.8` | Lower bound of the merge band `[minSimilarity, semanticDedupThreshold)`. Must be **strictly below** `semanticDedupThreshold` (which owns the near-duplicate skip path above it); an equal or higher value is rejected at config parse time whenever merging is enabled or this key is set explicitly. A pre-existing config that lowered `semanticDedupThreshold` to at or below `0.8` and never configured `semanticMerge` keeps starting — the disabled feature performs no band lookup. |
| `semanticMerge.maxCandidates` | `3` | Maximum in-band neighbors offered to the merge judge. Must be an **integer ≥ 0** — non-integer values (`0.5`, `3.7`) are rejected at parse time rather than floored, and a **present-but-unparseable** value (`"abc"`, an object, `null`, `undefined`, `NaN`, `Infinity`) is rejected too instead of silently falling back to the default: only an absent key means `3`. **Set to `0` to disable merging entirely** — the short-circuit happens before any embedding lookup. |
| `semanticMerge.categories` | `["fact","preference","decision","relationship","skill"]` | Memory categories eligible for merging; must be an array of mergeable category names — every entry must be one of `fact, preference, entity, decision, relationship, principle, commitment, skill, rule`. Anything else (a malformed array, an unknown entry such as `facts`, or an episodic/immutable category) is rejected at parse time with the valid list, never silently replaced with the defaults — an unknown entry would silently disable merging for every category because no extracted memory can match it. The episodic and immutable categories (procedure, reasoning trace, moment, correction) never merge regardless of this list and cannot be listed. |
| `semanticMerge.shadowMode` | `false` | Decision-only rollout mode: run the lookup and judge, log the would-merge verdict, then always create. Never mutates an existing memory. |
| `noveltyGateEnabled` | `false` | Write-path embedding-density novelty gate (issue #1953). Off = unchanged persist path. |
| `noveltyAddThreshold` | `0.55` | Novelty score ≥ this value is ADD (skip semantic/LLM dedup). |
| `noveltyNoopThreshold` | `0.15` | Novelty score ≤ this value is NOOP (drop; do not write contentHashIndex). Between the two thresholds is UNCERTAIN. |
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

### Judge-mediated merge-on-write (issue #2330)

Semantic dedup only ever *rejects*: a paraphrase below `semanticDedupThreshold`
is written as a brand-new fragment, so near-duplicate variants accumulate in the
`[0.80, 0.92)` band. `semanticMerge` closes that gap by turning an in-band match
into a create-or-update decision:

1. Query the same namespace-scoped lookup semantic dedup uses, keeping only
   neighbors inside `[minSimilarity, semanticDedupThreshold)` that share the
   candidate's category, carry the identical provenance connector — or are
   unscoped when the fact itself is unscoped (stricter than the novelty and
   near-duplicate gates, which keep the broad unscoped neighborhood, because
   a merge rewrites the neighbor's body: an unscoped merge into a
   connector-owned target would rewrite it while its `sourceConnector`
   frontmatter kept naming that connector) — and are still `active`.
2. Ask an LLM merge judge (routed like the extraction judge — local model first,
   then the gateway fallback chain) whether the pair describes the same
   underlying concept. `contradicts` and `create` verdicts fall through to the
   normal write, leaving contradiction detection and temporal supersession
   untouched.
3. On a `merge` verdict, validate the returned target id against the candidate
   snapshot the target as a page version with trigger `semantic-merge`
   — staged WITHOUT pruning the version history; the cap-based prune runs
   only after the COMPLETE content-and-metadata transaction commits (both
   compare-and-swaps), so an attempt that loses either CAS race — or whose
   frontmatter patch is rejected and rolled back — never discards the
   oldest rollback point —
   then update the memory **in place** (same id and path) with a
   compare-and-swap against the exact body the judge was shown, then stamp
   `derived_via: merge`, bump `reinforcement_count`, restamp `contentHash`
   from the same canonical form the normal write path hashes — the sanitized
   RAW body with the configured citation form stripped off the judge-composed
   merged text first, so a merged record's identity equals the ordinary write
   of the equivalent raw fact and exact dedup never fragments — and append
   the incoming fact's provenance `sources` through
   the conditional frontmatter API — a second compare-and-swap, so provenance
   can only ever land on the merged body this run committed — resync the
   fact-content hash index, reindex, and, when verbatim artifacts are enabled
   and the fact's category and confidence qualify, store the incoming
   extraction's text as a verbatim artifact anchored to the merged target —
   the same anchor the normal write would have stored; this artifact write is
   the merge's FINAL durable effect, so a failing artifact write is logged
   and skipped (the committed target stays fully discoverable) — and commits
   merged body WITH the incoming extraction's citation marker appended
   (lifted from the same cited string the artifact stores, so memory and
   artifact share one timestamp), so incoming claims stay attributed even
   when the judge's merged text embeds the target's older citation; quoting
   or copying the combined body carries both attributions. A lower incoming
   confidence downgrades the merged record to `min(incoming, target)`
   (restamped with the tier that score maps to; an unreadable value
   bypasses the merge), so a low-confidence extraction can never leave a
   merged record — or a copy promoted from it — scoring above what the
   create path would have stored for that fact alone.
   When intent routing is on, the same patch restamps
   `intentGoal`/`intentActionType`/`intentEntityTypes` by recomputing them
   from the committed merged body — the record's own category and tags plus
   the RAW pre-citation body, the same `inferIntentFromText` call the normal
   write runs — so the record's intent routing always describes the body it
   holds instead of the target's stale pre-merge values (an empty entity-type
   list clears a stale field, exactly as a fresh write would omit it; with
   routing off the fields are untouched). A successful merge also enqueues
   the surviving target — committed merged body as content — into the batch's
   harmonic construction pass, so a merge-only extraction still derives its
   episode/abstraction nodes and cue anchors; two facts merging into the
   same target in one batch coalesce to a single entry (the latest committed
   body replaces the earlier cumulative snapshot, cue anchors union across
   merges). The returned `persistedIds` stay new-fragment only, while the
   surviving target joins the batch's internal temporal/tag index refresh —
   resolved through the cold-aware id lookup when the hot-tier scan misses
   it, so a `cold/` target's row refreshes too — so event-order queries see
   the merged tokens without a full corpus rebuild.
   When multi-graph memory is enabled, a successful merge also builds the
   surviving target's graph edges — entity, time, and causal — through the
   same `buildGraphEdge` call the create path runs, derived from the
   re-read committed record (its category, entity ref, relative path, and
   raw pre-citation merged body — the cold-aware committed path, never a
   hot-only path-map fallback), replacing the target's prior generated
   edges in EVERY enabled graph type — entity from-side, time and causal
   inbound — instead of re-appending them (one shared routine; if the
   replacement build fails, the removed edges are restored, so failure
   leaves either the old or the new complete set; the whole
   remove-and-rebuild is revision-guarded, so a writer committing a newer
   body mid-rebuild aborts the stale install instead of clobbering the
   newer merge's edges), and enrolling the target
   at the END of the batch's thread episode list — deduped first when
   already present, so the merge is the thread's latest event — so later
   facts in the same extraction chain time/causal adjacency through it.
   The target is ALSO persisted in the thread's durable episode-set file
   MOVE-TO-END — a target already earlier in the durable list moves to the
   tail, matching the batch-local ordering — so a target that entered the
   thread only through a merge, or merged again later, is still at the tail
   when the next extraction reloads the thread — without widening the public
   `persistedIds` contract, which stays new-fragment-only. All of it is
   fail-open like the create path's graph block; and a `preference`-category
   merge records its
   `preference_affinity` event in the behavior-signal ledger, so
   graph-mode recall and runtime-policy learning observe claims accepted
   through a merge.
4. A merge carries only content, category, sources, and connector. A fact
   that also carries extraction metadata the merge cannot preserve —
   structured attributes, an entity ref, bi-temporal bounds, effective
   validity bounds the incoming fact does not carry identically (the merged
   body inherits the target's `valid_at`/`invalid_at`, so a target with
   `invalid_at` never merges and a target with `valid_at` merges only with an
   incoming fact carrying the same bound — otherwise a fresh unbounded claim
   would inherit an expired bound and drop out of normal recall the moment it
   merges), tags the target lacks, a higher importance, stronger provenance, a
   subject classification
   whose effective value (absent = the least-privileged `user`, the same
   default the subject guard applies) differs from the target's effective
   subject (so an unclassified fact extracted with classification disabled is
   never merged into an `agent`-labeled memory that reinforcement could then
   promote), a computed episode/note `memoryKind` that differs from the
   target's committed kind (the merged record keeps the target's kind — the
   classification that drives episode-cache membership and the episode-only
   verification and promotion paths — so a time-specific fact is never filed
   as a note and a stable note never rides the episode-only paths; a fact
   extracted with classification disabled carries no kind and still merges), a
   `toolScoped: true` classification the target lacks (a
   tool-scoped fact never widens into an unscoped target; an already-scoped
   target keeps its stricter flag), or an untrusted authority origin (per
   `untrustedOrigins`) offered to a trusted-origin target (the merged body
   renders under the target's origin at recall, so such a merge would hand
   untrusted text the target's unfenced authority; mismatches that never
   reduce fencing — equal origins, or trusted content into an untrusted
   target — still merge, so legacy targets with no `origin` stamp keep
   receiving user-origin facts) — is created through the normal write
   instead, so metadata, access scope, and authority are never silently
   discarded or escalated. A would-be target that already has promoted
   shared/profile copies (memories linked back by `sourceMemoryId`) also
   bypasses the merge: those copies are reconciled only by the normal write's
   promotion step, so merging would strand them at the pre-merge body. Only
   copies that are still ACTIVE count — a superseded or archived copy serves
   no body, so it does not block later judge-approved merges into the target.
   The
   copy scan inspects every known promotion layer and the shared namespace
   regardless of current write authorization, so a permission revoked after a
   copy was promoted cannot hide that copy from the scan. A successful merge
   into a target with no promoted copy yet still runs the shared/profile
   promotion the create path would have performed, anchored to the merged
   target id and fail-open like the create path — but never off an
   unpatched provenance record: a degraded merge (see step 5) yields no
   promotion payload at all, so nothing trust-elevating is copied from a
   record still holding its pre-merge trust metadata. Once the merged-body
   copy lands, any concurrently promoted pre-merge copy of the same target
   (same `sourceMemoryId`, older body — the pre-mutation copy probe can race
   a concurrent writer) is superseded with `supersededBy` naming the current
   copy, so a stale and a current copy cannot both stay active across
   namespaces. The promotion payload is
   derived solely from the re-read committed record — body, category,
   confidence, tags, entity ref, structured attributes, importance, intent
   fields, memory kind, bi-temporal bounds (`validAt`, `invalidAt`,
   `observedAt`, `eventTimeSource`), provenance strength, claim spans,
   subject, write-provenance label, and the tool-scope marker with its owning
   `sourceConnector` — so no field on the promotion path reads the incoming
   extraction, and a copy is authority-fenced exactly like the
   source its `sourceMemoryId` names (an unstamped legacy target promotes
   as `unknown`, the fence's least-privilege default; a target whose temporal
   bounds or attributes the incoming fact omits keeps them on the copy; a
   `toolScoped: true` target's copy stays withheld from the shared
   namespace even when the merged body no longer matches the content
   heuristics that earned the marker). When memory linking is on and the
   caller suggested navigation links for the incoming fact, a successful
   merge attaches them to the target's committed `links` (deduped on
   target+type; a suggestion naming the surviving target itself is
   dropped rather than becoming a self-edge, since memory linking and the
   merge judge both search on the incoming content and suggest the target
   itself) in the same conditional frontmatter patch, so the
   relationships the create path would have stamped on the new fact stay
   traversable from the target instead of being lost.
   Promotion eligibility gates on the committed target's own confidence —
   the downgraded `min(incoming, target)` value where a lower incoming
   confidence merged in. A target that cannot ground the promotion after
   the merge commits (deleted, its body replaced by another writer, or
   archived/superseded by a concurrent lifecycle operation — promoting
   from a retired record would resurrect it) skips the promotion
   fail-open — the merge itself stands. The
   merge lookup also honors the batch's embedding-outage short circuit (its
   own lookup failures arm it for the remaining facts) and the novelty
   gate's `add` decision: when either bypasses semantic dedup for a fact, no
   merge lookup runs either.
5. Any doubt — no in-band candidate, fabricated target id, empty or oversized
   merged content, judge error or timeout, inactive target, a target another
   writer changed after it was judged, a metadata, subject, or authority-origin
   guard refusal, a target with promoted copies, failed
   snapshot or update — creates the
   new fact exactly as before. The unsafe default is always *create*, and the
   merged entry is recoverable from the page-version snapshot. When a content
   update commits but its provenance patch fails, storage is re-read before
   anything is reported: if the target still holds this run's merged body it is
   restored to the pre-merge text and the outcome falls back to create, and if
   another writer has already replaced that body the restore is skipped — that
   writer's content is never clobbered — and the outcome is likewise a create,
   because nothing of this merge remains. Only when the merged body is still
   present and cannot be restored, or the target cannot be read at all, is the
   outcome reported as a merge rather than a create, so the fact is still never
   written twice; the target then holds merged text without the incoming
   provenance and reinforcement metadata, the hash-index resync and reindex
   still run before that outcome is reported, no shared/profile promotion is
   built from that record, and the error log names the page
   version to recover from.

Merging requires page versioning (`versioningEnabled`): without it there is no
pre-merge snapshot to roll back to, so the merge is refused and the fact is
created instead.

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
| `graphPathScoring.enabled` | `false` | Penalize graph-expanded results that use invalid intermediate memories |
| `graphPathScoring.invalidNodePenalty` | `0.2` | Multiplier applied once per invalid intermediate memory. Range `(0, 1]` |
| `graphPathScoring.includePathInProvenance` | `true` | Include graph path node ids in provenance output |

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

## Bounded JSONL State (issue #1910)

Append-only JSONL files under `<memoryDir>/state/` are size-bounded **by
default** so they cannot grow without limit and cannot cross V8's ~512MB string
ceiling. Setting a byte knob (`memoryLifecycleLedgerCompactBytes` /
`recallImpressionsRotateBytes`) to `0` disables that control for its file (`0`
is honored, never coerced to a default); a file whose bound is disabled can
once again grow without limit. Keep the defaults, or any non-zero bound, to
retain the guarantee.

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryLifecycleLedgerCompactBytes` | `67108864` | Auto-compact `state/memory-lifecycle-ledger.jsonl` when it exceeds this many bytes, triggered off the debounced maintenance path. The compactor archives the original verbatim under `archive/memory-lifecycle-ledger/<stamp>/` before an atomic rewrite. Set `0` to disable (never coerced to a default). Default 64MB. |
| `memoryLifecycleLedgerCompactMinIntervalMs` | `21600000` | Minimum interval between auto-compactions of the lifecycle ledger, so the heavy rebuild cannot run back-to-back. Minimum enforced at `60000` ms. Default 6 hours. |
| `recallImpressionsRotateBytes` | `33554432` | Rotate `state/recall_impressions.jsonl` to `.1..N` once it exceeds this many bytes. The active file name and format are unchanged; only historical rows move to archives. Rotated files are excluded from offline-sync push. Set `0` to disable. Default 32MB. |
| `recallImpressionsRotateKeep` | `5` | Number of rotated recall-impression archives to keep (`.1 .. .N`). Minimum enforced at `1` when rotation is enabled. Default 5. |
| `projectionRebuildEnabled` | `true` | Scheduled rebuild of `state/memory-projection.sqlite` off the debounced maintenance path (issue #2119): the projection has no incremental writer, so without this it silently freezes at the last manual rebuild and timeline/browse consumers fall back to full-ledger reads. Boolean-like strings coerced (`"false"` is false). |
| `projectionRebuildIntervalMs` | `21600000` | Cadence for the scheduled projection rebuild. Finite integer milliseconds, minimum `60000`; string forms are coerced and invalid or sub-minimum values are rejected at parse time (never silently floored). Skipped when the on-disk projection meta `rebuiltAt` is younger than the interval, so operator cron rebuilds and daemon restarts both suppress redundant work. Default 6 hours. |

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
| `emitLegacyTools` | conditional (see below) | Advertise legacy `engram_*`/`engram.*` MCP tool aliases alongside canonical `remnic_*` names. On a fresh install the schema default is `false`, so only `remnic_*` is advertised; the value is sticky-`true` when legacy connector entries already exist on disk (so upgrades keep working). Set explicitly to override, or use `REMNIC_EMIT_LEGACY_TOOLS`. Tools stay callable under both names regardless. (issue #1427) |
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

## Action-site failure gate (issue #2382)

Delivers failure memories at the moment an action is proposed, instead of in the
turn-start preamble. The gate is advisory only: it never blocks or delays an
action, and every error path fails open. It removes a known repeated-failure
mode; it does not improve task completion.

| Setting | Default | Description |
|---------|---------|-------------|
| `actionGate.enabled` | `false` | Master gate. When `false` (or any of `"0"`, `"no"`, `"off"`) there are no gate lookups, no matching, and no suppression bookkeeping on any path. |
| `actionGate.timeoutMs` | `50` | Hard latency cap in milliseconds for one gate evaluation (`1`–`5000`). Overrun fails open with an `ERROR_FAIL_OPEN` audit record and the action proceeds. |
| `actionGate.maxAdvisoriesPerTurn` | `3` | Advisories injected per turn, deduplicated per memory per turn (`0`–`20`). **`0` disables injection and all gate lookups.** |

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
| `procedural.maintenance.enabled` | `false` | Master gate for the library-health maintenance job (issue #2370): merge near-duplicate active procedures, flag stale-tool procedures (`needsRepair`), retire failure-dominant or idle ones. Shadow-first: without `--apply`/`apply: true` the run only reports. |
| `procedural.maintenance.retireIdleDays` | `90` | Days without an access signal and with zero recorded outcomes before an active procedure retires as idle. **`0` disables idle-based retirement.** |
| `procedural.maintenance.retireMinOutcomes` | `5` | Minimum `mw_fail` before failure-dominant retirement is considered. |
| `procedural.maintenance.retireFailRatio` | `2` | `mw_fail` must exceed `mw_success × retireFailRatio` for failure-dominant retirement. |
| `procedural.maintenance.mergeEnabled` | `true` | Whether duplicate-cluster merging runs within the maintenance gate. |
| `procedural.skillProjection.enabled` | `false` | Project active procedures into host-native `skills/<slug>/SKILL.md` bundles during Codex materialization (issue #2369). Off by default. `remnic export skills` / `remnic import skills` are explicit user actions and work regardless of this gate. Only `status: active` procedures are ever projected. |
| `procedural.skillProjection.maxSkills` | `20` | Maximum projected bundles per materialization, newest procedure first. **`0` disables projection entirely.** |

## Session-end experience extraction (issue #2979)

At `session_end` the completed session's buffered turns are distilled — deterministically, no LLM — into at most ONE Situation/Approach/Reflect "experience episode": situation (the task shape, from the first substantive user turn), approach (what the agent tried), reflection (terminal outcome evidence; a failed session records the failure). Episodes are agent-subject `category: procedure` memories stored under `procedures/` with `status: pending_review` — a machine-derived write that never activates itself; promotion stays the operator's call. Writes go through the sealed salvage-mode envelope, dedupe per session key (a replayed `session_end` cannot double-write), honor the shared flush abort signal and deadline, and land in the session's resolved write namespace. A transcript with no task or no agent work yields nothing (`skippedReason: "insufficient_signal"`). After promotion, episodes compete in the existing `procedure-recall` slot and share `procedural.recallMaxProcedures`. With the gate on, a matching `experience_situation` can win a slot and renders as an `Experience.` preview, and promoted episodes also join procedure-mining input (same lookback and cluster rules as causal trajectories). With the gate off, session end still performs zero storage calls for this feature, recall does not inspect experience attributes, and miner input is byte-identical to the trajectory-only set.

| Setting | Default | Description |
|---------|---------|-------------|
| `sessionExperience.enabled` | `false` | Master gate for session-end episode extraction, the Experience preview path in procedure recall, and feeding promoted episodes into procedure mining. Default off; the `conservative` preset pins it `false`. With the gate off a session end performs zero storage calls for this feature — nothing is read, composed, or written — procedure recall does not inspect experience attributes, and miner input is byte-identical to the trajectory-only set. |

## Seed graduation (issue #2974)

A `pending_review` memory is a seed. It does not enter active recall on its own. When `seedGraduation.enabled` is true, the lifecycle policy pass graduates a seed to `active` after `minCorroborations` later memories from independent provenance restate it (token-coverage, no LLM). Same-session restatements, lineage descendants, and sessions whose recall-handle history contains the seed do not count. An independent later memory that restates the seed's core content with flipped negation polarity is a contradiction during the corroboration window: the seed is held — it never auto-graduates while the contradiction stands, even when the corroboration minimum is met — and demoting or superseding stays a reviewer verb through the existing contradiction-resolution surfaces. The pass summary reports the count as `contradictionHeld`. Promotion reuses `promoteWearableMemory` and stamps `graduatedBy`, `corroborationCount`, and `corroboratingMemoryIds`. Default off; the `conservative` preset pins it off. With the gate off the lifecycle pass makes zero extra storage calls for this feature.

| Setting | Default | Description |
|---------|---------|-------------|
| `seedGraduation.enabled` | `false` | Master gate. Default off; the `conservative` preset pins it `false`. |
| `seedGraduation.minCorroborations` | `2` | Independent later memories required before a seed graduates. Integer in `[1, 50]`. Invalid values throw at `parseConfig`. |


## Preference drift detection (issue #2371)

Covers the failure mode the agent-memory survey calls *stale preference reuse*: a `category: preference` memory keeps being injected at full prominence long after the last conversation that supported it. The contradiction scan and temporal supersession both need a new statement to arrive; this job looks instead at the *absence* of corroboration.

Per active preference older than `minAgeDays`, the scan gathers recent same-namespace evidence within `lookbackDays` (half-open `[start, end)` window) and classifies it:

- `corroborated` — recent evidence restates the preference. Apply mode stamps `lastCorroborated` and clears `driftState`.
- `stale` — the window held nothing either way. Apply mode stamps `driftState: stale`. No lifecycle change, no deletion.
- `drifted` — recent evidence points away from it (judge verdict `contradicts`). Apply mode opens one review-queue item with `kind: "preference-drift"`, rendered by the existing `review_list` / `review_resolve` surfaces. Resolution verbs: `keep` (stamps `lastCorroborated`), `supersede` (writes the corrected preference and retires the old one), `archive`.
- `skipped` — the classification could not be made honestly. `backend_unavailable` means the evidence lookup failed and the preference was **not** marked stale (§22: empty and failed are different outcomes). `verification_unavailable` means evidence exists but no LLM could judge it, so neither a positive nor a negative claim is recorded.

Nothing is ever auto-deleted or auto-superseded: drift is inference, and the least-privileged default for an inferred change to user state is to ask.

Surfaces: `remnic drift scan [--apply]`, MCP `remnic.preference_drift_scan` (alias `engram.preference_drift_scan`). Shadow-first — a run without `--apply` / `apply: true` writes nothing, not even the run marker.

| Setting | Default | Description |
|---------|---------|-------------|
| `driftDetection.enabled` | `false` | Master gate for classification and apply mode. With it off, the scan reports `skippedReason: "drift_disabled"` and recall is untouched. |
| `driftDetection.minAgeDays` | `60` | A preference younger than this many days is never a scan candidate. |
| `driftDetection.lookbackDays` | `45` | Evidence-gathering window, in days back from the run instant. |
| `driftDetection.maxCandidatesPerRun` | `25` | Cap on preferences classified per run. **`0` disables the scan** (`skippedReason: "scan_disabled"`). |
| `driftDetection.recallDamping` | `false` | When `true`, recall multiplies the rank score of `driftState: stale` preferences by `stalePenalty` in the same boost stage as the Memory Worth multiplier, on every recall branch. With it off, recall ordering is byte-identical to pre-#2371. |
| `driftDetection.stalePenalty` | `0.8` | Multiplier in `(0, 1]`. **`1` disables the effect** without flipping `recallDamping`. `0` is rejected — it would erase a memory from recall rather than damp it. |
| `driftDetection.annotateAfterDays` | `0` | Append a compact age note (for example `(stated 2026-01; not corroborated since)`) to an injected preference whose last corroboration is older than this many days. **`0` disables annotation.** The note is formatting-stage only and never mutates the stored memory. |

Invalid values are rejected, never silently defaulted: a non-object `driftDetection`, an unrecognized boolean-like string, a non-integer day count, or a `stalePenalty` outside `(0, 1]` all throw at `parseConfig`.

Frontmatter written by this job: `driftState` (`stale` | `drifted`) and `lastCorroborated` (ISO 8601). Both are derived provenance stamped after the fact, so — like `mw_success` / `mw_fail` — they are not part of the sealed write envelope.


## Deep recall (issue #2332)

Budgeted REFINE/EXPAND/STOP retrieval over the cue-anchor graph built during extraction (issue #2329). An opt-in slow surface for questions that warrant a thorough multi-hop search: each iteration an LLM policy sees the query, the working set, and the anchor-linked frontier, then rewrites the query (REFINE), follows frontier nodes (EXPAND), or stops (STOP). Expect seconds per query — that is the accepted trade, which is why this never runs on the `before_prompt_build` hot path.

Surfaces: MCP `engram.deep_recall` (canonical `remnic.deep_recall`), `POST /engram|remnic/v1/recall/deep`, and `remnic engram deep-recall <query> [--max-steps N] [--json]`. All three call the same `EngramAccessService.deepRecall` implementation and share one renderer. With `enabled` off, every surface returns a typed `error: "disabled"` refusal — an explicit error, not an empty success.

| Setting | Default | Description |
|---------|---------|-------------|
| `deepRecall.enabled` | `false` | Master gate for the whole surface. |
| `deepRecall.maxSteps` | `4` | Policy iterations. **`0` disables the loop** — the invocation returns seed results only, with no LLM calls. |
| `deepRecall.maxExpandPerStep` | `3` | Per-step cap on frontier nodes pulled into the working set. **`0` honors EXPAND but selects nothing.** |
| `deepRecall.maxResults` | `12` | Final working-set cap returned to the caller. **`0` returns an empty entry list.** |
| `deepRecall.stepTimeoutMs` | `10000` | Per policy-call timeout in ms. **`0` = no per-step timeout.** |
| `deepRecall.totalTimeoutMs` | `45000` | Whole-invocation wall-clock timeout in ms. **`0` = no overall timeout.** |

The `--max-steps` CLI flag and `maxSteps` request field are ceilings under the configured `maxSteps`; a value above the configuration is rejected, never silently clamped. Invalid values (non-object block, unrecognized boolean-like strings, non-integer or negative counts) throw at `parseConfig`. Timeout or budget exhaustion mid-loop returns the partial working set with `ok: true` and a `BUDGET_EXHAUSTED` trace tail; only a seed-search backend failure returns `ok: false` with `error: "backend_unavailable"` (§22: empty and failed are different outcomes).

## Recall navigation (issue #1956)

Session-scoped follow-up tools over results a recall already served: expand one served memory at a deeper disclosure level (chunk → section → raw) and traverse its typed frontmatter links — without re-running a search. An id is expandable only when one of the session's last `windowSnapshots` recall snapshots served it; unknown, expired, and foreign ids are rejected with a typed error naming the constraint, never silently reinterpreted. Every read resolves through the caller's resolved readable namespace, so navigation cannot cross namespaces even when a link's target id exists elsewhere.

Surfaces: MCP `engram.memory_expand` and `engram.memory_traverse` (canonical `remnic.*` aliases), `POST /engram|remnic/v1/memory/{expand,traverse}`, and `remnic navigate expand|traverse <memoryId> --session-key <key> [--json]`. All three call the same `EngramAccessService.recallNavigate` implementation and share one renderer. With `enabled` off, the MCP tools are absent from `tools/list` (not present-but-erroring) and the HTTP/CLI surfaces return a typed `error: "disabled"` refusal.

Every response is budget-capped against `recallBudgetChars` and reports `budget: {chars, used}`, per-item disclosure depth, and a per-disclosure token-spend summary aggregated by the same accounting recall X-ray uses.

| Setting | Default | Description |
|---------|---------|-------------|
| `recallNavigation.enabled` | `true` | Master gate. Read-only surface, so on by default; the `conservative` preset pins it `false`. |
| `recallNavigation.windowSnapshots` | `3` | How many of the session's most recent recall snapshots authorize an id. |
| `recallNavigation.maxNeighbors` | `10` | Ceiling for a traverse or entity-neighbor result count. Request `limit` values above it clamp; invalid values are rejected. |

Expansion must go strictly deeper than the chunk preview recall already served — a `chunk` target is refused with `not_deeper`. Traverse relations are the persisted link vocabulary plus the navigation set: `supports`, `contradicts`, `elaborates`, `causes`, `caused_by`, `supersedes`, `follows`, `references`, `related`; an unknown relation is rejected listing the valid ones.

Invalid config (non-object block, unrecognized boolean-like strings, out-of-range counts, unknown keys) throws at `parseConfig` (§24, §33).

## Extraction pipeline liveness (issue #2151)

Surfaces a checkable liveness watermark for the implicit extraction pipeline so a daemon that has not persisted an extraction in a long time is distinguishable from one that simply has nothing to extract (the §22 error-vs-empty principle at the pipeline level). Exposed on the authenticated `/health` payload (the `extraction` object), the `remnic doctor` `extraction_liveness` check, and `remnic stats`. When the pipeline is degraded, a single aggregated WARN is logged per staleness window rather than one line per failed extraction attempt. The `extraction` block reflects the daemon's single extraction pipeline, so `/health` returns the same block for every namespace argument. Its last-successful-extraction watermark is the newest value across the root and every distinct namespace store. If namespace enumeration or any metadata read fails, the watermark reports an explicit unreadable outcome instead of publishing a surviving store's timestamp as fresh. A buffer that cannot be read is likewise reported degraded with a distinct reason.

The `extraction` block includes `watermarkScope: "aggregate"`, surfaced on `/health`, in the `remnic doctor` check summary, and in `remnic stats`. Directly after daemon startup, a cold namespace-root cache yields `watermarkPending: true` until background enumeration completes; this normal warming state does not degrade liveness or consume the warning throttle.

| Setting | Default | Description |
|---------|---------|-------------|
| `extractionLiveness.enabled` | `true` | Master gate. Set to `false` (or `"0"`/`"no"`/`"off"`) to stop reporting the pipeline degraded on `/health`, in `remnic doctor`, and in `remnic stats`. |
| `extractionLiveness.staleWindowMs` | `86400000` | How stale the last-successful-extraction watermark may get (ms) before a **non-empty** buffer flags the pipeline degraded. Default `86400000` (24h). An empty buffer is never degraded. Must be a positive integer of milliseconds; a fractional or non-positive value is rejected rather than floored. |

## Replica divergence detection (issue #2149)

A daemon configured with peer URLs polls each peer's authenticated `/health` corpus watermark on an interval and flags per-namespace drift (file-count delta, newest-write age delta, or a digest mismatch at EQUAL file counts) on `/health` (the `replica` block) and in the `remnic doctor` `replica_divergence` check. The digest is a per-bucket file-count fingerprint, so it flags files redistributed across day/tier/category buckets but does NOT detect a same-count split-brain where every bucket keeps its count and only the file contents differ. Disabled by default; a daemon with no peers behaves exactly as before. An unreachable, timed-out, or non-2xx peer is reported as a distinct `unreachable`/`unknown` state, never conflated with `converged`. Detection only — reconciliation is tracked in issue #2150.

| Setting | Default | Description |
|---------|---------|-------------|
| `replicaPeers.enabled` | `false` | Master gate. Set to `true` to poll peers; when `false` (or `"0"`/`"no"`/`"off"`) no peer is contacted. |
| `replicaPeers.peers` | `[]` | Array of peer endpoints to poll. Must be an array; a non-array is rejected at parse time. |
| `replicaPeers.peers.url` | `(required)` | Base URL of the peer's agent-access HTTP server (http or https, `${ENV_VAR}` expansion supported). A non-http(s) or unparseable URL is rejected at parse time. The poller tries `GET /engram/v1/health` (the path this server serves) first, then `GET /remnic/v1/health` as a forward-compat fallback. |
| `replicaPeers.peers.token` | `(unset)` | Bearer token for the peer's authenticated `/health`. A literal string (with `${ENV_VAR}` expansion) or — under OpenClaw — a SecretRef object such as `{"source":"exec",...}` resolved lazily at poll time (not eagerly at config load) via the gateway secret resolver, exactly like `agentAccessHttp.authToken` (its `replicaPeers.peers.token.source` field selects the resolver). As with `agentAccessHttp.authToken`, SecretRef resolution is cached per resolver for the process lifetime (the shared issue #757 behavior), so a rotated peer secret is picked up on the next daemon restart. Never logged and never echoed into any report, `/health`, or doctor payload. |
| `replicaPeers.pollIntervalMs` | `300000` | How often each peer is re-polled (stale-while-revalidate TTL), in ms. Positive integer; a fractional or non-positive value is rejected rather than floored. Default `300000` (5 min). |
| `replicaPeers.requestTimeoutMs` | `10000` | Per-peer HTTP request timeout, in ms. Positive integer. Default `10000` (10s). |
| `replicaPeers.maxFileCountDelta` | `100` | Per-namespace memory-file-count difference beyond which a peer is flagged diverged. `0` flags any difference. Default `100`. |
| `replicaPeers.maxWatermarkAgeDeltaMs` | `900000` | Per-namespace newest-write timestamp gap (ms) beyond which a peer is flagged diverged. `0` flags any gap. This value doubles as the peer-census freshness bound (a peer whose newest `computedAt` is older than it is reported `unknown`/`peer_census_stale`); setting `0` selects the strictest divergence mode and disables that census-staleness gate rather than marking every peer stale. Default `900000` (15 min). |

Polling never runs inline on the health request path: a probe reads the last completed poll (with its timestamp) and a stale entry triggers a bounded background refresh (the corpus-watermark stale-while-revalidate idiom). The `replica` block on `/health` is filtered to the presenting token's namespace capabilities, so a namespace-restricted token never learns about namespaces it cannot see.

## Replica convergence conflict policy (issue #2150)

| Setting | Default | Description |
|---------|---------|-------------|
| `converge.conflictPolicy` | `newest-wins` | Selects how `remnic converge` resolves revisions that conflict. |
| `converge.peerRequestTimeoutMs` | `30000` | Per-request peer HTTP timeout (ms) for `converge plan/apply/watch`. Boot-scale namespaces (~100k files) can take over 30s to serve a manifest; raise this instead of watching fetches time out. Positive integer, clamped to `3600000`. The `--timeout <seconds>` CLI flag and the `REMNIC_CONVERGE_PEER_TIMEOUT_MS` env var override it (flag > config > env). |

Policy values:

- `newest-wins` selects the newer revision when both sides carry comparable timestamps. Delete-versus-modify conflicts require a durable per-path deletion timestamp; without one, apply stops before mutation. If two revisions tie or either timestamp is unavailable, apply also stops because Remnic cannot yet preserve both revisions at distinct durable identities.
- `manual` reports unresolved conflicts and stops before mutation.

The CLI `--conflict-policy <policy>` flag overrides `converge.conflictPolicy` for that invocation.
If neither is set, Remnic uses `newest-wins`.

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
| `offlineSyncExcludes` | `[]` | Extra offline-sync push-side exclude globs, additive to the built-in node-local state excludes (issue #1786) |
| `converge.conflictPolicy` | `newest-wins` | Default conflict policy for `remnic converge`; `--conflict-policy` overrides it per command |


## Schema-Complete Default and Recommended Settings

This appendix is flattened from the runtime config schema and the live `parseConfig({})` defaults so the page stays complete even when newer or advanced settings have not yet been expanded in the narrative sections above. Unless noted otherwise, the recommended value matches the shipped default.

| Setting | Default | Recommended |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback in plugin mode)` | unset when `modelSource` is `gateway`; set `false` for local-only plugin mode; otherwise explicit key or `OPENAI_API_KEY` env fallback |
| `openaiBaseUrl` | (unset) | (unset) |
| `llmBridgeClientConfigPath` | (unset) | (unset); parse into `backgroundGeneration` only |
| `backgroundGeneration.endpoint` | (unset) | (unset); hourly background generation only |
| `backgroundGeneration.token` | (unset) | (unset); generated loopback bearer |
| `backgroundGeneration.timeoutSeconds` | `120` | `120` |
| `backgroundGeneration.timeout_seconds` | `120` | `120`; generated-file alias |
| `model` | `gpt-5.5` | `gpt-5.5` |
| `reasoningEffort` | `low` | `low` |
| `supportPassport.enabled` | `false` | `false` until an owner chooses to enable What Helps Me |
| `supportPassport.trustedProxyAddresses` | `[]` | `[]` unless a listed reverse proxy overwrites or safely appends `X-Forwarded-For` |
| `triggerMode` | `smart` | `smart` |
| `bufferMaxTurns` | `5` | `5` |
| `bufferMaxMinutes` | `15` | `15` |
| `bufferSaveDebounceMs` | `3000` | `3000` |
| `consolidateEveryN` | `3` | `3` |
| `highSignalPatterns` | `[]` | `[]` |
| `maxMemoryTokens` | `2000` | `2000` |
| `memoryOsPreset` | (unset) | `balanced` |
| `qmdEnabled` | `true` | `true` |
| `qmdCollection` | `openclaw-engram` | `openclaw-engram` |
| `wikiMergeIntoRecall` | `false` | `false` (the only supported value) |
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
| `agentAccessHttp` | `{"enabled":false,"host":"127.0.0.1","port":4318,"maxBodyBytes":131072,"writeRateLimitMaxRequests":30,"writeRateLimitWindowMs":60000}` | `{"enabled":false,"host":"127.0.0.1","port":4318,"maxBodyBytes":131072,"writeRateLimitMaxRequests":30,"writeRateLimitWindowMs":60000}` |
| `agentAccessHttp.enabled` | `false` | `false` unless you need the local HTTP bridge |
| `agentAccessHttp.host` | `127.0.0.1` | `127.0.0.1` |
| `agentAccessHttp.port` | `4318` | `4318` |
| `agentAccessHttp.authToken` | (unset) | set explicitly whenever `agentAccessHttp.enabled=true` |
| `agentAccessHttp.maxBodyBytes` | `131072` | `131072` |
| `agentAccessHttp.writeRateLimitMaxRequests` | `30` | `30`; raise (e.g. `120`) for multi-agent deployments sharing one daemon (issue #1937) |
| `agentAccessHttp.writeRateLimitWindowMs` | `60000` | `60000` |
| `accessTrackingEnabled` | `true` | `true` |
| `accessTrackingBufferMaxSize` | `100` | `100` |
| `recencyWeight` | `0.2` | `0.2` |
| `boostAccessCount` | `true` | `true` |
| `recordEmptyRecallImpressions` | `false` | `false` |
| `recallPlannerEnabled` | `true` | `true` |
| `recallPlannerLlmEnabled` | `false` | `false` |
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
| `inlineSourceAttributionEnabled` | `false` | `false` |
| `inlineSourceAttributionFormat` | `[Source: agent={agent}, session={sessionId}, ts={ts}]` | `[Source: agent={agent}, session={sessionId}, ts={ts}]` |
| `inlineSourceAttributionFormatHistory` | `[]` | `[]` |
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
| `graphPathScoring.enabled` | `false` | `false` |
| `graphPathScoring.invalidNodePenalty` | `0.2` | `0.2` |
| `graphPathScoring.includePathInProvenance` | `true` | `true` |
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
| `contradictionLocalization.anchorEnabled` | `true` | Enable entityRef and category anchor candidates |
| `contradictionLocalization.anchorCandidates` | `5` | Maximum anchor candidates. `0` disables the anchor pass |
| `contradictionLocalization.searchCandidates` | `5` | Maximum QMD search candidates. `0` disables text search |
| `contradictionLocalization.maxCandidates` | `8` | Maximum merged candidates sent to the verifier |
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
| `taskLlmFallback` | `true` | `true` |
| `localLlmFallback` | `true` | `true` |
| `localLlmHomeDir` | (unset) | (unset) |
| `localLmsCliPath` | (unset) | (unset) |
| `localLmsBinDir` | (unset) | (unset) |
| `taskLlmTimeoutMs` | `180000` | `180000` |
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
| `maintenance.namespaceFanoutEnabled` / `maintenanceNamespaceFanoutEnabled` | `true` | When namespaces are enabled, allow background jobs to use the namespace catalog to discover dynamic project/team namespaces. |
| `maintenance.maxNamespacesPerCycle` / `maintenanceMaxNamespacesPerCycle` | `20` | Deterministic cap for each namespace-aware maintenance cycle. Default/shared/configured namespaces keep priority. |
| `maintenance.includeProjectNamespaces` / `maintenanceIncludeProjectNamespaces` | `true` | Include project namespaces discovered from the catalog when their live roots contain memory data. |
| `maintenance.includeBranchNamespaces` / `maintenanceIncludeBranchNamespaces` | `false` | Include branch namespaces in fanout. Off by default to avoid runaway branch maintenance. |
| `maintenance.includeTeamProjectNamespaces` / `maintenanceIncludeTeamProjectNamespaces` | `true` | Include team-project namespaces discovered from trusted scope/profile writes. |
| `maintenance.namespaceLockStaleMs` / `maintenanceNamespaceLockStaleMs` | `600000` | Stale threshold for per-job/per-namespace maintenance locks under `state/maintenance-locks/`. |
| `qmdAutoEmbedEnabled` | `false` | `false` |
| `qmdEmbedMinIntervalMs` | `3600000` | `3600000` |
| `qmdEmbeddingBacklogThreshold` | `1000` | `1000` |
| `qmdUpdateTimeoutMs` | `90000` | `90000` |
| `qmdUpdateMinIntervalMs` | `900000` | `900000` |
| `localLlmRetry5xxCount` | `1` | `1` |
| `localLlmRetryBackoffMs` | `400` | `400` |
| `localLlm400TripThreshold` | `5` | `5` |
| `localLlm400CooldownMs` | `120000` | `120000` |
| `extractionRetryEnabled` | `true` | `true` (set `false` to fully restore pre-change extraction behavior — the config-only rollback) |
| `extractionRetryScheduleMs` | `[60000, 300000, 1800000, 7200000]` | `[60000, 300000, 1800000, 7200000]` |
| `extractionRetryMaxBackoffMs` | `21600000` | `21600000` |
| `extractionRetryJitterRatio` | `0.2` | `0.2` |
| `extractionParseEmptyMaxAttempts` | `3` | `3` |
| `extractionBreakerFailureThreshold` | `5` | `5` |
| `extractionBreakerCooldownMs` | `300000` | `300000` |
| `extractionBreakerAuthCooldownMs` | `1800000` | `1800000` |
| `localLlmMaxContext` | (unset) | (unset) |
| `localLlmFastEnabled` | `false` | `false` unless you have a separate fast local tier |
| `localLlmFastModel` | `""` | `""` |
| `localLlmFastUrl` | `http://localhost:1234/v1` | `http://localhost:1234/v1` |
| `localLlmFastTimeoutMs` | `15000` | `15000` |
| `localLlmDisableThinking` | `true` | `true` (suppress thinking except short extraction selected by `localLlmThinkingThresholdChars`) |
| `localLlmThinkingThresholdChars` | `3000` | `3000`; set `0` to keep thinking suppressed for every extraction |
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
| `episodicContextEnabled` | `false` | `false` |
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
| `scopeProfiles` | `{}` | unset unless running a hosted multi-user/project-aware deployment |
| `defaultScopeProfile` | (unset) | unset unless a `scopeProfiles` entry should control implicit reads/writes |
| `teams` | `{}` | trusted team membership for `teamProject` scope profile layers |
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
| `sharedContextAllowBindingAuthority` | `false` | `false` unless writers need to publish binding-authority shared items (MCP and OpenClaw tools can request binding when this is true) |
| `sharedContextEnabled` | `false` | `false` unless you are actively using cross-agent memory sharing; a config already carrying the string `"true"` now activates it (string boolean forms are coerced, malformed values warn and stay off) |
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
| `lifecyclePolicyEnabled` | `true` | `true` (default-on since issue #686; set `false` to disable lifecycle scoring entirely) |
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
| `procedural.maintenance.enabled` | `false` | `false` until you have observed shadow reports (`remnic procedural maintain`) on your corpus; flip to `true` only when the proposals look right |
| `procedural.maintenance.retireIdleDays` | `90` | `90`; `0` disables idle-based retirement entirely |
| `procedural.maintenance.retireMinOutcomes` | `5` | `5` (raise for noisier corpora) |
| `procedural.maintenance.retireFailRatio` | `2` | `2` (require failures to outnumber successes 2:1) |
| `procedural.maintenance.mergeEnabled` | `true` | `true` within the maintenance gate |
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
| `oramaCjkSegmentation` | `true` | `true` |
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
| `hotMemoriesCacheEnabled` | `true` | `true` (set `false` only on memory-constrained hosts that cannot hold the parsed corpus in RAM) |
| `hotMemoriesCacheTtlMs` | `60000` | `60000` (60s external-edit safety net; set `0` for max perf on pure-daemon deployments with no manual/git edits, larger to tolerate more staleness) |
| `recallBudgetChars` | `8000` | `8000` |
| `recallPipeline` | `[{"id":"shared-context","enabled":false,"maxChars":4000},{"id":"profile","enabled":true,"consolidateTriggerLines":100,"consolidateTargetLines":50},{"id":"identity-continuity","enabled":false},{"id":"entity-retrieval","enabled":true,"maxChars":2400,"maxHints":2,"maxSupportingFacts":6,"maxRelatedEntities":3,"recentTurns":6},{"id":"knowledge-index","enabled":true,"maxChars":4000,"maxEntities":40},{"id":"verbatim-artifacts","enabled":false},{"id":"memory-boxes","enabled":false},{"id":"temporal-memory-tree","enabled":false},{"id":"objective-state","enabled":false,"maxResults":4,"maxChars":1800},{"id":"causal-trajectories","enabled":false,"maxResults":3,"maxChars":2200},{"id":"trust-zones","enabled":false,"maxResults":3,"maxChars":1800},{"id":"harmonic-retrieval","enabled":false,"maxResults":3,"maxChars":2200},{"id":"verified-episodes","enabled":false,"maxResults":3,"maxChars":1800},{"id":"verified-rules","enabled":false,"maxResults":3,"maxChars":1800},{"id":"work-products","enabled":false,"maxResults":3,"maxChars":1800},{"id":"memories","enabled":true,"maxResults":8},{"id":"episodic-context","enabled":false,"maxResults":2,"maxTurns":8,"maxChars":2400},{"id":"compression-guidelines","enabled":false},{"id":"native-knowledge","enabled":false,"maxResults":4,"maxChars":2400},{"id":"transcript","enabled":true,"maxTurns":50,"maxTokens":1000,"lookbackHours":12},{"id":"summaries","enabled":true,"maxCount":6,"lookbackHours":24},{"id":"conversation-recall","enabled":false,"topK":3,"maxChars":2500,"timeoutMs":800},{"id":"compounding","enabled":false,"maxPatterns":40,"maxRubrics":4},{"id":"questions","enabled":false}]` | `[{"id":"shared-context","enabled":false,"maxChars":4000},{"id":"profile","enabled":true,"consolidateTriggerLines":100,"consolidateTargetLines":50},{"id":"identity-continuity","enabled":false},{"id":"entity-retrieval","enabled":true,"maxChars":2400,"maxHints":2,"maxSupportingFacts":6,"maxRelatedEntities":3,"recentTurns":6},{"id":"knowledge-index","enabled":true,"maxChars":4000,"maxEntities":40},{"id":"verbatim-artifacts","enabled":false},{"id":"memory-boxes","enabled":false},{"id":"temporal-memory-tree","enabled":false},{"id":"objective-state","enabled":false,"maxResults":4,"maxChars":1800},{"id":"causal-trajectories","enabled":false,"maxResults":3,"maxChars":2200},{"id":"trust-zones","enabled":false,"maxResults":3,"maxChars":1800},{"id":"harmonic-retrieval","enabled":false,"maxResults":3,"maxChars":2200},{"id":"verified-episodes","enabled":false,"maxResults":3,"maxChars":1800},{"id":"verified-rules","enabled":false,"maxResults":3,"maxChars":1800},{"id":"work-products","enabled":false,"maxResults":3,"maxChars":1800},{"id":"memories","enabled":true,"maxResults":8},{"id":"compression-guidelines","enabled":false},{"id":"native-knowledge","enabled":false,"maxResults":4,"maxChars":2400},{"id":"transcript","enabled":true,"maxTurns":50,"maxTokens":1000,"lookbackHours":12},{"id":"summaries","enabled":true,"maxCount":6,"lookbackHours":24},{"id":"conversation-recall","enabled":false,"topK":3,"maxChars":2500,"timeoutMs":800},{"id":"compounding","enabled":false,"maxPatterns":40,"maxRubrics":4},{"id":"questions","enabled":false}]` |
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
| `recallPipeline[].maxRubrics` | (unset) | (unset) |
| `recallPipeline[].forceGeneric` | (unset) | (unset) |
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
| `emitLegacyTools` | `false` (fresh install; sticky-`true` when legacy entries exist) | `false` for `remnic_*`-only clients; leave sticky-`true` on upgraded installs |
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
| `offlineSyncExcludes` | `[]` | `[]` |
| `converge.conflictPolicy` | `"newest-wins"` | `"newest-wins"` |
| `activity.enabled` | `false` | `false` until a trusted local activity source is configured |
| `activity.extractionMode` | `"off"` | `"off"`; set `"smart"` only to create trust-gated first-person memory candidates |
| `activity.timezone` | `"UTC"` | Machine-local IANA timezone |
| `activity.sourceTrust` | `0.6` | `0.6` |
| `activity.autoApproveTrust` | `0.8` | `0.8` |
| `activity.reviewTrust` | `0.5` | `0.5` |
| `activity.minConfidence` | `0.7` | `0.7` |
| `activity.minImportance` | `"normal"` | `"normal"` |
| `activity.maxMemoriesPerDay` | `0` | `0` (no count cap) |
| `activity.timeline.enabled` | `false` | `false` |
| `activity.timeline.journal.enabled` | `false` | `false` |
| `activity.timeline.journal.source` | `"memoryDir"` | `"memoryDir"`; `"vault"` only once vault-section journals are deliberately adopted |
| `activity.timeline.journal.extractionMode` | `"off"` | `"off"` |
| `activity.timeline.qa.enabled` | `false` | `false` |
| `activity.timeline.qa.maxRangeDays` | `31` | `31` |

## Meetings (issue #1900)

Retrospective meeting intelligence: detect meetings from already-ingested audio
conversations + screen activity, fuse the transcript with concurrent screen
context, and store a markdown record per meeting under
`<memoryDir>/meetings/<date>/<meeting-id>.md`. Disabled by default; base
installs see zero behavior change.

| Key | Default | Description |
|-----|---------|-------------|
| `meetings.enabled` | `false` | Master gate for the meetings subsystem. |
| `meetings.appPatterns` | shipped defaults | Extra meeting-app match patterns, additive over the shipped set (Zoom, Teams, Google Meet, Webex, Slack huddles, FaceTime). |
| `meetings.minOverlapMinutes` | `2` | Minimum app-span/audio-window overlap (minutes) to pair them into a meeting. |
| `meetings.audioOnlyMinMinutes` | `15` | Audio-only fallback: minimum conversation length (minutes) with at least 2 non-wearer speakers to detect a meeting with no app span. |
| `meetings.mergeGapMinutes` | `2` | Merge adjacent same-app candidates within this gap (minutes) for rejoin-after-drop. |
| `meetings.contextDwellSeconds` | `20` | Minimum other-app foreground dwell (seconds) to include a span in the screen-context timeline. |
| `meetings.maxContextChars` | `4000` | Cap on total deduped screen-context excerpt characters. |
| `meetings.summaryMode` | `smart` | LLM summary/facts mode: `off` (deterministic episode only, no LLM), `review` (queue every candidate), `smart` (trust-gated). |
| `meetings.sourceTrust` | `0.85` | Provenance trust prior for meeting-derived facts (0..1). |
| `meetings.autoApproveTrust` | `0.7` | Trust at/above which a smart-mode meeting fact is auto-approved to active. |
| `meetings.reviewTrust` | `0.45` | Trust at/above which a smart-mode meeting fact is queued for review (below is dropped). |
