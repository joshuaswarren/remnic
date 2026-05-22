# Operations

## Backup, Export, and Import

Engram supports portable exports and safe backups via CLI.

### Export

```bash
# JSON bundle (recommended for migration)
openclaw engram export --format json --out /tmp/engram-export

# SQLite database
openclaw engram export --format sqlite --out /tmp/engram.sqlite

# Markdown bundle (human-readable)
openclaw engram export --format md --out /tmp/engram-md
```

### Import

```bash
openclaw engram import --from /tmp/engram-export --format auto
```

### Backup with Retention

```bash
openclaw engram backup --out-dir /tmp/engram-backups --retention-days 14
```

With namespaces (v3.0):

```bash
openclaw engram export --namespace shared --format json --out /tmp/shared-export
```

→ Full details: [docs/import-export.md](import-export.md)

## CLI Commands

```bash
openclaw engram search "query"      # Semantic search
openclaw engram stats               # Memory counts and index state
openclaw engram setup              # First-run setup validation + directory scaffolding
openclaw engram config-review      # Config tuning recommendations + contradictory-setting checks
openclaw engram doctor             # Aggregated runtime diagnostics + remediation hints
openclaw engram inventory          # Memory/entity/storage footprint, review queue, and native-knowledge sync counts
openclaw engram topics              # View extracted topic list
openclaw engram threads             # View conversation threads
openclaw engram access              # Most-accessed memories
openclaw engram route list          # List routing rules
openclaw engram route add ...       # Add/update a routing rule
openclaw engram route remove ...    # Remove routing rules by pattern
openclaw engram route test ...      # Test routing rule match
openclaw engram export              # Export memory store
openclaw engram import              # Import memory store
openclaw engram backup              # Create timestamped backup
openclaw engram compat              # Run local compatibility diagnostics
openclaw engram benchmark recall    # Status/validate/compare/snapshot recall benchmark artifacts
openclaw engram conversation-index-health  # Backend health + index stats
openclaw engram conversation-index-inspect # Backend metadata + artifact diagnostics
openclaw engram conversation-index-rebuild # Rebuild backend from transcript history
openclaw engram rebuild-index       # Alias for conversation-index-rebuild
openclaw engram graph-health        # Graph edge-file integrity + coverage
openclaw engram session-check       # Transcript/checkpoint continuity diagnostics
openclaw engram session-repair      # Bounded repair plan/apply (dry-run default)
openclaw engram repair              # Aggregate session repair planning + graph guidance
openclaw engram dashboard start     # Start live graph dashboard service
openclaw engram dashboard status    # Dashboard health/status
openclaw engram dashboard stop      # Stop dashboard service
openclaw engram access http-serve   # Start local HTTP API + admin console shell
openclaw engram access http-status  # Access server health/status
openclaw engram access http-stop    # Stop local HTTP API
openclaw engram access mcp-serve    # Run the stdio MCP server
openclaw engram action-audit        # Namespace-aware memory action policy audit
openclaw engram tier-status         # Tier migration telemetry + last-cycle summary
openclaw engram tier-migrate        # Run a bounded tier migration pass (dry-run default)
openclaw engram policy-status       # Runtime policy snapshot + top contributing signals
openclaw engram policy-diff --since 7d  # Parameter deltas + evidence window
openclaw engram policy-rollback     # Roll back to previous runtime policy snapshot
openclaw engram migrate normalize-frontmatter  # Canonical frontmatter rewrite (dry-run default)
openclaw engram migrate rescore-importance     # Recompute local importance scores
openclaw engram migrate rechunk                # Rebuild chunk files from current chunking heuristics
openclaw engram migrate reextract --model gpt-5-mini  # Queue bounded re-extraction requests
```

Compatibility diagnostics:
- `openclaw engram compat` reports `ok|warn|error` checks for manifest wiring, startup hooks/service registration, CLI wiring, Node engine floor, and qmd availability.
- Use `openclaw engram compat --json` for CI/automation consumers.
- Use `openclaw engram compat --strict` to fail with non-zero exit code on warnings or errors.

Operator toolkit:
- `openclaw engram setup` validates the loaded OpenClaw config, creates missing Engram-owned directories, checks QMD reachability/collection presence, and can scaffold `MEMORY.md` when explicit capture is enabled.
- `openclaw engram setup --preview-capture-instructions` prints the managed explicit-capture snippet without writing files.
- `openclaw engram setup --install-capture-instructions` writes or updates only the managed explicit-capture block inside `MEMORY.md`.
- `openclaw engram setup --remove-capture-instructions` removes the managed explicit-capture block and deletes `MEMORY.md` if that block was the file's only content.
- `openclaw engram config-review` compares the active config against shipped defaults plus opinionated recommendations and also flags contradictory settings that degrade recall.
- `openclaw engram doctor` aggregates config, directory, QMD, conversation-index, maintenance, HTTP bridge auth, file-hygiene, and config-review checks into one stable report.
- `openclaw engram inventory` reports counts by category/status, namespace summaries, profile size, review queue size, conversation-index freshness, native-knowledge sync counts, and storage footprint.
- Use `--json` on each of these commands for script/CI-friendly output.

Explicit capture protocol:
- Prefer the `memory_capture` tool when tool use is available.
- Inline fallback is available in `explicit` and `hybrid` modes through a `<memory_note>...</memory_note>` block in assistant output.
- Failed inline writes are sanitized and queued as `pending_review` memories instead of being dropped.
- Managed `MEMORY.md` setup snippets are opt-in, previewable, and reversible through the setup flags above.

Graph diagnostics:
- `openclaw engram graph-health` reports per-edge-file integrity (`entity/time/causal`), corruption counts, and unique node coverage.
- Add `--repair-guidance` to include non-destructive remediation suggestions when corruption or empty-graph conditions are detected.

Session integrity diagnostics:
- `openclaw engram session-check` reports transcript chain anomalies (malformed lines, invalid entries, duplicate turn IDs, broken role chains, incomplete tail turns) and checkpoint integrity state.
- `openclaw engram session-repair` is dry-run by default and outputs both plan + apply summary payloads.
- `session-repair --apply` mutates only Engram-managed files (transcripts/checkpoint) and never rewires OpenClaw pointers/session references.
- `--allow-session-file-repair` only unlocks an explicit guarded workflow for external session-file paths and still performs no automatic rewiring.

Memory action diagnostics:
- `openclaw engram action-audit` reports namespace-aware action totals by action, outcome, and policy decision.
- Use `--namespace <name>` to scope the report to a single namespace.
- Use `--limit <n>` to cap event reads per namespace (`0` preserves zero-limit semantics).

Tier migration diagnostics:
- `openclaw engram tier-status` reports the latest migration cycle summary plus cumulative counters (cycles/scanned/migrated/promoted/demoted/errors).
- `openclaw engram tier-migrate` runs one manual maintenance migration pass.
- `tier-migrate` defaults to dry-run; pass `--write` to apply mutations and `--limit <n>` to bound this pass.

Behavior-loop policy diagnostics:
- `openclaw engram policy-status` reports current/previous runtime policy snapshots plus top contributing behavior signals in the current learning window.
- `openclaw engram policy-diff --since <window>` reports per-parameter deltas (`previousValue`, `nextValue`, `delta`) and associated evidence counts.
- `openclaw engram policy-rollback` restores the previous runtime policy snapshot and prints the resulting current snapshot.

Migration diagnostics:
- `openclaw engram migrate <subcommand>` defaults to dry-run; add `--write` to apply mutations.
- `normalize-frontmatter` performs safe frontmatter round-trip normalization.
- `rescore-importance` recomputes `importanceScore`/`importanceLevel` from current local heuristics.
- `rechunk` uses current sentence-overlap chunking heuristics to rebuild child chunks for long parent memories.
- `reextract --model <id>` queues bounded re-extraction jobs in `state/reextract-jobs.jsonl` (hard-capped, no direct extraction side effects).
- Use `--limit <n>` to bound scanned/queued items for every subcommand.

Routing behavior notes:
- Routing is optional and disabled unless `routingRulesEnabled=true`.
- Rules are applied at write-time for extracted facts before persistence.
- Rule targets may override `category`, `namespace`, or both; invalid targets fail-open to default writes.

Admin console notes:
- Start the local access server, then open `http://127.0.0.1:4318/engram/ui/` in a browser.
- Paste the same bearer token used for `/engram/v1/...` requests into the console login field.
- The console exposes memory paging/sort controls, a dedicated quality dashboard, recall inspection, governance review, entity exploration, and maintenance status.
- The console is read-only by default, but governance review actions still write auditable lifecycle events through the same local access layer.

Access layer notes:
- `openclaw engram access http-serve` fails closed when no bearer token is configured.
- HTTP recall accepts `query`, `sessionKey`, `namespace`, `topK`, `mode`, and `includeDebug`.
- HTTP write endpoints (`/engram/v1/memories`, `/engram/v1/suggestions`, `/engram/v1/review-disposition`) enforce body-size limits, rate limiting, and idempotent retry support for explicit write flows.
- `openclaw engram access mcp-serve` exposes the same recall/read/write service layer over stdio for MCP clients such as Codex and Claude Code.
- Use `GET /engram/v1/health`, `GET /engram/v1/quality`, or `GET /engram/v1/maintenance` as startup probes when local scripts need projection/governance readiness signals before issuing recall or review requests.

## Compression Guideline Optimizer Tool (v8.11)

Agent tool names:
- `compression_guidelines_optimize`
- `memory_action_apply`

`compression_guidelines_optimize` parameters:
- `dryRun` (optional, default `false`): compute candidate and summary without persisting files.
- `eventLimit` (optional, default `500`): max telemetry rows from `state/memory-actions.jsonl`.

`memory_action_apply` safe mode:
- `dryRun` (optional, default `false`): validate and report an action without persisting telemetry.

Summary output fields:
- previous guideline version
- next guideline version
- changed rule count
- semantic refinement applied flag

Cron-safe usage pattern:
- Call the tool in an isolated cron session to avoid blocking interactive turns.
- Prefer `dryRun=true` for first-pass checks, then run with `dryRun=false` when stable.

## Network Sync and WebDAV (v8.8)

Network features are opt-in and not started by default.

```bash
# Check Tailscale availability + daemon state
openclaw engram tailscale-status

# Sync memory directory to a private Tailscale peer over rsync
openclaw engram tailscale-sync \
  --source-dir ~/.openclaw/workspace/memory/local \
  --destination engram-peer:/srv/engram-memory \
  --dry-run

# Start local WebDAV service for explicit allowlisted directories
openclaw engram webdav-serve \
  --allowlist ~/.openclaw/workspace/memory/local \
  --host 127.0.0.1 \
  --port 8080 \
  --username engram \
  --password '<strong-password>'

# Stop WebDAV service in the running gateway process
openclaw engram webdav-stop

# Show conversation-index backend health and basic index stats
openclaw engram conversation-index-health

# Inspect conversation-index backend metadata/artifact state
openclaw engram conversation-index-inspect

# Rebuild conversation-index backend from the last 24h of transcripts
openclaw engram conversation-index-rebuild
openclaw engram rebuild-index

# Show graph health with optional repair guidance notes
openclaw engram graph-health --repair-guidance

# Session integrity diagnostics + bounded repair
openclaw engram session-check
openclaw engram session-repair --dry-run
openclaw engram session-repair --apply
openclaw engram repair --dry-run

# Live graph dashboard process
openclaw engram dashboard start --host 127.0.0.1 --port 4319
openclaw engram dashboard status
openclaw engram dashboard stop

# Show tier migration telemetry and run a dry-run migration pass
openclaw engram tier-status
openclaw engram tier-migrate --dry-run --limit 50
```

Operational safety notes:
- Keep WebDAV bound to `127.0.0.1` unless you have a private-network control plane in front of it.
- Use non-empty username/password together; partial or blank auth fields are rejected.
- WebDAV exposure is limited to the exact allowlist roots you pass via `--allowlist`.
- `tailscale-sync` requires both `tailscale` and `rsync` availability plus a running Tailscale daemon.
- Dashboard defaults to loopback bind (`127.0.0.1`) and does not start automatically in gateway hot paths.

## Hourly Summaries (Cron)

Engram can generate hourly summaries of conversation activity.

Recommended cron setup (via OpenClaw agent turn — avoids `main` session restrictions):

```jsonc
// openclaw.json cron entry
{
  "schedule": "0 * * * *",
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "content": "Call the memory_summarize_hourly tool."
  },
  "delivery": { "mode": "none" }
}
```

Enable extended summaries:

```jsonc
{
  "hourlySummariesExtendedEnabled": true,
  "hourlySummariesIncludeToolStats": false
}
```

## Cron Recall Policy

Engram supports cron-specific recall policy so you can keep high-frequency automation jobs cheap while still enabling memory context for selected cron sessions.

```jsonc
{
  "cronRecallMode": "allowlist",
  "cronRecallAllowlist": [
    "*:cron:<job-id-1>:*",
    "*:cron:<job-id-2>:*"
  ],
  "cronRecallPolicyEnabled": true,
  "cronRecallNormalizedQueryMaxChars": 480,
  "cronRecallInstructionHeavyTokenCap": 36,
  "cronConversationRecallMode": "auto"
}
```

Modes:
- `all`: all cron sessions can use recall.
- `none`: all cron sessions skip recall.
- `allowlist`: only cron session keys matching wildcard patterns (`*`) can use recall.

Query stability controls:
- `cronRecallPolicyEnabled`: normalizes cron retrieval queries (especially large instruction-heavy prompts).
- `cronRecallNormalizedQueryMaxChars`: caps normalized query length.
- `cronRecallInstructionHeavyTokenCap`: caps compacted-token query size for instruction-heavy prompts.
- `cronConversationRecallMode`: `auto` skips conversation semantic recall only for instruction-heavy cron prompts, `always` keeps it enabled for all cron prompts, `never` always skips it.

Pattern tip:
- Session keys include `:cron:<job-id>:`. Match by job id for stability, for example `*:cron:engram-hourly-summary:*`.

## File Hygiene

Engram can optionally lint and rotate large workspace files that are bootstrapped into the prompt (e.g. `IDENTITY.md`). Without rotation, an oversized file can be silently truncated by the gateway.

```jsonc
{
  "fileHygiene": {
    "enabled": true,
    "lintEnabled": true,
    "lintPaths": ["IDENTITY.md", "MEMORY.md"],
    "lintBudgetBytes": 20000,
    "lintWarnRatio": 0.8,
    "rotateEnabled": true,
    "rotatePaths": ["IDENTITY.md"],
    "rotateMaxBytes": 18000,
    "rotateKeepTailChars": 2000,
    "archiveDir": ".engram-archive",
    "runMinIntervalMs": 300000
  }
}
```

## Gateway Restart Commands

```bash
# Full restart (fires gateway_start hook — required for config changes)
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# Hot reload (does NOT fire gateway_start)
kill -USR1 $(pgrep openclaw-gateway)
```

## Logs

```bash
# Watch gateway logs for engram activity
tail -f ~/.openclaw/logs/gateway.log | grep '\[engram\]'

# Slow operations appear in gateway logs as warnings (if slowLogEnabled)
grep -i 'slow\|latency' ~/.openclaw/logs/gateway.log | tail -20
```

## Memory Store Maintenance

```bash
# Re-index all memories in QMD after manual changes
qmd update --collection openclaw-engram
qmd embed --collection openclaw-engram

# View dedup hash index size
wc -l ~/.openclaw/workspace/memory/local/state/fact-hashes.txt
```

## Observation Ledger Maintenance

Engram exposes explicit maintenance commands for observation artifacts.

```bash
# Archive dated transcript/tool/hourly artifacts older than retention window
openclaw engram archive-observations --retention-days 30

# Rebuild canonical observation ledger from transcripts
openclaw engram rebuild-observations

# Migrate legacy observation-ledger JSONL shapes into canonical rebuilt ledger
openclaw engram migrate-observations
```

All three commands are dry-run by default. Use `--write` to apply mutations:

```bash
openclaw engram archive-observations --retention-days 30 --write
openclaw engram rebuild-observations --write
openclaw engram migrate-observations --write
```

Operational guarantees:
- backup-first writes for rebuilt ledger updates
- deterministic UTC hour bucketing
- idempotent no-op migration when no legacy files are present
- fail-open parsing for malformed lines (with counters in CLI output)

## Memory Projection Maintenance

Engram can also rebuild a derived SQLite projection for current-state inspection and per-memory timelines.

```bash
# Rebuild the derived projection from markdown memory files plus lifecycle events
openclaw engram rebuild-memory-projection

# Scope the rebuild to one namespace root and one updated-at window
openclaw engram rebuild-memory-projection --namespace shared --updated-after 2026-03-01T00:00:00Z --write

# Verify projection drift against authoritative markdown + lifecycle data
openclaw engram verify-memory-projection

# Preview a projection repair, then apply it
openclaw engram repair-memory-projection
openclaw engram repair-memory-projection --write

# Inspect one memory timeline from the derived projection (or fail-open fallback path)
openclaw engram memory-timeline fact-123
```

Like the other maintenance commands, projection rebuild is dry-run by default:

```bash
openclaw engram rebuild-memory-projection --write
```

Operational guarantees:
- markdown memories remain authoritative
- projection rebuilds are backup-first and safe to discard/regenerate
- projection verify/repair can target a namespace root plus optional updated-at window
- scoped projection rebuilds only replace rows inside the selected window; out-of-scope rows stay untouched
- timeline reads fail open to the lifecycle ledger when projection data is unavailable
- projection writes use a separate derived SQLite store under `state/memory-projection.sqlite`

## Memory Governance Maintenance

Engram can run a deterministic memory-governance sweep that builds a review queue, applies reversible status/archive transitions, and writes durable audit artifacts for each run.

```bash
# Simulate a governance run and write review artifacts only
openclaw engram governance-run --mode shadow

# Apply governance actions and write restore metadata
openclaw engram governance-run --mode apply

# Read the latest governance artifact bundle
openclaw engram governance-report

# Restore one applied governance run
openclaw engram governance-restore --run-id gov-2026-03-09T12-00-00-000Z

# Record an explicit operator disposition for one memory
openclaw engram review-disposition fact-123 --status rejected --reason-code operator_review
```

Each governance run writes artifacts under `state/memory-governance/runs/<runId>/`:

- `summary.json`
- `review-queue.json`
- `kept-memories.json`
- `applied-actions.json`
- `metrics.json`
- `manifest.json`
- `report.md`
- `restore.json` for `apply` runs only

Operational guarantees:
- `shadow` mode never mutates markdown memories
- `apply` mode writes rollback-safe restore metadata before the run is considered complete
- governance lifecycle events record actor, reason code, rule version, correlation ID, and related memory IDs where available
- the rule set is versioned as `memory-governance.v2` so artifact interpretation stays reproducible

## Work Board Helpers

The work-management layer includes programmatic board helpers for Kanban-style exports and snapshot import:

- `exportWorkBoardSnapshot({ memoryDir, projectId? })`
- `exportWorkBoardMarkdown({ memoryDir, projectId? })`
- `importWorkBoardSnapshot({ memoryDir, snapshot, projectId? })`

These helpers live in `src/work/board.ts` and operate on `work/tasks` + `work/projects` without changing default memory extraction behavior.

## Identity Continuity Anchor

When `identityContinuityEnabled=true`, agents can manage the recovery anchor via tools:

- `identity_anchor_get` reads the current anchor.
- `identity_anchor_update` merges updates into anchor sections (`Identity Traits`, `Communication Preferences`, `Operating Principles`, `Continuity Notes`) without destructive overwrite.
- `continuity_loop_add_or_update` writes structured recurring-loop entries (cadence, purpose, status, kill condition, review timestamp).
- `continuity_loop_review` updates review status/notes while stamping latest review time.

Anchor file location:

```text
<memoryDir>/identity/identity-anchor.md
```

## Continuity Incidents

When `identityContinuityEnabled=true` and `continuityIncidentLoggingEnabled=true`, use these CLI commands:

```bash
openclaw engram continuity incidents --state open --limit 25
openclaw engram continuity incident-open --symptom "identity anchor missing in recovery response"
openclaw engram continuity incident-close --id incident-123 --fix-applied "restored merge guard" --verification-result "recovery prompt includes anchor"
```

Incident artifact location:

```text
<memoryDir>/identity/incidents/*.md
```

Improvement loop register location:

```text
<memoryDir>/identity/improvement-loops.md
```

## Runbooks

- [PR Review Hardening Playbook](ops/pr-review-hardening-playbook.md)
- [Plugin Engineering Patterns](ops/plugin-engineering-patterns.md)
