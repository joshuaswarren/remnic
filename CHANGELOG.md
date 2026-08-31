# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [v9.69.57] — 2026-08-31

### Fixed

- Release recursive package build excludes `@remnic/core` after the dedicated core build so tsup does not wipe core `dist` mid-flight.

## [v9.69.57] — 2026-08-31

### Fixed

- Release `pnpm -r run build` now builds `@remnic/core` first so tsup DTS in dependents can resolve `@remnic/core`.

## [v9.69.57] — 2026-08-31

### Fixed

- `@remnic/belief-ledger` imports store helpers from `@remnic/core` instead of subpath exports, so tsup DTS emit does not need `dist/storage.d.ts` and friends to already exist.

## [v9.69.57] — 2026-08-31

### Fixed

- `@remnic/belief-ledger` aliases `FallbackLlmLedgerAdapterOptions` to `FallbackLlmOptions` instead of `interface extends`, so tsup DTS keeps the `@remnic/core` import and the release build can finish.

## [v9.69.56] — 2026-08-26

### Added

- `remnic-hermes` policy-bound LLM bridge supports the server-owned `active-hermes` provider sentinel. It resolves only Hermes' persisted main provider, model, and optional base URL per completion while retaining a stable `hermes-active` OpenAI-compatible alias; client request routing fields remain ignored.

## [v9.69.40] — 2026-08-25

### Fixed

- QMD startup collection checks now have a batch-wide deadline. If any namespace check never settles despite its per-check abort signal, Remnic continues with fail-open `unknown` states so the daemon can become available; normal background QMD retry can reconcile search afterward.
- H5 injection-suite `openai-compat` executor attaches a host-matched `Authorization: Bearer` token only (`NVIDIA_API_KEY` on `integrate.api.nvidia.com`, `OPENAI_API_KEY` on `api.openai.com`, `REMNIC_OPENAI_COMPAT_API_KEY` on every other host including other `*.openai.com` / `*.nvidia.com` subdomains), requires `https` except loopback HTTP (`127.0.0.1` / `localhost`), and fails closed rather than reusing an ambient key on the wrong host (`#1962`).

## [v9.69.35] — 2026-08-24

### Added

- `remnic-hermes` now provides an opt-in, policy-bound IPv4-loopback LLM bridge and supervisor for deferred Remnic generation through Hermes-managed providers. The bridge owns no provider credential, authenticates its supervised local caller with a launch-scoped token, gives the daemon no provider environment variables, ignores client model selection, and fails closed if either supervised child exits unexpectedly; recall-critical rerank/planner paths remain independent (#2834).
- Hermes `remnic.llm_bridge` can start an in-process loopback `/v1/chat/completions` listener backed by host `PluginLlm`. Bind is loopback-only, request `model`/`provider` fields are discarded, and the generated client file stores a random bearer at `0600`. Remnic consumes it only through `backgroundGeneration` (hourly summarizer); extraction and recall stay on `openaiBaseUrl` / `localLlm*` (#2857).


## [v9.69.31] — 2026-08-23

### Added

- `remnic converge` accepts the peer credential via `--token-file <path>` (0600 file) or `REMNIC_CONVERGE_PEER_TOKEN`; `--token` still works but warns that argv credentials are visible to any process listing for the lifetime of the run (#2823).

## [v9.69.29] — 2026-08-23

### Changed

- `buildReconcileManifest` processes uncached files in bounded 50-file batches (order-preserving) instead of strictly sequentially. At boot scale the sequential form's per-file promise/async-hook overhead dominates — measured on the first full two-host converge: ~66% of apply CPU in async_hooks._propagate + GC, with the manifest read loop (`readParsedMemoriesFromPaths`/`readMaybeEncryptedFile`) the inclusive driver. Synthetic receipt with the full parse path exercised (scripts/measure-manifest-batch.ts, 2,000 files: read → sha verify → parse → identity): 19.4k files/s sequential → 70.2k files/s batched (3.6x). The real-corpus wall time is dominated by per-file encrypted reads the synthetic cannot reproduce; the live first-apply CPU profile (66% promise/GC overhead) is the field receipt for why batching cuts it.

## [v9.69.23] — 2026-08-23

### Added

- `POST /engram/v1/briefing` exposes the daily briefing over the access HTTP boundary: the same registered `briefing` operation the MCP tool dispatches (schema validation, namespace gating, principal propagation), so thin HTTP clients — a Linux desktop panel client, health dashboards — can render a briefing without shelling out to the CLI. Pure read: no write-quota accounting. The response carries both renderings (`markdown` and `json` sections) in one payload regardless of the requested `format`.

## [v9.69.20] — 2026-08-22

### Fixed

- Plain-file offline-sync content chunks now carry the full-file sha256 (`x-remnic-file-sha256`), matching the secure-store branch: peer transports reject chunk responses without it ("response changed during transfer"), so converge plans against real deployments died fetching plain-file tombstone evidence.
- `remnic converge --timeout <seconds>` converts seconds to milliseconds in the correct order (#2802 round-1 regression: `--timeout 3600` produced a 3.6-second timeout because the raw seconds value was normalized as milliseconds and then divided by 1000).
- `planReconciliation` spread-pushed each namespace's entries (`entries.push(...nsEntries)`); a boot-scale namespace (~100k entries) exceeds the call-stack argument limit and the plan dies with `RangeError: Maximum call stack size exceeded`. Entries are pushed per element now.

## [v9.69.18] — 2026-08-22

### Fixed

- `remnic converge` against a live peer at boot scale: a configurable per-request peer timeout (`--timeout <seconds>`, `converge.peerRequestTimeoutMs`, `REMNIC_CONVERGE_PEER_TIMEOUT_MS`; default 30s, clamped to 1h) replaces the hard-coded 30s that killed manifest fetches for ~100k-file namespaces; a peer that lists but will not serve a tombstone file is tolerated (empty file evidence, the snapshot digest array still applies) instead of aborting the plan; a tombstone file that grew append-only while the plan ran is accepted via prefix-extension verification; and the Windows path-portability gates (trailing dot/space, Windows-invalid characters, reserved device names) now apply only when the planning host is Windows, so POSIX-origin paths containing `:` plan normally (`localPlatform` is injectable for tests).

## [v9.69.17] — 2026-08-22

### Fixed

- The daemon's observe path now persists observe-derived turns to the transcript store (with bounded re-POST dedupe), and `memory_summarize_hourly` reports counts plus an explicit warning when the store is empty or stale instead of an unconditional bare ok — delegate-mode gateways no longer silently starve the hourly summarizer (`#2783`).

## [v9.69.16] — 2026-08-22

### Added

- `remnic converge watch` runs bidirectional convergence on a cadence (default 300s, `--interval <seconds>`, SIGINT/SIGTERM-safe) so an active/backup pair converges continuously instead of only when an operator runs `converge apply` — the scheduled-replication companion to `replicaPeers` divergence detection.

## [v9.62.2] — 2026-08-17

### Added

- `node scripts/pr-threads.mjs <pr>` prints review thread IDs, authors, resolution state, and full bodies (`#2441`).

## [v9.57.0] — 2026-08-15

### Changed

- H5 injection-suite live executor default model is now `qwen3.8-27b-64k:latest` with a 300s request timeout (`#1962`).

## [v9.56.0] — 2026-08-15

### Added

- `remnic bench security injection-suite` runs the H5 injection suite with per-row checkpoints, multi-host claim leases, host-fault pause, and local/ollama/openai-compat executors (`#1962`). Does not start the live factorial.

## [v9.49.1] — 2026-08-09

### Added

- Claude Code marketplace install now registers a working `remnic` MCP server at install time via the plugin manifest's `userConfig` + inline `mcpServers` (`#2314`). Claude Code prompts for a `remnic_daemon_token` (sensitive; routed to OS keychain on macOS or a protected credentials file elsewhere) and an optional `remnic_daemon_url` (defaults to `http://localhost:4318/mcp`). The bundled `mcp-server-stdio/server.js` proxies JSON-RPC over stdio to the user-configured URL, so neither the marketplace install nor a manual reinstall requires hand-editing the bundled `.mcp.json` placeholder anymore. The bundled `.mcp.json` is retained as the legacy fallback path for older Claude Code releases that do not yet honor `manifest.mcpServers`/`userConfig`.
- Contradiction detection now localizes candidates by `entityRef` and category before namespace-scoped QMD search, with bounded deterministic merging and configurable caps (`#2327`).
- Graph-expanded recall can optionally demote paths that use stale or non-active intermediate memories. The opt-in `graphPathScoring` block records edge/path evidence without changing the disabled default (`#2328`).

### Contract tests

- `tests/claude-code-marketplace.test.ts` extended with two new contracts: (a) the plugin manifest declares `userConfig.remnic_daemon_token` with `sensitive: true` (so a future refactor cannot silently demote the field to plaintext), and (b) the plugin manifest declares an inline `mcpServers.remnic` stdio server that wires both `userConfig` values via `env` (not argv — the rejected shell-injection pattern flagged by the Claude Code security advisory bundled with the feature). `tests/integration/plugin-structure.test.ts` extended with one new contract: the `mcp-server-stdio/server.js` entrypoint ships at the path the manifest points at.

## [v9.46.0] — 2026-08-02

### Fixed

- `loadDaemonAuth()` in `@remnic/plugin-openclaw` now ranks daemon-credential environment variables primary-before-legacy: `OPENCLAW_REMNIC_ACCESS_TOKEN`, `REMNIC_AUTH_TOKEN`, then the pre-rename aliases `OPENCLAW_ENGRAM_ACCESS_TOKEN` and `ENGRAM_AUTH_TOKEN`. A deployment migrated off the Engram-era naming commonly still exports the old alias from a shell profile or unit file; that stale value previously outranked the `REMNIC_AUTH_TOKEN` the daemon was running with, so every delegate and health request 401'd while the reported token source named the wrong variable. This was the last resolver still on the old ordering — the Claude Code and Codex hooks were corrected in v9.46.0.

## [v9.46.0] — 2026-08-01

### Added

- Claude Code hooks honor `REMNIC_NAMESPACE` / `ENGRAM_NAMESPACE` to target a memory namespace on recall/observe. On the REST surface the namespace is read from the request body (not a header), so on a namespaced daemon the `claude-code` client id otherwise resolves to the adapter's own (empty) namespace and recall silently returns nothing. Opt-in — unset preserves existing behavior.

### Fixed

- Claude Code hook health probe now sends the configured bearer token, so a daemon with `REMNIC_AUTH_TOKEN` set is detected as healthy instead of being reported as "daemon not running" (which silently skipped auto-recall and auto-observe). Token resolution accepts the canonical `REMNIC_AUTH_TOKEN` / `ENGRAM_AUTH_TOKEN` names alongside the connector-scoped `OPENCLAW_*_ACCESS_TOKEN` pair, ordered primary-before-legacy so a leftover pre-rename value cannot shadow the credential the daemon is running with. Without the canonical names the documented standalone-server setup — which authenticates the daemon with `REMNIC_AUTH_TOKEN` and never mints a connector token — left the hook with no credential to send.
- Claude Code hook health probe now authenticates with the caller's already-resolved token instead of re-resolving its own. Re-resolution could pick up a rotated `tokens.json` — or an inherited `REMNIC_HOOK_TOKEN`, which the foreground handlers never read — and green-light a probe whose subsequent recall then 401s.
- Codex hook health probe now sends the configured bearer token, so an auth-gated daemon is detected as healthy instead of being reported as "daemon not running" (which silently skipped auto-recall and auto-observe). Token resolution also accepts the canonical `REMNIC_AUTH_TOKEN` / `ENGRAM_AUTH_TOKEN` names alongside the connector-scoped `OPENCLAW_*_ACCESS_TOKEN` pair, ordered primary-before-legacy so a leftover pre-rename value cannot shadow the credential the daemon is running with. Without them the documented standalone-server setup — which authenticates the daemon with `REMNIC_AUTH_TOKEN` and never mints a connector token — left the hook with no credential to send.
- Codex hook health probe now authenticates with the caller's already-resolved token instead of re-resolving its own. Re-resolution could pick up a rotated `tokens.json` — or an inherited `REMNIC_HOOK_TOKEN`, which the foreground handlers never read — and green-light a probe whose subsequent recall then 401s.
- Hook-runner CommonJS test suites (`packages/**/*.test.cjs`) are now discovered by the root test runner. They live beside the standalone runners rather than under `<pkg>/src`, so no CI job had ever executed them.
- `@remnic/plugin-claude-code` manifest (`.claude-plugin/plugin.json`) now declares `author` as an object, so the plugin installs from a Claude Code marketplace. The string form was rejected by Claude Code's manifest validator (`author: expected object, received string`), which forced the npm-only manual-load path.

## [v9.46.0] — 2026-08-01

### Fixed

- OpenClaw prompt injection now uses only the supported `before_prompt_build` hook; obsolete prompt and heartbeat hook registrations are removed while `HEARTBEAT.md` processing remains supported.
- ClawHub artifacts are validated as-built instead of rewriting scanner-visible filesystem and credential syntax.

## [v9.45.5] — 2026-08-01

### Fixed

- Release publishing now waits for the complete root test corpus, split into deterministic bounded shards against the exact event commit.
- AMB bridge preflight accepts valid reset responses when package-manager diagnostics precede the JSONL payload.
- External-wiki catalog links resolve consistently, and the CLI uses one exported implementation for JSON and text output.
- External-wiki searches report degraded roots even when no hits remain.
- Tier moves preserve concurrent disk updates, invalidate affected cold reads, and remain idempotent.
- First-start migration reconciles QMD after idempotent on-disk tier moves before writing its completion marker.

## [v9.45.4] — 2026-07-31

### Fixed

- Extraction health no longer treats local filter skips as successful runs. Live empty runs record health only when later steps succeed.
- Stats now add extraction counts from active namespaces. Scoped health keeps the backlog counts behind its status. Invalid calendar dates now fail metadata checks.
- Entity migration now rejects symlinked alias configs and control characters in IDs. Reference rewrites preserve the original memory body bytes.

## [v9.45.1] — 2026-07-30

### Added

- `converge.conflictPolicy` configures `newest-wins` or `manual` conflict handling. This release changes the default to `newest-wins`; conflicts without comparable timestamps still stop before mutation. `--conflict-policy` overrides the config for one command (#2150 increment 5).

## [v9.44.0] — 2026-07-30

### Added

- After a converge batch writes files, the receiver updates search and rebuilds the memory view. It runs once for each changed namespace (#2150 increment 4).

## [v9.42.0] — 2026-07-30

### Added

- Bidirectional resumable converge transport CLI subcommand (`remnic converge apply`) and durable peer+namespace cursor state (#2150 increment 2).
- `remnic converge plan` CLI subcommand to preview corpus convergence state across configured or specified peers.

## [v9.41.0] — 2026-07-30

### Fixed

- Extraction liveness now uses the newest successful extraction across the root
  and all distinct namespace stores. Partial namespace metadata failures surface
  as an unreadable watermark instead of publishing a surviving timestamp as
  fresh.

## [v9.40.0] — 2026-07-30

### Fixed

- OpenClaw delegate preflight now uses an authenticated liveness endpoint that
  skips detailed QMD and corpus diagnostics. Older daemons fall back to the
  detailed health endpoint, and `bridgeHealthTimeoutMs` provides a shared probe
  deadline with a 10-second default.

## [v9.38.3] — 2026-07-30

### Fixed

- Memory timeline fallback telemetry now measures projection lag against unique
  lifecycle-ledger events, survives ledger compaction, and warns only when the
  lag exceeds its event threshold while retaining projection-age context.
- Extraction liveness watermark now advances on every successfully parsed
  extraction, including runs that emit no durable facts/entities/questions
  (issue #2223). Previously a normal live extraction with an all-empty parsed
  result cleared its buffer and healed retry state without stamping
  `MetaState.lastExtractionAt`, so `/health.extraction` could report a stale
  last success and `degraded: true` while extraction was actually alive.
  Provider-reported failures and null/unparseable responses never advance the
  watermark.

## [v9.38.0] — 2026-07-29

### Added

- Recall-timeout circuit breaker for the Pi plugin's automatic between-tool
  context recalls (`packages/plugin-pi`). When `recallTimeoutThreshold` (default
  `7`) of the last `recallTimeoutWindow` (default `10`) recall calls fail with an
  explicit request timeout, automatic recall is disabled for the remainder of the
  process: subsequent calls are neither retried nor awaited, in-flight recalls are
  aborted, and the session status reports that recall is off until restart. The
  breaker is in-memory, never re-enables itself after a cooldown, and adds no
  latency on the healthy path. Only explicit request timeouts count toward
  tripping; other failures still occupy window slots so stale timeouts age out.

## [v9.8.0] — 2026-07-21

### Added

- Cross-reviewer review-thread deduplication for the unresolved-thread guard
  (issue #1994, umbrella #1988). A deterministic lexical-shingle module
  (`scripts/review-dedup.mjs`, mirrored inline in
  `.github/workflows/review-thread-guard.yml`) merges duplicate findings only
  when they share a file, overlapping anchored lines, and fingerprint
  similarity at or above the committed threshold; a duplicate inherits its
  canonical's resolution and a `not-a-duplicate` reply detaches it. In shadow
  mode (`REVIEW_DEDUP_MODE`, default `shadow`) the unresolved count is
  byte-identical and only the dedup ledger is logged; in `enforce` the guard
  posts an idempotent gate-authored canonical-link reply and a
  `duplicate-finding` label on each merged thread. Retired `kilo-code-bot`
  from the default reviewer lineup; CodeQL is untouched.

## [v9.6.24] — 2026-07-15

### Fixed

- Replaced real client names used as example project tags in MCP tool
  descriptions (`access-mcp.ts`) and test fixtures with generic placeholders
  (`acme-webshop`, `globex-storefront`). The shipped MCP schema no longer
  references any real project name.
- coding-graph indexing now derives CALLS edges from parsed call sites
  (Phase A heuristic resolution, issue #1891). Previously `codegraph_index`
  produced nodes but zero edges, leaving `trace_path`, blast radius, and
  dead-code detection degenerate. The reindex pipeline resolves each call
  site to its innermost enclosing symbol (src) and a unique same-file or
  import-bound name (dst); the stale-edge delete is provenance-scoped
  (`StoreFileIR.assertedEdgeProvenances`) so re-derivation never removes
  `trace`/`lsp` edges.

## [v9.6.11] — 2026-07-13

### Added

- MemCorrect now routes Remnic corrections through the Correction Contract
  (plan + confirmed apply) via the public access-service surface, with an
  explicit turn-path fallback when the planner produces no applicable action.
  `remnic bench run memcorrect-v1 --memcorrect-adapter <remnic|prompt-only>`
  selects the adapter from the CLI.

## [v9.3.764] — 2026-07-11

### Changed

- Exposed recall introspection through the typed `Orchestrator.recallIntrospection`
  coordinator and removed the duplicate intent, QMD, and graph-recall forwarding
  methods from the oversized composition root.
- Moved scope-profile and team configuration parsing into a dedicated
  namespace config module while preserving `parseConfig` validation and
  defaults.

## [v9.3.652] — 2026-06-30

### Added

- Health responses now include structured QMD diagnostics (`qmd.active`,
  `qmd.mode`, version support, collection state, and degraded fallback status)
  so Docker/standalone deployments can tell whether QMD is actually active
  instead of inferring it from recall behavior.

## [v9.3.648] — 2026-06-29

### Added

- **QMD collection auto-creation** (Dockerfile + core). `ensureCollection`
  now auto-creates the QMD collection when missing instead of falling back
  to NoopSearchBackend. Works per-namespace — each namespace's collection
  is created automatically on first probe. The Docker image now includes
  `@tobilu/qmd@2.5.3` via `npm install -g` so QMD is available out of the
  box.

## [v9.3.162] — 2026-04-23

### Added

- **Security mitigation wiring docs** (issue #565). Threat-model §10
  documents the wiring status of PRs #649–#652. `AccessAuditAdapter`
  recall-path wiring (#650) and `remnic doctor` security-mitigation check
  (#651) are merged. `CrossNamespaceBudget` recall-path wiring (#649)
  and mitigation-aware ADAM baseline (#652) are still open. Both
  mitigations ship disabled by default (`recallCrossNamespaceBudgetEnabled`,
  `recallAuditAnomalyDetectionEnabled`).

- **Contradiction-detection bench scenario** (issue #647). Synthetic
  benchmark at `packages/bench/src/benchmarks/remnic/contradiction-detection/`
  with 4 fixture classes (true-contradiction, near-paraphrase,
  independent-similar, independent-dissimilar). Reports per-verdict
  precision, recall, F1, and overall accuracy. Deterministic — no LLM
  calls.
- **Memory importers for ChatGPT, Claude, Gemini, Mem0** (issue #568).
  Ship as optional peer-dep packages: `@remnic/import-chatgpt`,
  `@remnic/import-claude`, `@remnic/import-gemini`, `@remnic/import-mem0`.
  Load via computed dynamic import from `remnic-cli` so the base install
  stays small; missing adapter yields a clean install hint, never
  `MODULE_NOT_FOUND`. CLI: `remnic import --adapter <source> --file <path>`
  with `--dry-run`, `--rate-limit`, `--batch-size` flags. The
  `--all-from-bundle <dir>` auto-detects every export format in one
  directory. See [`docs/importers.md`](docs/importers.md) and the
  [`/import`](https://remnic.ai/import) page.
- **Coding agent mode** (issue #569) auto-scopes memory to the git
  project (origin-URL hash) and optionally to the current branch. New
  `codingMode.projectScope` (default `true`) and `codingMode.branchScope`
  (default `false`) config keys. Branch scope falls back to project-level
  reads so project memories stay visible from any branch while branch
  writes don't leak. `remnic doctor` now prints detected `projectId`,
  `branch`, and effective namespace. New MCP tool
  `remnic.set_coding_context` (with `engram.*` alias) for clients that
  don't send `cwd`. Claude Code and Codex CLI session-start hooks
  auto-detect git context with a 2s timeout so wedged filesystems can't
  stall launch. Diff-aware review-context recall tier activates on
  review keywords (`review`, `diff`, `what changed`, `look at this PR`)
  and boosts memories whose `entityRefs` touch the modified files. See
  [`docs/coding-agent.md`](docs/coding-agent.md) and the
  [`/coding-agent`](https://remnic.ai/coding-agent) page.
- **Recall X-ray observability** (issue #570): know exactly why each
  memory surfaced. New `RecallXraySnapshot` schema captures per-result
  tier (`direct-answer` / `hybrid` / `graph` / `recent-scan` /
  `procedural` / `review-context`), score decomposition, filter ladder,
  graph path, and audit entry ID. Shared renderer
  (`recall-xray-renderer.ts`) emits JSON, text, or markdown. New CLI
  `remnic xray "<query>"` with `--format`, `--budget`, `--namespace`,
  `--out`. HTTP `GET /engram/v1/recall/xray` with bearer + namespace
  scope. MCP tool `remnic.recall_xray` (with `engram.*` alias). Legacy
  `/recall/explain` gains a markdown mode that delegates to the xray
  renderer; existing text/json responses are unchanged and
  backwards-compatible. See [`docs/xray.md`](docs/xray.md) and the
  [`/observability`](https://remnic.ai/observability) page.

### Changed

- **Procedural memory is now enabled by default** (issue #567 PR 4/5;
  previously shipped disabled). Fresh installs and any config that omits
  `procedural.enabled` now get procedure extraction, task-initiation
  recall injection, and trajectory mining using the safer-by-default
  thresholds from #567 PR 3 (`successFloor=0.75`, `lookbackDays=14`,
  `recallMaxProcedures=2`). Operators who want to stay opt-out should
  set `procedural.enabled: false` explicitly. See
  [`docs/procedural-memory.md`](docs/procedural-memory.md) and the
  baseline lift artifact in
  [`packages/bench/baselines/procedural-recall-baseline.json`](packages/bench/baselines/procedural-recall-baseline.json).

## [v9.3.103] — 2026-04-20

### Added

- Published LongMemEval-S + LoCoMo-10 runbook at
  `docs/benchmarks/runbook.md`, summary at `docs/benchmarks.md`, and
  the `/benchmarks` page on <https://remnic.ai/benchmarks>.
- Placeholder artifacts in `docs/benchmarks/results/` prove the
  `BenchmarkArtifact v1` pipeline end-to-end on a fresh clone; real
  numbers land in a tagged release per issue #566.

## [v9.3.6] — 2026-04-14

### Added

- Entity files now support a two-layer "Compiled Truth + Timeline" format with
  mutable `## Synthesis`, append-only `## Timeline`, and
  `synthesis_updated_at` / `synthesis_version` metadata for stale-synthesis
  detection and bounded rebuilds.
- `remnic openclaw entities-migrate` converts legacy flat entity files into the
  new synthesis-plus-timeline format, seeding timeline evidence from existing
  entity content.

### Changed

- Recall and briefing surfaces now prefer entity synthesis by default while
  reserving timeline snippets for explicit history-oriented questions.
- Nightly governance now refreshes stale entity synthesis in bounded batches,
  and OpenClaw plugin manifests expose the new `entitySynthesisMaxTokens`
  configuration budget.

## [v9.3.2] — 2026-04-12

### Added

- OpenClaw plugin manifests (`openclaw.plugin.json` at root and
  `packages/plugin-openclaw/`) now advertise the v2026.4.10 runtime support
  block for memory-slot routing, dreaming-slot routing, active-memory,
  heartbeat, `commands.list`, and `before_reset`.
- OpenClaw plugin manifests now explicitly accept the `dreaming`,
  `slotBehavior`, reset-flush, and `codexCompat` config blocks so newer
  OpenClaw runtimes validate Remnic's config surface without dropping keys.

### Changed

- `before_reset` now clears per-session recall workspace overrides in addition
  to the precomputed recall cache, preventing stale session-scoped state from
  surviving a reset.
- OpenClaw plugin docs now document canonical `openclaw-remnic` configuration,
  slot-selection behavior, reset-flush semantics, command discovery, and the
  extraction-auth clarification for bundled Codex compatibility work.

## [v9.3.1] — 2026-04-12

### Added

- **`remnic openclaw install` CLI command** — configures OpenClaw to use Remnic
  as the memory provider. Writes `plugins.entries["openclaw-remnic"]` and
  `plugins.slots.memory = "openclaw-remnic"` to `~/.openclaw/openclaw.json`.
  Supports `--yes` / `-y` / `--force` (skip prompts), `--dry-run` (preview
  without writing), `--memory-dir <path>`, and `--config <path>` flags.
  Detects legacy `openclaw-engram` entries and interactively offers migration.
- **Expanded `remnic doctor` OpenClaw config checks** — new checks verify the
  OpenClaw config file exists and is valid JSON, `plugins.entries` is present,
  an `openclaw-remnic` (or legacy `openclaw-engram`) entry exists, the memory
  slot is set and points to a known entry, and `config.memoryDir` exists on
  disk. Each failing check surfaces a remediation hint pointing to
  `remnic openclaw install`.
- **`gateway_start` log line** — the plugin's `start()` handler now emits
  `[remnic] gateway_start fired — Remnic memory plugin is active (id=…, memoryDir=…)`
  so operators can confirm hooks are firing without parsing the full log.
- **Slot hint in plugin manifests** — `openclaw.plugin.json` (root and
  `packages/plugin-openclaw`) now include a `description` field with a slot
  requirement hint. The shim manifest's description points operators to the
  rename.
- **`docs/integration/plugin-id-and-memory-namespaces.md`** — design note
  explaining the `openclaw-remnic` vs `openclaw-engram` split, how
  `plugins.slots.memory` gating works, the expected operator workflow, memory
  namespace conventions, and a forward-compat note for multi-kind slots.
- **Quick install section in README** — shows `remnic openclaw install` as the
  recommended path for OpenClaw operators.
- **Troubleshooting: hooks aren't firing section in README** — explains the
  slot gating root cause, points at `remnic doctor` and `remnic openclaw install`,
  and shows the expected `gateway_start fired` log line.

## [v9.3.0] — 2026-04-12

### Fixed

- `@joshuaswarren/openclaw-engram` shim binary (`engram-access`) now passes
  `preferredId: "openclaw-engram"` to `runCli`, so legacy shim installs target
  their own `plugins.entries["openclaw-engram"]` block instead of falling
  through to the canonical `"openclaw-remnic"` entry during migration when
  `plugins.slots.memory` is unset. Without this, the shim CLI could silently
  read/write the wrong memory store when both config blocks existed. (#403)
- Runtime singletons (orchestrator, start/init guards, access service/HTTP
  server) in `@remnic/plugin-openclaw` are now scoped per `serviceId` on
  `globalThis`, so a migration install that loads both the canonical
  `openclaw-remnic` plugin and the legacy `openclaw-engram` shim in the same
  process gives each plugin its own orchestrator with its own
  `memoryDir`/policy instead of forcing the second plugin to silently reuse
  the first plugin's state. An unkeyed
  `globalThis.__openclawEngramOrchestrator` mirror is still maintained as a
  "last registered Remnic orchestrator" pointer for cross-plugin observers
  that don't know the `serviceId`. (#403)

### Changed

- `docs/integration/sample-openclaw-config.json` updated to use the
  `openclaw-remnic` entry name and include `plugins.slots.memory` with migration
  comments.

## [1.0.0] — The Remnic Release — 2026-04-10

### Engram is now Remnic

- Engram is now **Remnic** across all packages, docs, repo, and runtime surfaces.
- The canonical install paths are `@remnic/plugin-openclaw`, `@remnic/core`,
  `@remnic/server`, and `@remnic/cli`.
- First-run migration copies legacy `~/.engram/` state into `~/.remnic/`,
  rewrites token/config surfaces, and preserves rollback metadata.
- The legacy `engram` CLI name remains as a forwarder during the 1.x
  compatibility window.

### Published packages

- [`@remnic/core`](https://www.npmjs.com/package/@remnic/core) 1.0.2 —
  framework-agnostic memory engine with built-in provider fallback for
  standalone use (works without OpenClaw)
- [`@remnic/server`](https://www.npmjs.com/package/@remnic/server) 1.0.3 —
  standalone HTTP/MCP server with daemon lifecycle (launchd/systemd)
- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) 1.0.3 — CLI
  with daemon management, connector install, token management
- [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw)
  1.0.3 — OpenClaw bridge plugin (the deepest integration)
- [`@joshuaswarren/openclaw-engram`](https://www.npmjs.com/package/@joshuaswarren/openclaw-engram)
  9.3.3 — compatibility shim, re-exports `@remnic/plugin-openclaw`

### Infrastructure

- All npm publishes use GitHub Actions OIDC trusted publishing with
  provenance attestation — no npm access tokens
- All pre-shim versions of `@joshuaswarren/openclaw-engram` deprecated on npm
- Every npm package has a README visible on npmjs.com
- Rename landing page live at [remnic.ai/rename](https://remnic.ai/rename)

## [v9.2.7] — 2026-04-05

### Fixed
- **Adapter rewrite** — replaced fictional per-platform headers with real detection signals:
  - `ClaudeCodeAdapter` — detects via `clientInfo.name = "claude-code"`, `User-Agent: claude-code/…`, or `X-Engram-Client-Id`
  - `CodexAdapter` — detects via `clientInfo.name = "codex-mcp-client"` or `X-Engram-Client-Id`
  - `ReplitAdapter` — detects via user-configured `X-Engram-Client-Id: replit` (Replit sends no auto headers)
  - `HermesAdapter` — detects via `X-Hermes-Session-Id` (confirmed v0.7.0), `X-Engram-Client-Id`, or clientInfo
- MCP server now stores `clientInfo` from initialize handshake and passes it to adapter resolution
- Standardized scoping headers: `X-Engram-Namespace`, `X-Engram-Principal` (replaces per-platform invented headers)
- Updated connector-setup docs for Claude Code, Codex CLI, Replit Agent, and added Hermes Agent section

## [v9.2.6] — 2026-04-05

### Added
- **Adapter architecture** for multi-system identity resolution:
  - `AdapterRegistry` — chainable adapter resolution for incoming requests
  - `GET /engram/v1/adapters` — discovery endpoint showing registered adapters and resolved identity
- HTTP server now auto-detects connecting system and resolves principal via adapter registry

## [v9.2.4] — 2026-04-05

### Added
- **9 new continuity/identity standalone MCP tools**:
  - `engram.continuity_audit_generate` — generate weekly/monthly identity continuity audit
  - `engram.continuity_incident_open` — create continuity incident record
  - `engram.continuity_incident_close` — close incident with verification
  - `engram.continuity_incident_list` — list incidents by state
  - `engram.continuity_loop_add_or_update` — manage improvement loops
  - `engram.continuity_loop_review` — review improvement loop metadata
  - `engram.identity_anchor_get` — read identity anchor document
  - `engram.identity_anchor_update` — update identity anchor sections
  - `engram.memory_identity` — read agent identity reflections
- **3 new work layer standalone MCP tools**:
  - `engram.work_task` — manage tasks (create/get/list/update/transition/delete)
  - `engram.work_project` — manage projects (CRUD + link_task)
  - `engram.work_board` — export/import board snapshots and markdown
- **7 new shared context/compounding standalone MCP tools**:
  - `engram.shared_context_write_output` — write agent output for cross-agent coordination
  - `engram.shared_feedback_record` — record approval/rejection feedback
  - `engram.shared_priorities_append` — append priorities to inbox
  - `engram.shared_context_cross_signals_run` — generate cross-signal synthesis
  - `engram.shared_context_curate_daily` — daily roundtable summary
  - `engram.compounding_weekly_synthesize` — weekly learning reports + rubrics
  - `engram.compounding_promote_candidate` — promote candidate to durable memory
- **2 new compression guidelines standalone MCP tools**:
  - `engram.compression_guidelines_optimize` — run compression guideline optimizer
  - `engram.compression_guidelines_activate` — activate staged guideline draft
- **11 new standalone MCP tools** for feature parity with OpenClaw plugin:
  - `engram.memory_search` — direct semantic search with QMD index
  - `engram.memory_profile` — user behavioral profile
  - `engram.memory_entities_list` — list all tracked entities
  - `engram.memory_questions` — open questions from conversations
  - `engram.memory_last_recall` — last recall debug snapshot
  - `engram.memory_intent_debug` — intent classification debug
  - `engram.memory_qmd_debug` — QMD index debug info
  - `engram.memory_graph_explain` — entity graph recall explanation
  - `engram.memory_feedback` — relevance feedback (up/down) for memories
  - `engram.memory_promote` — lifecycle state promotion
  - `engram.context_checkpoint` — save session context to disk

### Fixed
- **ACLs** — enforce namespace read/write authorization on all parity tools (memorySearch, memoryProfile, memoryEntitiesList, memoryQuestions, memoryPromote, contextCheckpoint)
- **feedbackEnabled gate** — `engram.memory_feedback` now returns clean JSON when feedback is disabled instead of silently recording
- **namespace-scoped checkpoints** — `engram.context_checkpoint` now writes to namespace-specific storage directory
- **CLI `engram.cjs`** — print "Fatal: <message>" when tsx is not found (was silent exit)
- **CLI `engram.cjs`** — respect `NO_COLOR` and user-set `FORCE_COLOR` instead of unconditionally forcing color

## [v9.2.3] — 2026-04-04

### Added
- **`engram tree watch`** — watch memory directory for changes and incrementally regenerate context tree (debounced, recursive)

## [v9.2.1] — 2026-04-04

### Added
- **`engram tree generate`** — fully wired context tree generation from canonical memory (was stub)
- **`engram tree validate`** — validates existing context tree integrity
- **`ENGRAM_MEMORY_DIR` env var** — override memory storage location for standalone deployments
- **Standalone memory path** — `~/.engram/memory/` used by default for new standalone installs (OpenClaw users keep `~/.openclaw/workspace/memory/local/`)
- **7 new built-in connectors** — GitHub Copilot, Roo Code, Windsurf, Amp, Replit, Generic MCP (joining Claude Code, Codex CLI, Cursor, Cline)
- **CLI `--output`, `--categories`, `--max-per-category` flags** for tree generation

### Fixed
- **CLI `engram.cjs`** — tsx resolution now checks workspace-hoisted root `node_modules` (fixes standalone builds)
- **CLI auto-run guard** — narrowed to `packages/cli/src/index.` pattern (prevents false triggers when imported by other packages)
- **CLI error handling** — `engram.cjs` wrapper propagates child exit codes instead of raw stack traces

## [v9.1.36] — 2026-04-04

### Added

**Platform architecture (M0-M7)**

- **Monorepo packages** — repository reorganized into five packages: `@remnic/core` (framework-agnostic engine), `@remnic/cli` (standalone CLI binary), `@remnic/server` (standalone HTTP/MCP server), `@remnic/bench` (benchmarks + CI regression gates), `@remnic/hermes-provider` (HTTP client for remote Remnic instances)
- **Schema validation** — `access-schema.ts` with Zod validates all HTTP and MCP request bodies before processing; structured error responses with `error`, `code`, `details` fields and `X-Request-Id` correlation IDs
- **Standalone CLI** — 15+ commands: `init`, `status`, `query`, `doctor`, `config`, `daemon`, `tree`, `onboard`, `curate`, `review`, `sync`, `dedup`, `connectors`, `space`, `benchmark`
- **Hermes provider** — `@remnic/hermes-provider` lightweight HTTP client for connecting LLM agents to remote Remnic instances
- **Workspace tree projection** — context tree generation from workspace directory structure
- **Onboarding** — project ingestion with language detection, doc discovery, and ingestion planning (`engram onboard`)
- **Curation** — file curation into memory with duplicate and contradiction detection (`engram curate`)
- **Review inbox** — approve, dismiss, or flag ingested content before it enters the memory store (`engram review`)
- **Diff-aware sync** — filesystem sync detecting added/modified/deleted files with incremental ingestion (`engram sync`)
- **Connector manager** — host adapter lifecycle management: list, install, remove, doctor (`engram connectors`)
- **Spaces** — personal, project, and team memory spaces with push/pull/share/promote/audit workflows (`engram space`)
- **Benchmarks** — latency ladder with tier breakdowns, saved baselines, CI regression gates, and `--explain` mode (`engram benchmark`)
- **Retrieval tier system** — Tier 0 (exact match) through Tier 4 (full scan) with documented latency expectations
- **Dedup detection** — find and report duplicate memory pairs with similarity scoring (`engram dedup`)

### Changed

- npm entry point (`dist/index.js`) unchanged — backward compatible
- Config format unchanged — all 60+ options compatible
- Plugin manifest (`openclaw.plugin.json`) unchanged
- Memory storage format unchanged
- Only `prepack` hook — no `postinstall` or `prepare`

### Docs

- New [Platform Migration Guide](docs/guides/platform-migration.md)
- Updated [Migrations Guide](docs/guides/migrations.md) with platform migration section
- Updated [README.md](README.md) with standalone usage, package architecture
- Updated [Getting Started](docs/getting-started.md) with Option C (standalone installation)
- Updated [API Reference](docs/api.md) with standalone CLI command reference
- Updated [Hermes Setup](docs/integration/hermes-setup.md) with standalone package note
- Updated [Deployment Topologies](docs/integration/deployment-topologies.md) with Topology 5 (standalone)

## [v9.1.20] — 2026-03-29

### Fixed
- **Gateway-native secret resolution** — Replaced the previous 1Password-specific secret resolution with delegation to OpenClaw's own `resolveApiKeyForProvider()`. This uses the gateway's auth system (auth profiles, SecretRef resolution, 1Password, Vault, env vars, etc.) — the same codepath the gateway uses for its own agent sessions. All existing secret management setups work automatically. Falls back to `PROVIDER_NAME_API_KEY` env vars when the gateway auth module isn't available.

## [v9.1.17] — 2026-03-28

### Fixed
- **Rerank gateway routing** — Reranking now routes through the `fastGatewayAgentId` model chain when `modelSource` is `"gateway"`, instead of always using the local LLM. This eliminates the 7–38s local rerank bottleneck when a cloud fast-tier provider is configured.

## [v9.1.16] — 2026-03-28

### Added
- **Gateway Model Source** — Route all Engram LLM calls through the OpenClaw gateway's agent model chain instead of Engram's own config. Set `modelSource: "gateway"` and reference agent personas via `gatewayAgentId` and `fastGatewayAgentId`. Enables multi-tier fallback chains (e.g., Fireworks → Z.ai → Anthropic → local LLM) configured once in `openclaw.json`.

## [v9.1.7] — 2026-03-25

### Added
- **Smart Memory Cache** — Process-level singleton cache for `readAllMemories()` and `readArchivedMemories()`. Uses `memoryStatusVersion` for invalidation, write-through on mutations. Reduces 15s disk scans to <100ms cache hits. Shared across all sessions, agents, and namespaces.
- **Semantic Consolidation Engine** — Finds clusters of semantically similar memories using token overlap, synthesizes canonical versions via LLM, and archives originals with full provenance. Runs on a configurable schedule (default weekly) or manually via CLI.
  - `semanticConsolidationEnabled` — Enable the feature (default `false`)
  - `semanticConsolidationThreshold` — Token overlap threshold, 0.8=conservative, 0.6=aggressive (default `0.8`)
  - `semanticConsolidationModel` — LLM selection: `"auto"`, `"fast"`, or specific model (default `"auto"`)
  - `semanticConsolidationMinClusterSize` — Min cluster size before merging (default `3`)
  - `semanticConsolidationExcludeCategories` — Categories to exclude (default `["correction", "commitment"]`)
  - `semanticConsolidationIntervalHours` — Hours between auto-runs (default `168` = weekly)
  - `semanticConsolidationMaxPerRun` — Max memories per run to limit LLM cost (default `100`)
- **Archive Cache** — Same caching pattern applied to archived memories for cold recall paths.
- **CLI: `semantic-consolidate`** — Manual semantic consolidation with `--dry-run`, `--verbose`, and `--threshold` options.

## [v9.1.0] — 2026-03-22

### Added
- **OpenClaw 2026.3.22 SDK compatibility** — full support for the new plugin SDK with runtime feature detection and backward compatibility for users on ≤2026.3.13.
- **`before_prompt_build` hook** — replaces legacy `before_agent_start` for memory context injection on new SDK runtimes.
- **`registerMemoryPromptSection`** — first-class memory section builder registration for gateway-managed prompt assembly.
- **`definePluginEntry`** — new SDK plugin entry point with automatic fallback for older runtimes.
- **Session lifecycle hooks** (`session_start`, `session_end`) — pre-warm file hygiene and flush pending extractions.
- **Tool observation hooks** (`before_tool_call`, `after_tool_call`) — real-time tool usage tracking for transcript stats.
- **LLM observation hook** (`llm_output`) — token usage and latency telemetry.
- **Subagent lifecycle hooks** (`subagent_spawning`, `subagent_ended`) — multi-agent session tracking.
- **Registration mode handling** — skip heavy initialization in `setup-only` mode.
- **SDK capability detection** (`src/sdk-compat.ts`) — runtime probe for new API surfaces.
- **Typed hook signatures** — all hooks use typed event/context interfaces.

### Changed
- **Compat checks** now accept either `before_prompt_build` or `before_agent_start` as the recall hook.

### Removed
- **Legacy `agent_heartbeat` hook** — dead code since OpenClaw 2026.1.29.

## [v9.0.106] — 2026-03-22

### Added
- **Parallel specialized retrieval** (`src/retrieval-agents.ts`) — three parallel search agents (DirectFact, Contextual, Temporal) run via `Promise.all()` so total latency = `max(agents)` not `sum(agents)`. Zero additional LLM inference cost: DirectFact uses entity filename index (<5ms), Temporal uses the temporal date index (<10ms), and Contextual reuses the existing `hybridSearch`. Enabled via `parallelRetrievalEnabled` config flag (default false); graceful degradation on any agent error.

## [v9.0.100] — 2026-03-21

### Fixed
- **Service-started timing**: set `ENGRAM_SERVICE_STARTED` inside the IIFE on success only; guard teardown and hook-api reset against live secondary takeovers (#288).
- **Registration guard**: never clear `ENGRAM_REGISTERED_GUARD` during stop-during-init — original CLI registration remains valid in the gateway registry.

## [v9.0.84 through v9.0.99] — 2026-03-14 to 2026-03-21

This project auto-releases on every merge to `main`. Per-release notes for individual tags are available in [GitHub Releases](https://github.com/joshuaswarren/remnic/releases).

### Fixed
- **Orchestrator init gate**: resolve the init gate after essential state loading (storage, aliases, relevance, transcript, summarizer) instead of waiting for slow QMD collection setup to finish. QMD probe and `ensureCollection` (~96s) now runs after the gate opens. Recall already degrades gracefully when QMD isn't ready, so there's no correctness risk. Fixes init gate timing out (15s timeout vs ~96s actual) and blocking recall on every startup.

## [v9.0.1 through v9.0.83] — 2026-03-07 to 2026-03-14

This project auto-releases on every merge to `main`. Per-release notes for individual tags are available in [GitHub Releases](https://github.com/joshuaswarren/remnic/releases).

## [9.0.0] — 2026-03-02

### Added
- **LanceDB search backend** (`src/search/lancedb-backend.ts`) — embedded hybrid FTS+vector search with native Arrow bindings and RRF reranking.
- **Meilisearch search backend** (`src/search/meilisearch-backend.ts`) — server-based search via the official Meilisearch SDK.
- **Orama search backend** (`src/search/orama-backend.ts`) — embedded hybrid FTS+vector search, pure JS, zero native dependencies.
- Shared document scanner (`src/search/document-scanner.ts`) — scans `facts/` and `corrections/` for indexable markdown documents.
- Shared embed helper (`src/search/embed-helper.ts`) — embedding via OpenAI or local LLM for embedded backends.
- Config keys: `lanceDbPath`, `lanceEmbeddingDimension`, `meilisearchHost`, `meilisearchApiKey`, `meilisearchTimeoutMs`, `meilisearchAutoIndex`, `oramaDbPath`, `oramaEmbeddingDimension`.
- `searchBackend` enum expanded to `"qmd" | "remote" | "noop" | "lancedb" | "meilisearch" | "orama"`.
- Factory routing in `createSearchBackend()` for all three new backends.
- Tests: factory routing, adapter construction, document scanner, embed helper (10 tests).
- Smoke test script (`tests/smoke-backends.ts`) for local verification.

### Added (from PR #114)
- SearchBackend port/adapter interface (`src/search/port.ts`) abstracting QMD behind a stable contract so alternative backends (remote HTTP, noop, custom) can replace QMD.
- `NoopSearchBackend` adapter for graceful degradation when no search engine is available.
- `RemoteSearchBackend` HTTP REST adapter stub for remote search services.
- Factory function `createSearchBackend(config)` for config-driven backend selection.
- Config keys: `searchBackend` (`"qmd"` | `"remote"` | `"noop"`), `remoteSearchBaseUrl`, `remoteSearchApiKey`, `remoteSearchTimeoutMs`.

### Changed
- PR #113 runtime + documentation hardening:
  - Fixed `openclaw engram conversation-index-health` false-degraded reports by probing conversation-index QMD availability on demand when status is initially unknown.
  - Added regression test coverage for the on-demand QMD probe path in conversation-index health reporting.
  - Refreshed `README.md` to reflect current v8.3.x capabilities, validation commands, and operator workflows.
  - Added `docs/enable-all-v8.md` with an explicit full-profile config for all v8 feature families and post-config verification checklist.
- PR #82 follow-up extraction API compatibility and normalization:
  - Migrated extraction/consolidation LLM calls from `responses.parse` to `chat.completions.create` for OpenAI-compatible endpoints.
  - Added direct-client extraction path and retained fail-open fallback behavior for local/gateway extraction paths.
  - Normalized parsed facts/questions from non-schema-enforced completions output before persistence to avoid malformed question/fact records.
- PR #82 follow-up recall injection compatibility:
  - Return both `systemPrompt` and `prependContext` from `before_agent_start` so memory context is injected across gateway variants.
- PR #110 QMD daemon reliability and warm-path parity:
  - Replaced unreachable HTTP daemon transport with a managed stdio `qmd mcp` session.
  - Corrected daemon query tool/argument usage to `query` with `limit`.
  - Added daemon fast paths for BM25 and vector search to reduce cold subprocess latency.
  - Hardened subprocess parsing for `No results found.` outputs and preserved fail-open fallback behavior.
- PR #75 recall pipeline adaptation for current v8 main:
  - Added `recallBudgetChars` and ordered `recallPipeline` config contracts with per-section enable/limits and profile consolidation thresholds.
  - Refactored recall assembly to section-bucket ordering with section-level caps while preserving existing v8 retrieval semantics.
  - Launched transcript/summaries/conversation-recall/compounding section fetches in parallel with preamble retrieval while keeping pipeline-ordered final assembly.
  - Fixed profile consolidation target-line consistency by using dynamic target lines in gateway fallback schema and OpenAI prompt text.
  - Fixed knowledge-index override caching so per-call override requests do not reuse stale default-cache snapshots.
  - Added tests for recall pipeline config parsing/defaults, knowledge-index override cache behavior, and custom pipeline reorder/disable assembly behavior.
- v8.16 Task 5 hardening update:
  - Added a compounding-artifact review checklist to `docs/ops/pr-review-hardening-playbook.md` covering provenance integrity, advisory-only promotion contract, outcome-summary consistency, and duplicate parsing drift prevention.
- PR #57 work extraction boundary hardening:
  - Preserved linked work payload text containing wrapper-like tokens such as `[WORK_LAYER_CONTEXT link_to_memory=...]`.
  - Escaped wrapper opener/closer tokens during work-layer wrapping and restored them only after boundary cleanup.
  - Added regression coverage for metadata-like literal opener text in linked payloads.
- PR #42 review-hardening backfill for Cursor findings (PRs #37-#40):
  - Fixed continuity incident read-limit handling to guard `NaN` limits and to apply state filtering before result capping.
  - Fixed continuity incident close-path ID lookup to verify parsed frontmatter ID before using filename suffix matches.
  - Simplified continuity incident state parsing (removed redundant ternary branch).
  - Fixed identity anchor merge to always persist sentinel cleanup for existing sections.
  - Gated continuity-audit reference reads behind `continuityAuditEnabled` and bounded compounding incident scans.
  - Added regression tests for all above cases (storage, tools/CLI state filtering, compounding gate, anchor sentinel cleanup).
- PR #34 recall hardening + dedupe tooling:
  - Switched recall retrieval to daemon-preferred `search()` with bounded hybrid backfill to reduce contention and preserve fail-open behavior.
  - Kept `hybridSearch()` as BM25+vector diversification path (no daemon short-circuit), so backfill can broaden recall candidates.
  - Added graph-assist guardrails so full-mode graph expansion requires `multiGraphMemoryEnabled=true`.
  - Added bounded TMT summary input capping helpers to avoid oversized summarization payloads.
- PR #33 stability pass:
  - Fixed `buildRecallQueryPolicy` to preserve raw non-cron prompts (no whitespace normalization) when cron recall policy is not active.
  - Replaced cron prompt bullet/numbered-line regex scoring with deterministic parsing to avoid regex-risk findings on untrusted input.
  - Added regression coverage for raw-prompt preservation in non-cron and cron-policy-disabled paths.

### Added
- v8.8 live graph dashboard (remaining backlog slice):
  - Added graph snapshot/diff helpers (`dashboard/lib/graph-parser.ts`, `dashboard/lib/graph-diff.ts`) with deterministic patching behavior.
  - Added optional dashboard runtime server with API + WebSocket streaming (`src/dashboard-runtime.ts`) and standalone entrypoint/static UI (`dashboard/server.ts`, `dashboard/public/*`).
  - Added CLI lifecycle wrappers/commands for dashboard process management: `openclaw engram dashboard start|status|stop`.
  - Added tests: `dashboard/lib/graph-diff.test.ts`, `tests/dashboard-server.test.ts`, and `tests/cli-dashboard.test.ts`.
- v8.5 session integrity + recovery ops (remaining backlog slice):
  - Added transcript/checkpoint integrity analyzer + bounded repair planner/apply workflow (`src/session-integrity.ts`).
  - Added transcript recovery summary surface (`TranscriptManager.getRecoverySummary`) and orchestrator passthrough (`Orchestrator.getRecoverySummary`).
  - Added CLI command wrappers/surfaces: `openclaw engram session-check` and `openclaw engram session-repair` (`--dry-run`/`--apply`, guarded `--allow-session-file-repair`).
  - Added tests: `tests/session-integrity.test.ts`, `tests/cli-session-integrity.test.ts`, and `tests/recovery-summary.test.ts`.
- v8.16 Task 4 (compounding artifacts expansion):
  - Added `compounding/rubrics.md` weekly artifact generation with deterministic agent rubric sections.
  - Added provenance annotations for feedback-derived weekly patterns and rubric updates (`inbox.jsonl` line + entry key).
  - Added outcome-aware weekly weighting summaries by action (`applied/skipped/failed/unknown` + conservative weighted score).
  - Added optional advisory promotion-candidate section (gated by `compoundingSemanticEnabled`; no automatic shared-memory writes).
  - Added tests: `tests/compounding-weekly-artifacts.test.ts` and `tests/compounding-outcome-weighting.test.ts`.
- v8.16 Task 3 (optional semantic cross-signal enhancer):
  - Added optional shared-context semantic overlap enhancement pass behind config gate (`sharedCrossSignalSemanticEnabled`).
  - Added strict timeout guard (`sharedCrossSignalSemanticTimeoutMs`) and candidate bound (`sharedCrossSignalSemanticMaxCandidates`) with fail-open fallback to deterministic overlaps.
  - Added backward-compatible config aliases for existing `crossSignalsSemantic*` keys.
  - Added semantic enhancement metadata to daily `cross-signals/<YYYY-MM-DD>.json` report output.
  - Added tests: `tests/config-shared-context-semantic.test.ts` and `tests/shared-context-cross-signals-semantic.test.ts`.
- v8.16 Task 2 (deterministic shared cross-signals):
  - Added deterministic cross-signal generation in shared-context daily curation from agent outputs plus feedback decision aggregates.
  - Added persisted daily report artifact at `shared-context/cross-signals/<YYYY-MM-DD>.json`.
  - Added roundtable `Cross-Signals` summary section with overlap highlights and generated artifact path.
  - Updated `shared_context_curate_daily` tool response to return both roundtable and cross-signal artifact paths.
  - Added `tests/shared-context-cross-signals.test.ts` for empty-day, single-source, and multi-source overlap coverage.
- v8.16 Task 1 (migration CLI command group):
  - Added `openclaw engram migrate` subcommands: `normalize-frontmatter`, `rescore-importance`, `rechunk`, and `reextract --model <id>` (dry-run by default).
  - Added bounded migration wrappers in `src/cli.ts` with hard caps and explicit `--write` semantics.
  - Added re-extraction request queue persistence in storage (`state/reextract-jobs.jsonl`) via append/read helpers.
  - Added `tests/cli-migrate.test.ts` coverage for dry-run behavior and write-path correctness.
  - Updated `docs/operations.md` and `docs/import-export.md` with migration runbook guidance.
- v8.15 behavior-loop Task 1 (config + state contracts):
  - Added behavior-loop auto-tuning config keys with bounded defaults and explicit zero-safe parsing semantics.
  - Added typed behavior-loop policy contracts in `src/types.ts` and corresponding Zod schemas in `src/schemas.ts`.
  - Extended `tests/config-proactive-policy.test.ts` to cover defaults, explicit zero overrides, and numeric clamping for behavior-loop settings.
- v8.15 behavior-loop Task 2 (signal ingestion pipeline):
  - Added `src/behavior-signals.ts` for correction/preference signal normalization and deterministic dedupe keys.
  - Added append-only behavior signal ledger support in storage (`state/behavior-signals.jsonl`) with fail-open reads and persisted dedupe by `memoryId+signalHash`.
  - Wired extraction persistence to emit namespace-safe correction/preference behavior signals per target storage namespace.
  - Added `tests/behavior-signals.test.ts` and expanded `tests/storage-policy-state.test.ts` for signal generation, timestamp/namespace safety, and dedupe invariants.
- v8.15 behavior-loop Task 3 (bounded policy learner):
  - Added `src/behavior-learner.ts` with deterministic, bounded policy adjustment proposals over behavior-signal windows.
  - Added strict tunable-parameter allowlist and protected-parameter enforcement to prevent mutation of guarded config contracts.
  - Added clamp helpers in lifecycle/recall query policy modules for learner-consistent threshold/token-cap bounds.
  - Added `tests/behavior-learner.test.ts` coverage for tunable-only updates, protected-parameter immutability, min-signal gating, and max-delta enforcement.
- v8.15 behavior-loop Task 4 (runtime application + rollback):
  - Added `src/policy-runtime.ts` with atomic runtime snapshot files (`state/policy-runtime.json`, `state/policy-runtime.prev.json`).
  - Added guarded runtime application path with invalid-adjustment rollback and protected-parameter enforcement.
  - Wired orchestrator retrieval/lifecycle consumers to load and apply runtime policy overrides fail-open.
  - Added `tests/policy-runtime-application.test.ts` coverage for runtime apply/load, recall-mode contract safety, and rollback restoration on invalid updates.
- v8.15 behavior-loop Task 5 (policy observability + rollback CLI):
  - Added CLI commands `openclaw engram policy-status`, `openclaw engram policy-diff --since <window>`, and `openclaw engram policy-rollback`.
  - Added runtime policy snapshot/diff helpers with evidence counts and top contributing behavior-signal summaries.
  - Added per-turn recall telemetry policy version tagging in recall summary events and last-recall impressions.
  - Added `tests/cli-policy-tuning.test.ts` and expanded `tests/recall-telemetry.test.ts` for policy-version and CLI report coverage.
- v8.15 behavior-loop Task 6 (guardrails + rollout hardening docs):
  - Added explicit behavior-loop hardening checklist to `docs/ops/pr-review-hardening-playbook.md` (artifact isolation, cap-after-filter ordering, config contract, planner mode reachability, and policy-version parity).
  - Added v8.15 auto-tuning rollout guidance and operator command runbook to `docs/setup-config-tuning.md`.
  - Documented rollback-first operator guidance for regression handling during behavior-loop rollout.
- v8.8 network sync Task 1 (WebDAV module):
  - Added `src/network/webdav.ts` with opt-in `WebDavServer` startup (`enabled=false` by default).
  - Added strict allowlist path scoping so requests are limited to explicit root aliases and traversal escapes are rejected.
  - Added optional HTTP Basic auth support and minimal DAV/read endpoints (`OPTIONS`, `PROPFIND`, `GET`, `HEAD`).
  - Added `tests/network-webdav.test.ts` coverage for disabled-by-default behavior, allowlist enforcement, traversal blocking, and auth gating.
- v8.8 network sync Task 2 (Tailscale helper module):
  - Added `src/network/tailscale.ts` with `TailscaleHelper` status gating (`available` + `running`) and a guarded `syncDirectory(...)` helper.
  - Added default command-runner plumbing for `tailscale version`, `tailscale status --json`, and rsync execution with timeout handling.
  - Added `tests/network-tailscale.test.ts` coverage for availability checks, JSON status parsing, daemon-state enforcement, and sync argument construction.
- v8.8 network sync Task 3 (CLI command surfaces):
  - Added network CLI wrappers in `src/cli.ts`: `runTailscaleStatusCliCommand`, `runTailscaleSyncCliCommand`, `runWebDavServeCliCommand`, and `runWebDavStopCliCommand`.
  - Added command surfaces: `openclaw engram tailscale-status`, `openclaw engram tailscale-sync`, `openclaw engram webdav-serve`, and `openclaw engram webdav-stop`.
  - Added `tests/cli-network-commands.test.ts` coverage for helper passthrough, WebDAV serve/stop lifecycle, and auth argument validation.
- v8.8 network sync Task 4 (security + docs):
  - Updated `docs/operations.md` with network sync/WebDAV command runbook and operational safety notes.
  - Updated `SECURITY.md` with explicit v8.8 network-surface guardrails (opt-in defaults, allowlist-only exposure, loopback bind posture, and auth requirements).
- v8.9 compatibility diagnostics Task 1 (core checks):
  - Added `src/compat/types.ts` for compatibility report/check contracts (`ok|warn|error` + summary metadata).
  - Added `src/compat/checks.ts` with deterministic offline compatibility checks for plugin manifest shape, package wiring, core hook registration, Node runtime floor, and QMD binary availability.
  - Added `tests/compat-checks.test.ts` coverage for healthy fixtures, malformed/missing files, and warn/error remediation paths.
- v8.9 compatibility diagnostics Task 2 (CLI command surface):
  - Added `openclaw engram compat [--json] [--strict]` in `src/cli.ts` for local compatibility diagnostics.
  - Added strict-mode exit behavior (`exitCode=1` when warnings/errors are present) and machine-readable JSON output mode.
  - Added `runCompatCliCommand` wrapper plus `tests/cli-compat.test.ts` coverage for default vs strict exit behavior.
- v8.9 compatibility diagnostics Task 3 (fixture-backed diagnostics tests):
  - Added fixture catalog under `tests/compat-fixtures/` for healthy, missing-manifest, and empty-package repository states.
  - Added `tests/compat-fixtures.test.ts` to validate deterministic check outcomes across fixture scenarios.
  - Added fixture usage notes in `tests/compat-fixtures/README.md`.
- v8.9 compatibility diagnostics Task 4 (docs + rollout guidance):
  - Updated `docs/operations.md` CLI runbook with `openclaw engram compat` usage and strict/json mode guidance.
  - Updated `README.md` with compatibility diagnostics quickstart commands for operator rollout checks.
- v8.10 FAISS conversation index Task 1 (config contracts + docs):
  - Added FAISS backend config fields to plugin config contracts and schema (`conversationIndexFaiss*`) while keeping `conversationIndexBackend` default as `qmd`.
  - Added strict parsing/clamping tests in `tests/config-conversation-index-faiss.test.ts`, including zero-safe semantics and malformed input handling.
  - Updated `docs/config-reference.md` and `docs/context-retention.md` with FAISS backend configuration and rollout notes.
- v8.10 FAISS conversation index Task 2 (adapter interface + fail-open wrappers):
  - Added `src/conversation-index/faiss-adapter.ts` with subprocess-backed FAISS adapter APIs (`upsertChunks`, `searchChunks`, `health`) and bounded timeout/stderr/JSON error handling.
  - Added fail-open helper wrappers in `src/conversation-index/indexer.ts` and `src/conversation-index/search.ts` so adapter failures degrade to no-op/empty recall instead of throwing into hook paths.
  - Added `tests/conversation-index-faiss-adapter.test.ts` coverage for success, timeout, non-zero exit, malformed payload, and fail-open wrapper behavior.
- v8.10 FAISS conversation index Task 3 (Python sidecar CLI + smoke tests):
  - Added `scripts/faiss_index.py` JSON-in/JSON-out sidecar commands (`upsert`, `search`, `health`) with fail-open error envelopes and deterministic local `__hash__` embedding mode for smoke validation.
  - Added `scripts/faiss_requirements.txt` and `scripts/faiss/README.md` with dependency and operational contract guidance.
  - Added `tests/conversation-index-faiss-smoke.test.ts` with sidecar contract checks and a dependency-gated FAISS upsert/search smoke path.
- v8.10 FAISS conversation index Task 4 (orchestrator backend wiring + parity tests):
  - Wired orchestrator conversation-index flow to select `qmd` or `faiss` backend paths for startup health checks, index updates, and semantic recall queries.
  - Preserved fail-open recall behavior for FAISS search/upsert failures and kept semantic-recall section formatting backend-agnostic via shared formatter logic.
  - Added `tests/conversation-index-integration.test.ts` coverage for backend routing (`qmd` vs `faiss`), FAISS fail-open recall, formatting parity, and FAISS update-path routing.
- v8.10 FAISS conversation index Task 5 (ops health command + docs):
  - Added orchestrator `getConversationIndexHealth()` with backend-aware status (`qmd`/`faiss`), chunk-doc counts, and last-update metadata.
  - Added CLI command surface `openclaw engram conversation-index-health` via `runConversationIndexHealthCliCommand`.
  - Added `tests/cli-conversation-index-health.test.ts` coverage for CLI wrapper behavior and backend health/fail-open scenarios.
  - Updated `docs/operations.md` and `docs/setup-config-tuning.md` with conversation-index health command usage.
- v8.13 action-policy Task 3 (tooling + namespace-aware action audit):
  - Added CLI helper/command `openclaw engram action-audit` to report namespace-aware action totals by action, outcome, and policy decision.
  - Extended `memory_action_apply` tool with `dryRun` support for safe no-write validation.
  - Added `tests/cli-memory-action-audit.test.ts` and expanded `tests/tools-compression-actions.test.ts` for dry-run behavior.
  - Updated `docs/api.md` and `docs/operations.md` with action-audit and dry-run usage guidance.
- v8.13 action-policy Task 4 (lifecycle + compounding feedback loop):
  - Added bounded memory-action outcome priors to lifecycle evaluation so recent action outcomes can gently influence transition scoring without changing baseline behavior when telemetry is absent.
  - Added compounding ingestion of denied/deferred/skipped/failed memory-action events into weekly mistake-pattern synthesis.
  - Added `tests/memory-action-lifecycle-integration.test.ts` and expanded `tests/compounding.test.ts` coverage for bounded-prior behavior and compounding pattern extraction.
- v8.13 action-policy Task 5 (rollout + risk controls):
  - Added conservative/balanced/research rollout preset guidance for action-policy and compression-learning settings.
  - Added operator hardening checklist for staged promotion and rollback order.
  - Documented disabled-path compatibility guarantees (`enabled=false` and zero-limit semantics remain hard disables).
- v8.14 hot/cold parity Task 1 (tier-parity config contract):
  - Added tier migration/parity config keys and defaults (`qmdTierMigrationEnabled`, demotion/promotion thresholds, parity toggles, auto-backfill flag).
  - Added parser coverage in `tests/config-cold-qmd.test.ts` for defaults and explicit zero-preservation semantics.
  - Updated plugin schema/UI surface and config reference documentation for the new tier controls.
- v8.14 hot/cold parity Task 2 (value-aware tier routing):
  - Added `src/tier-routing.ts` with deterministic `computeTierValueScore(...)` and `decideTierTransition(...)` helpers.
  - Reused lifecycle value inputs from `src/lifecycle.ts` to avoid duplicated weighting logic.
  - Added `tests/tier-routing.test.ts` coverage for scoring signals, threshold boundaries, and disabled-path no-op behavior.
  - Updated `docs/architecture/memory-lifecycle.md` with tier-routing signal/decision contracts.
- v8.14 hot/cold parity Task 3 (migration executor + parity metadata):
  - Added `src/tier-migration.ts` with per-memory journaling and deterministic hot/cold migration execution.
  - Added storage migration primitives in `src/storage.ts` for tier-path resolution and atomic move/copy writes.
  - Added collection-targeted QMD sync helpers in `src/qmd.ts` (`updateCollection`, `embedCollection`) for tier-specific reindexing.
  - Added `tests/tier-migration.test.ts` coverage for demotion/promotion routing, metadata parity retention, and idempotent reruns.
- v8.14 hot/cold parity Task 4 (bounded extraction + maintenance migration loops):
  - Wired orchestrator tier migration cycle into extraction completion and maintenance/consolidation paths with fail-open behavior.
  - Added bounded migration cycle budgeting (`limit`, `scanLimit`, `minIntervalMs`) via `CompoundingEngine.tierMigrationCycleBudget(...)`.
  - Added `tests/orchestrator-tier-migration.test.ts` and `tests/compounding-tier-migration.test.ts` coverage for enabled/disabled wiring and non-vacuous maintenance bounds.
- v8.14 hot/cold parity Task 5 (retrieval parity enforcement):
  - Enforced artifact-path isolation in cold fallback generic recall so `artifacts/` memories remain exclusive to the dedicated verbatim artifact path.
  - Added graph-expansion parity for cold fallback retrieval when `qmdTierParityGraphEnabled` is enabled.
  - Added regression coverage in `tests/retrieval-hot-cold-parity.test.ts` and `tests/graph-cold-tier-parity.test.ts`.
- v8.14 hot/cold parity Task 6 (tier telemetry + operator CLI controls):
  - Added persisted tier migration telemetry state (`state/tier-migration-status.json`) with cumulative counters and last-cycle summary.
  - Added CLI command surfaces: `openclaw engram tier-status` and `openclaw engram tier-migrate` (`--dry-run`, `--write`, `--limit`).
  - Added `tests/cli-tier-status.test.ts` plus dry-run orchestration coverage for manual bounded migration passes.
- v8.13 action-policy Task 2 (deterministic evaluator + orchestration traces):
  - Added `src/memory-action-policy.ts` with deterministic `allow|defer|deny` evaluation and explicit rationale precedence.
  - Integrated policy evaluation into orchestrator action-event ingestion so policy decisions run before action telemetry is persisted.
  - Persisted policy decision traces (`policyDecision`, `policyRationale`, `policyEligibility`) on action events for observability.
  - Added `tests/memory-action-policy.test.ts` coverage for precedence, disabled-flag behavior, and zero-limit semantics.
- v8.13 action-policy Task 1 (taxonomy + eligibility contracts):
  - Added typed action-policy contracts in `src/types.ts` (`MemoryActionPolicyDecision`, eligibility context/source/lifecycle unions, and policy result contract).
  - Added strict schemas in `src/schemas.ts` for action taxonomy and eligibility context, plus fail-open parse helpers with default-safe fallbacks.
  - Added `tests/memory-action-contracts.test.ts` coverage for taxonomy acceptance, strict-schema rejection, and fallback behavior.
  - Updated `docs/architecture/memory-lifecycle.md` with v8.13 action-policy contract documentation.
- v8.12 graph retrieval phase 2 Task 4 (graph health diagnostics command):
  - Added `analyzeGraphHealth(...)` in `src/graph.ts` to report per-edge-file integrity, corruption counts, valid edge totals, and unique node coverage.
  - Added CLI wrapper/command `openclaw engram graph-health` with optional `--repair-guidance` for non-destructive remediation hints.
  - Added `tests/cli-graph-health.test.ts` coverage for corruption detection, coverage reporting, and repair-guidance gating.
  - Updated `docs/operations.md` with graph-health command usage and diagnostics guidance.
- v8.12 graph retrieval phase 2 Task 3 (shadow-eval assist mode in full recall):
  - Added `graphAssistShadowEvalEnabled` config flag (default `false`) to run full-mode graph assist as compare-only shadow evaluation.
  - Kept full-mode injected recall output baseline-identical when shadow mode is enabled, while still computing graph-expanded candidates.
  - Added shadow comparison telemetry in recall timings (`graphShadow`) with baseline/graph overlap and average score delta.
  - Added `tests/graph-shadow-eval.test.ts` for baseline-preservation and telemetry emission coverage.
  - Updated config + tuning docs (`docs/config-reference.md`, `docs/setup-config-tuning.md`) and plugin schema.
- v8.12 graph retrieval phase 2 Task 2 (richer graph provenance snapshots):
  - Extended graph spreading-activation outputs to include per-result provenance (`seed`, `hopDepth`, `decayedWeight`, `graphType`).
  - Persisted bounded provenance in `last_graph_recall.json` with capped seed/expanded arrays for high-traffic safety.
  - Updated graph explain output (`memory_graph_explain_last_recall`) to include concise per-result provenance details.
  - Added parsing/bounding helper in `src/recall-state.ts` and expanded graph integration tests for provenance fields.
  - Updated `docs/architecture/retrieval-pipeline.md` with graph provenance snapshot behavior.
- v8.12 graph retrieval phase 2 Task 1 (expansion scoring controls):
  - Added graph expansion scoring config knobs: `graphExpansionActivationWeight`, `graphExpansionBlendMin`, and `graphExpansionBlendMax` with clamped parse-time handling.
  - Added bounded blend function for graph-expanded candidate scoring to combine normalized activation with seed QMD signal while enforcing configurable score bounds.
  - Updated graph expansion path in orchestrator to use blended scoring per namespace seed set.
  - Added `tests/graph-recall-scoring.test.ts` for monotonic blend behavior and filter-before-cap invariants, plus config clamp/default coverage updates.
  - Documented new graph scoring controls in `docs/config-reference.md` and `openclaw.plugin.json`.
- v8.11 compression optimizer Task 5 (runtime integration + guardrails):
  - Added runtime recall integration for active compression guidelines via a guarded section injected only when context-compression actions and guideline learning are both enabled.
  - Added fail-open guideline parsing/extraction helper (`formatCompressionGuidelinesForRecall`) that reads only the suggested-guidelines block for recall usage.
  - Preserved zero-change path behavior when optimizer learning is disabled by short-circuiting before guideline/state reads.
  - Added `tests/recall-compression-guideline-application.test.ts` coverage for disabled (byte-equivalent guard), enabled, and malformed guideline/state cases.
- v8.11 compression optimizer Task 4 (optimizer tool + cron-safe entry point):
  - Added public orchestrator entry point `optimizeCompressionGuidelines(...)` with `dryRun` + `eventLimit` controls and explicit optimization summary fields.
  - Added `compression_guidelines_optimize` tool with dry-run support and summary output including old/new guideline versions and changed-rule count.
  - Kept runtime fail-open behavior by reusing deterministic baseline + optional semantic refinement pipeline in the shared optimizer path.
  - Added `tests/tools-compression-optimize.test.ts` coverage for disabled gate handling, parameter passthrough, and summary output.
  - Updated `docs/operations.md` with tool usage and cron-safe execution guidance.
- v8.11 compression optimizer Task 3 (optional semantic refinement pass):
  - Added optional semantic refinement pipeline in `src/compression-optimizer.ts` behind explicit enable flag + hard timeout fail-open behavior.
  - Added config surface for refinement gating: `compressionGuidelineSemanticRefinementEnabled` and `compressionGuidelineSemanticTimeoutMs` (with schema/UI wiring and parse-time clamping).
  - Wired orchestrator guideline-learning to run deterministic baseline first, then optional semantic refinement via bounded local-LLM runner before persisting outputs.
  - Added `tests/compression-optimizer-semantic.test.ts` coverage for disabled, timeout, runner-error fail-open behavior, and bounded update application.
  - Updated `docs/setup-config-tuning.md` with rollout guidance for semantic refinement.
- v8.11 compression optimizer Task 2 (deterministic engine + orchestrator wiring):
  - Added `src/compression-optimizer.ts` with deterministic telemetry aggregation, bounded rule-delta computation, and conservative sparse-sample behavior.
  - Included downstream recall-quality marker parsing from telemetry notes to inform per-action confidence and direction.
  - Wired orchestrator guideline-learning pass to compute/write versioned optimizer state and guideline markdown from the deterministic candidate.
  - Added `tests/compression-optimizer.test.ts` and updated `tests/orchestrator-compression-guidelines.test.ts` for deterministic candidate/output and state-write coverage.
- v8.11 compression optimizer Task 1 (state model + versioned storage):
  - Added typed optimizer state contracts in `src/types.ts` for version, source window, event counts, and guideline version metadata.
  - Added strict/fail-open storage APIs in `src/storage.ts`: `writeCompressionGuidelineOptimizerState` and `readCompressionGuidelineOptimizerState`.
  - Added `tests/storage-policy-state.test.ts` coverage for optimizer state round-trip, malformed-state fail-open fallback, and missing-state behavior.
  - Updated `docs/config-reference.md` to document persisted optimizer state at `state/compression-guideline-state.json`.
- v8.7 custom memory routing rules Task 1 (routing engine):
  - Added `src/routing/engine.ts` with deterministic route-rule evaluation, regex/keyword matching, and priority-ordered selection.
  - Added safe route target validation for categories and namespaces (path traversal and separator rejection).
  - Added `tests/routing-engine.test.ts` coverage for matching behavior, ordering, and target validation guardrails.
- v8.7 custom memory routing rules Task 2 (config + persisted rules):
  - Added `src/routing/store.ts` with fail-open persisted routing rule reads, normalized writes, and upsert/remove helpers.
  - Added config surface for routing rules: `routingRulesEnabled` and `routingRulesStateFile`.
  - Added `tests/routing-store.test.ts` and `tests/config-routing-rules.test.ts` coverage for store behavior and config defaults/overrides.
- v8.7 custom memory routing rules Task 3 (CLI management commands):
  - Added `openclaw engram route list|add|remove|test` command support in `src/cli.ts`.
  - Added `runRouteCliCommand` wrapper with target parsing/validation and routing rule store integration.
  - Added `tests/cli-routing-commands.test.ts` coverage for route command add/list/test/remove behavior and validation failures.
- v8.7 custom memory routing rules Task 4 (orchestrator wiring + docs):
  - Added write-time routing in `persistExtraction(...)` so rule matches can retarget extracted facts by category/namespace before persistence.
  - Added fail-open behavior for routing rule load/evaluation errors to preserve default extraction writes.
  - Added `tests/orchestrator-routing-rules.test.ts` coverage for category+namespace reroute behavior.
  - Documented routing config/ops surfaces in `docs/config-reference.md` and `docs/operations.md`.
- v8.7 work management Task 3 (board generation + import/export helpers):
  - Added `src/work/board.ts` with board snapshot export, Kanban markdown rendering, and snapshot import helpers.
  - Added `tests/work-board.test.ts` coverage for project-scoped board export and import create/update behavior.
  - Updated `docs/operations.md` with work board helper usage notes.
- v8.7 work management Task 2 (task/project CLI command slice):
  - Added `openclaw engram task <action>` and `openclaw engram project <action>` command surfaces in `src/cli.ts`.
  - Added CLI wrappers `runWorkTaskCliCommand` and `runWorkProjectCliCommand` with validation for status/priority transitions and required IDs.
  - Added `tests/cli-work-commands.test.ts` coverage for task/project CRUD flows, linkage behavior, and transition guardrails.
- v8.7 work management Task 1 (work item models + storage slice):
  - Added `src/work/types.ts` with task/project model contracts, ownership metadata, and status enums.
  - Added `src/work/storage.ts` for markdown-frontmatter task/project persistence, CRUD operations, status transitions, and task-to-project linkage.
  - Added `tests/work-storage.test.ts` coverage for task/project CRUD, transition guards, linkage behavior, and frontmatter file persistence.
- v8.6 observation-ledger maintenance Task 5 (docs/runbook slice):
  - Updated `docs/operations.md` with an observation-ledger maintenance runbook covering archive/rebuild/migrate commands.
  - Documented dry-run defaults, `--write` mutation mode, and operational guarantees (backup-first writes, deterministic UTC hour bucketing, idempotent no-op migration behavior).
- v8.6 observation-ledger maintenance Task 4 (CLI command surfaces slice):
  - Added CLI wrappers in `src/cli.ts` for archive/rebuild/migrate observation maintenance flows with safe dry-run defaults.
  - Added commands: `openclaw engram archive-observations`, `openclaw engram rebuild-observations`, and `openclaw engram migrate-observations`.
  - Added `tests/cli-maintenance-suite.test.ts` coverage for dry-run defaults and explicit write-mode behavior.
- v8.6 observation-ledger maintenance Task 3 (migration service slice):
  - Added `src/maintenance/migrate-observations.ts` to migrate legacy observation-ledger JSONL shapes into canonical `sessionKey/hour` aggregates.
  - Added dry-run-by-default migration behavior with backup-first replacement of `state/observation-ledger/rebuilt-observations.jsonl`.
  - Added deterministic UTC hour normalization for timezone-less legacy timestamps and bounded malformed-line fail-open parsing.
  - Added `tests/migrate-observations.test.ts` coverage for dry-run scanning, mixed-shape migration, malformed input handling, and backup failure behavior.
- v8.6 observation-ledger maintenance Task 2 (rebuild service slice):
  - Added `src/maintenance/rebuild-observations.ts` to rebuild an observation ledger from transcript history with deterministic session/hour aggregation.
  - Added dry-run-by-default rebuild behavior with backup-first replacement of `state/observation-ledger/rebuilt-observations.jsonl`.
  - Added fail-open parsing for malformed transcript lines during rebuild.
  - Added `tests/rebuild-observations.test.ts` coverage for dry-run, deterministic rebuild output, backup behavior, and malformed-line handling.
- v8.6 observation-ledger maintenance Task 1 (archive service slice):
  - Added `src/maintenance/archive-observations.ts` with deterministic archive candidate scanning across dated transcript, tool-usage, and hourly-summary artifacts.
  - Added dry-run-by-default archival behavior with backup-first copy-then-delete flow into `archive/observations/<timestamp>/...`.
  - Preserved zero-limit compatibility semantics (`retentionDays=0` disables archival).
  - Added `tests/archive-observations.test.ts` coverage for dry-run, live archive, candidate filtering, and zero-retention behavior.
- v8.6 replay ingestion Task 3 (CLI + integration slice):
  - Added `openclaw engram replay` command with source selection, date-range filtering, dry-run, offset/max, and batch controls.
  - Added replay command integration helper in `src/cli.ts` that wires source normalizers into replay execution and optional post-replay consolidation.
  - Added `Orchestrator.ingestReplayBatch(...)` to enqueue replay batches through the existing extraction pipeline with preserved replay timestamps/session keys.
  - Added `tests/cli-replay.test.ts` coverage for dry-run and live ingestion paths.
- v8.6 replay ingestion Task 2 (source normalizers slice):
  - Added source normalizers for `openclaw`, `claude`, and `chatgpt` exports in `src/replay/normalizers/*`.
  - Added robust shape handling for JSON/JSONL transcript exports, including ChatGPT mapping exports and Claude `chat_messages`.
  - Added `tests/replay-normalizers.test.ts` coverage for source parsing, strict-mode validation behavior, role/content/timestamp normalization, and default session key fallbacks.
- v8.6 replay ingestion Task 1 (core contracts slice):
  - Added `src/replay/types.ts` with canonical replay turn schema, parser contracts, and strict validation helpers.
  - Added `src/replay/runner.ts` with source normalizer registry helpers and replay execution flow (dry-run, date range, offset, batching, progress summary).
  - Added `tests/replay-types.test.ts` coverage for validation, batching, range filtering, offset/max limits, dry-run behavior, and registry duplicate guards.
- v8.5 active session observer + heartbeat thresholds slice:
  - Added `src/session-observer-state.ts` to persist per-session observer cursors and threshold/debounce decisions.
  - Added heartbeat observer integration (`agent_heartbeat`) to queue proactive extraction when session growth crosses configured byte/token bands.
  - Added config surface and schema/docs wiring: `sessionObserverEnabled`, `sessionObserverDebounceMs`, `sessionObserverBands`.
  - Added tests: `tests/session-observer-state.test.ts` and `tests/heartbeat-observe-trigger.test.ts`.
  - Normalized session-key examples in docs/comments to generic placeholders to avoid installation-specific identifiers.
- v8.4 improvement-loop register slice (Task 7 / PR #43):
  - Added structured improvement-loop register parsing/serialization helpers in `src/identity-continuity.ts`.
  - Extended `StorageManager` with typed register APIs: read/write register, upsert loop, and review loop metadata updates.
  - Added `continuity_loop_add_or_update` and `continuity_loop_review` tools for managing recurring continuity loops.
  - Extended continuity audit synthesis to detect stale active loops by cadence and surface stale-loop signals/actions.
  - Added `tests/improvement-loop-register.test.ts` and expanded continuity-audit test coverage for stale-loop detection.
- v8.4 documentation/templates slice (Task 8):
  - Added `docs/identity-continuity.md` with artifact contracts, safety boundaries, and rollout tiers.
  - Added generic templates for identity anchors, continuity incidents, and continuity audits.
  - Linked identity continuity docs from `README.md` and `docs/README.md`.
- v8.4 identity injection budgeting + mode gating slice (PR #41):
  - Added runtime identity continuity injection modes (`recovery_only`, `minimal`, `full`) with explicit recovery-intent gating and minimal-mode downgrade safeguards.
  - Added per-section `identityMaxInjectChars` enforcement with trim marker + telemetry for injected chars and truncation state.
  - Extended recall telemetry (`recall_summary`) and last-recall snapshots with identity injection fields for observability/debugging.
  - Added `tests/identity-injection-budget.test.ts` and extended recall mode/telemetry tests for identity mode reachability and budget behavior.
  - Updated retrieval architecture documentation with identity continuity assembly order and telemetry fields.
- v8.4 continuity audit generator slice (PR #40):
  - Added `continuity_audit_generate` tool for deterministic weekly/monthly continuity audit artifacts.
  - Extended `CompoundingEngine` with continuity audit synthesis and signal checks (anchor presence, incident counts, improvement-loop presence, compounding pattern count).
  - Added weekly compounding report linking for available continuity audits when `continuityAuditEnabled=true`.
  - Added `tests/continuity-audit.test.ts` coverage for audit generation, compounding linkage, and tool behavior.
  - Updated `docs/compounding.md` with continuity audit workflow and output locations.
- v8.4 continuity incident workflow slice (PR #39):
  - Added `continuity_incident_open`, `continuity_incident_close`, and `continuity_incident_list` tools.
  - Added `openclaw engram continuity incidents`, `openclaw engram continuity incident-open`, and `openclaw engram continuity incident-close` CLI commands.
  - Added validation for required incident closure fields and state-filtered incident listing behavior.
  - Added `tests/continuity-incidents.test.ts` coverage for tool gating, open/close flows, and listing behavior.
  - Documented continuity incident tools and CLI usage in API/operations docs.
- v8.4 identity anchor tooling slice (PR #38):
  - Added `identity_anchor_get` and `identity_anchor_update` tools behind `identityContinuityEnabled`.
  - Added conservative, section-aware identity-anchor merge behavior to avoid destructive overwrites.
  - Added identity-anchor update audit logging for operational traceability.
  - Added `tests/tools-identity-anchor.test.ts` coverage for gating, retrieval, merge semantics, and validation.
  - Documented identity anchor tools and storage location in API/operations docs.
- v8.4 identity continuity storage slice (PR #37):
  - Added identity continuity artifact types and helpers for anchor, incidents, audits, and improvement-loop storage paths.
  - Added `src/identity-continuity.ts` to create/parse continuity incidents with explicit open/close lifecycle transitions.
  - Extended `StorageManager` with typed read/write APIs for identity continuity artifacts and append-only incident handling.
  - Added fail-open parsing behavior for malformed continuity incident files to preserve baseline runtime behavior.
  - Added `tests/identity-continuity-storage.test.ts` coverage for storage round-trips, incident close transitions, and malformed-file handling.
- v8.4 identity continuity config slice (PR #36):
  - Added new config surface: `identityContinuityEnabled`, `identityInjectionMode`, `identityMaxInjectChars`, `continuityIncidentLoggingEnabled`, and `continuityAuditEnabled`.
  - Added parser semantics for bounded identity injection chars and dynamic default for incident logging (`identityContinuityEnabled` when unset).
  - Added config-schema/UI metadata and config-reference documentation for v8.4 identity continuity.
  - Added `tests/config-identity-continuity.test.ts` and updated typed test fixtures to match the expanded `PluginConfig` contract.
- v8.3 PR 21D (guideline learning + docs hardening slice):
  - Added consolidation-integrated, fail-open compression guideline learning pass behind `compressionGuidelineLearningEnabled`.
  - Added deterministic synthesis of `state/compression-guidelines.md` from recent `state/memory-actions.jsonl` telemetry.
  - Added test coverage for guideline synthesis output and flag-gated pass execution in `tests/orchestrator-compression-guidelines.test.ts`.
  - Expanded v8.3 docs with tool/state artifact details and operator checks for guideline-learning rollout.
- v8.3 PR 21C (compression action tools + telemetry slice):
  - Added `context_checkpoint` and `memory_action_apply` tools behind `contextCompressionActionsEnabled`.
  - Added append-only telemetry wiring through `Orchestrator.appendMemoryActionEvent(...)` to persist policy-learning events into namespace-scoped `state/memory-actions.jsonl`.
  - Added fail-open behavior for tool telemetry writes so action paths do not block runtime flow on storage errors.
  - Added tool-focused coverage in `tests/tools-compression-actions.test.ts` for disabled-mode gating, telemetry writes, namespace handling, and fail-open behavior.
- v8.3 PR 21B (proactive extraction slice):
  - Added a proactive second-pass extraction path in `ExtractionEngine` behind `proactiveExtractionEnabled`.
  - Added strict cap enforcement for proactive follow-up questions via `maxProactiveQuestionsPerExtraction` with zero-safe semantics.
  - Added fail-open behavior: proactive-pass failures are logged and baseline extraction results are preserved.
  - Added question merge/dedupe helper coverage in `tests/extraction-proactive.test.ts`.
- v8.3 PR 21A (proactive/policy-learning foundation slice):
  - Added new config surface (default off): `proactiveExtractionEnabled`, `contextCompressionActionsEnabled`, `compressionGuidelineLearningEnabled`.
  - Added new v8.3 policy limits with zero-safe semantics: `maxProactiveQuestionsPerExtraction` and `maxCompressionTokensPerHour`.
  - Added typed policy-state storage primitives in `StorageManager` for `state/memory-actions.jsonl` and `state/compression-guidelines.md`.
  - Added test coverage for proactive/policy config parsing and policy-state storage read/write behavior.
- v8.3 PR 20D (lifecycle retrieval + docs slice):
  - Added lifecycle-aware retrieval weighting in shared score post-processing with boosts for `active`/`validated` memories and penalties for `candidate`/`stale`/`archived` states.
  - Added stronger retrieval penalty for `verificationState: disputed`.
  - Added optional stale retrieval filtering (`lifecycleFilterStaleEnabled`) applied before final top-K cap.
  - Preserved fail-open behavior for legacy memories with no lifecycle metadata.
  - Added retrieval tests covering lifecycle weighting, stale filtering, and fail-open legacy behavior.
- v8.3 PR 20C (lifecycle consolidation + metrics slice):
  - Added lifecycle policy config surface (`lifecyclePolicyEnabled`, thresholds, protected categories, metrics toggle) across `PluginConfig`, config parsing, and plugin schema/UI hints.
  - Wired lifecycle scoring pass into consolidation to persist lifecycle metadata (`lifecycleState`, `heatScore`, `decayScore`, `lastValidatedAt`) only when changed.
  - Added lifecycle metrics snapshot output at `state/lifecycle-metrics.json` with state counts, transition counts, stale ratio, and disputed ratio.
  - Added lifecycle policy tests for config parsing and consolidation/metrics integration.
- v8.3 PR 20B (deterministic lifecycle engine slice):
  - Added `src/lifecycle.ts` with deterministic, bounded lifecycle scoring functions (`computeHeat`, `computeDecay`) and transition logic (`decideLifecycleTransition`).
  - Added lifecycle guardrails: archived is terminal, disputed memories never auto-promote to active, and protected categories are not auto-archived.
  - Added `tests/lifecycle.test.ts` coverage for bounds, monotonic scoring behavior, and transition guardrails.
- v8.3 PR 20A (lifecycle data-model slice):
  - Added optional lifecycle policy frontmatter fields to `MemoryFrontmatter`: `lifecycleState`, `verificationState`, `policyClass`, `lastValidatedAt`, `decayScore`, and `heatScore`.
  - Extended memory frontmatter serialization/parsing to persist and restore lifecycle metadata, including zero-valued score fields.
  - Added storage lifecycle round-trip tests for parse/serialize behavior and legacy compatibility when lifecycle fields are absent.
- v8.2 PR 19A (planner-gating slice):
  - New config flag `graphRecallEnabled` (default `false`) to explicitly opt into graph recall planner mode.
  - New `resolveEffectiveRecallMode()` guard in recall orchestration: `graph_mode` is only active when both `graphRecallEnabled` and `multiGraphMemoryEnabled` are enabled; otherwise behavior degrades to baseline `full` recall.
  - Added planner/config tests for graph-mode gating and opt-in parsing behavior.
- v8.2 PR 19B (graph-recall integration slice):
  - Added graph-mode recall expansion in `recallInternal`: when planner selects `graph_mode`, QMD seeds are expanded via `GraphIndex.spreadingActivation(...)`, merged/deduped with QMD candidates, then fed through existing boost/rerank/cap stages.
  - Added `state/last_graph_recall.json` trace output capturing graph recall mode, query hash/length, namespace scope, seed paths, and expanded candidates for explainability/debugging.
  - Added helper/test coverage for graph candidate merge semantics and storage-relative graph path resolution.
  - Added integration coverage asserting graph-mode recall writes a snapshot.
- v8.2 PR 19C (graph explainability slice):
  - Added `memory_graph_explain_last_recall` tool to inspect the latest graph-recall snapshot (seed paths + expanded candidates).
  - Added orchestrator APIs `getLastGraphRecallSnapshot()` and `explainLastGraphRecall()` for stable snapshot parsing and operator-friendly explain output.
  - Updated retrieval dispute helper hints to include graph-recall explainability guidance.
  - Added tests for snapshot read + explain formatting behavior.

### Docs
- Updated v8.2 and v8.3 implementation plans to split large releases into smaller PR slices (A-D) for safer review and rollout.
- Documented v8.3 lifecycle retrieval integration and staged rollout guidance in `docs/architecture/memory-lifecycle.md`, `docs/config-reference.md`, and `docs/setup-config-tuning.md`.

## [8.2.0-pr18] — v8.2 PR 18: Multi-Graph Memory

### Added
- Multi-graph memory (MAGMA/SYNAPSE-inspired, behind `multiGraphMemoryEnabled`, default off):
  - New `src/graph.ts`: maintains three typed edge graphs — entity co-reference (`entity.jsonl`), temporal sequence (`time.jsonl`), and causal inference (`causal.jsonl`) — stored under `memory/state/graphs/`.
  - **Entity graph**: edges written during `persistExtraction` when a new memory shares an `entityRef` with existing memories (capped at `maxEntityGraphEdgesPerMemory`, default 10).
  - **Time graph**: edges written between consecutive memories within the same conversation thread.
  - **Causal graph**: edges written when new memory content contains causal signal phrases (`because`, `therefore`, `led to`, `as a result`, `caused`, `because of`).
  - **Spreading activation** (`GraphIndex.spreadingActivation`): SYNAPSE-inspired BFS traversal from seed nodes across all enabled graph types with configurable per-hop decay. Ready for use by PR 19 (graph recall mode).
  - All graph writes are fail-open: any error is caught and logged; memory writes succeed regardless.
  - New config: `multiGraphMemoryEnabled`, `entityGraphEnabled`, `timeGraphEnabled`, `causalGraphEnabled`, `maxGraphTraversalSteps` (default 3), `graphActivationDecay` (default 0.7), `maxEntityGraphEdgesPerMemory` (default 10).

## [8.2.0-pr17] — v8.2 PR 17: Temporal Memory Tree

### Added
- Temporal Memory Tree (TiMem-inspired, behind `temporalMemoryTreeEnabled`, default off):
  - New `src/tmt.ts`: builds a hierarchy of summarised memory nodes — hour → day → week → persona — stored under `memory/tmt/` as markdown files with YAML frontmatter.
  - **Hour nodes** (`tmt/YYYY-MM-DD/hour-HH.md`): consolidated when `>= tmtHourlyMinMemories` new memories exist for that hour.
  - **Day nodes** (`tmt/YYYY-MM-DD/day.md`): built/updated from hour nodes during daily consolidation.
  - **Week nodes** (`tmt/week-YYYY-WW.md`): rolled up from day nodes when the ISO week turns.
  - **Persona node** (`tmt/persona.md`): synthesised from the 4 most recent week-node summaries.
  - **Recall injection**: the most temporally relevant TMT node is injected between Memory Boxes and QMD results when `temporalMemoryTreeEnabled=true`. Injection is skipped on `no_recall`/`minimal` planner modes.
  - Uses existing `LocalLlmClient` for summarisation via a callback — no additional API cost by default.
  - All node writes are fail-open: errors are caught and logged; consolidation and recall continue regardless.
  - New config: `temporalMemoryTreeEnabled` (default `false`), `tmtHourlyMinMemories` (default `3`), `tmtSummaryMaxTokens` (default `300`).

## [8.1.1-ai-readiness] — AI Readiness Improvements (PR #19)

### Added
- `.env.example` with documented environment variable placeholders
- `.editorconfig` for consistent cross-editor formatting
- `.nvmrc` and `.node-version` pinning Node to 22
- `biome.json` for lint/format tooling integration
- `eslint.config.js` for editor ESLint integration (ignores `dist/`, primary gate remains `tsc --noEmit`)
- `Makefile` with `make test`, `make build`, `make check` targets
- `.cursorignore` to exclude generated/build artifacts from Cursor indexing
- `llms.txt` — machine-readable project summary for AI assistants
- `src/AGENTS.md` — source-level guide for AI agents working on the codebase
- `.agents/` directory with per-agent context and reusable skills (`run-tests`, `add-config-property`)
- `prompts/extraction.prompt.md` and `prompts/consolidation.prompt.md` — documented LLM prompt templates
- `docs/ARCHITECTURE.md`, `docs/tech-stack.md`, `docs/CONVENTIONS.md`, `docs/api.md`, `docs/requirements/README.md`
- `tests/fixtures/` directory with synthetic test fixtures

## [8.1.0] - 2026-02-22

> Plan codename: **v8.1 — Intent + Temporal Indexing** (PR #15)

### Added
- Query-aware indexing (SwiftMem-inspired, behind `queryAwareIndexingEnabled`, default off):
  - New `src/temporal-index.ts`: maintains `state/index_time.json` (date buckets → memory paths) and `state/index_tags.json` (frontmatter tags → memory paths) after each extraction.
  - Adaptive retrieval prefilter: temporal queries receive a +0.08 score boost; `#tag` tokens in the prompt receive a +0.06 score boost. Additive and fail-open — index absence never breaks recall.
  - Batch indexing runs fire-and-forget after extraction to avoid blocking the write path.
  - New config: `queryAwareIndexingEnabled`, `queryAwareIndexingMaxCandidates`.

## [8.0.3] - 2026-02-22

> Plan codename: **v8.0 Phase 2C — Docs IA Overhaul** (PR #14)

### Added
- Docs IA overhaul foundation:
  - Rewrote `README.md` to be short (value prop, quick install, 5-minute setup, docs table).
  - New `docs/getting-started.md` — install, QMD setup, 5-minute config, verification.
  - New `docs/operations.md` — backup/export, CLI, hourly summaries, file hygiene, logs.
  - New `docs/config-reference.md` — single source of truth for all config flags and defaults.
  - New `docs/architecture/overview.md` — system design, components, storage layout, frontmatter schema.
  - New `docs/architecture/retrieval-pipeline.md` — full retrieval pipeline diagram and stage descriptions.
  - New `docs/architecture/memory-lifecycle.md` — write path, consolidation, expiry, dedup, box lifecycle, HiMem.
  - Updated `docs/README.md` to reflect the new IA with links to all new docs.

## [8.0.2] - 2026-02-22

> Plan codename: **v8.0 Phase 2B — Episode/Note Dual Store (HiMem)** (PR #13)

### Added
- Experimental Episode/Note dual store (HiMem, all behind config flags, default off):
  - **Episode/Note classification** (`episodeNoteModeEnabled`): each extracted memory is tagged with `memoryKind: episode` (time-specific event) or `memoryKind: note` (stable belief, preference, decision, constraint). Uses heuristic signals (temporal language, stable-belief keywords, tags, category).
  - New config: `episodeNoteModeEnabled`.

## [8.0.1] - 2026-02-22

> Plan codename: **v8.0 Phase 2A — Memory Boxes + Trace Weaving** (PR #12)

### Added
- Experimental Memory Boxes + Trace Weaving (all behind config flags, default off):
  - **Memory Boxes** (`memoryBoxesEnabled`): groups extracted memories into topic-bounded windows stored in `memory/boxes/YYYY-MM-DD/box-<id>.md`. Boxes seal on topic shift, time gap, or max-memory count.
  - **Trace Weaving** (`traceWeaverEnabled`): assigns a shared `traceId` to boxes that repeatedly revisit the same topic cluster, enabling cross-session topic continuity.
  - Recall injection: recent topic windows appear as `## Recent Topic Windows` section after verbatim artifacts when `memoryBoxesEnabled=true`.
  - New config: `boxTopicShiftThreshold`, `boxTimeGapMs`, `boxMaxMemories`, `traceWeaverLookbackDays`, `traceWeaverOverlapThreshold`, `boxRecallDays`.

## [8.0.0] - 2026-02-22

> Plan codename: **v8.0 Phase 1 — Memory OS Core** (PR #11)

### Added
- Experimental memory-os capabilities (all behind config flags, default off):
  - Recall planner (`recallPlannerEnabled`) to choose `no_recall` / `minimal` / `full` / `graph_mode`.
  - Intent-grounded memory routing metadata (`intentGoal`, `intentActionType`, `intentEntityTypes`) with configurable ranking boost.
  - Verbatim artifact persistence + recall injection (`memoryDir/artifacts/**`) for quote-first anchors.
  - New docs entrypoint: `docs/README.md` for the docs reorganization rollout.
- npm-first distribution + release automation:
  - New `Release and Publish` workflow (`.github/workflows/release-and-publish.yml`) that runs on `main` merges, verifies quality gates, bumps version, tags, creates GitHub release, and publishes to npm.
  - Package publish metadata in `package.json`: `engines.node`, `prepack`, and `publishConfig` (`access: public`, `provenance: true`).
  - npm package name scoped to `@joshuaswarren/openclaw-engram`.
- Contributor onboarding and contribution governance docs:
  - New `CONTRIBUTING.md` with standards for issues/PRs, testing, changelog policy, and AI-assisted contributions.
  - New `CONTRIBUTORS.md` with contributor recognition.
  - New GitHub issue templates for bug reports and feature requests.
  - New pull request template with validation and risk checklist.
- Changelog/release process automation:
  - `Changelog Guard` workflow requiring `CHANGELOG.md` updates for source/config/plugin changes (with `skip-changelog` maintainer bypass label).
  - `Release Drafter` workflow + config for automated draft release notes from merged PRs.
  - `Review Thread Guard` workflow that fails PR checks when active review threads are unresolved.
  - Release Drafter autolabeling adjusted so `src/**` changes no longer auto-label as `feature` (avoids accidental minor version bumps for fixes/refactors).
- GitHub Actions quality and security checks for pull requests:
  - `CI` (typecheck, tests, build on Node 22/24)
  - `Dependency Review` (blocks high+ severity dependency risks)
  - `Secret Scan` (Gitleaks on PRs and main pushes)
  - `CodeQL` analysis (PR + weekly schedule)
- `AI Review Gate` workflow requiring review activity from KiloConnect, Codex, and Cursor Bugbot bot groups before merge.

### Changed
- Extraction persistence now infers and stores intent metadata per memory/chunk, enabling intent-compatible recall boosts when enabled.
- Recall assembly now supports optional artifact section injection and planner-driven QMD result caps in minimal mode.
- `no_recall` now short-circuits before preamble fetches (shared context/profile/knowledge index), avoiding unnecessary reads and injection on acknowledgement turns.
- Artifact recall now honors minimal planner caps via `computeArtifactRecallLimit(...)`.
- Intent planner/inference now safely handle non-string/nullish runtime inputs without throwing.
- Embedding fallback recall paths now apply the same `boostSearchResults` ranking stage as primary QMD recall.
- `no_recall` planner mode now hard-sets `recallResultLimit=0` for stronger path-safety invariants.
- Release automation hardening:
  - Protected-branch-safe flow: sync + validate latest `origin/main`, compute next version from tags, create a local release commit (not pushed to `main`), tag that commit, push only the release tag, then create GitHub release and publish to npm.
  - Release tags are annotated tags; annotated tags include `source-main-sha` metadata for idempotency.
  - npm publish uses npm trusted publishing (OIDC via GitHub Actions) instead of `NPM_TOKEN` secrets.
  - Next-version tag discovery ignores non-`vX.Y.Z` tags to avoid malformed version parsing.
- Node version alignment with OpenClaw: `engines.node` is now `>=22.12.0`.
- Installation docs now lead with `openclaw plugins install @remnic/plugin-openclaw --pin`.
- `agent_end` ingestion now ignores non-`user`/`assistant` message roles.
- Recall keeps fail-open headroom: hard recall guard reduced to 75s to stay above QMD worst cases.

### Fixed
- Runtime hardening for missing QMD collections: disables retrieval features when collections are confirmed absent, treats transient failures as `unknown`.
- Recall timeout/failure logs throttled to reduce warning spam.
- Conversation-index paths now use their own availability flag independent of primary `qmdEnabled`.

## [7.2.4] - 2026-02-21

### Fixed
- Fail-open recall improvements + missing QMD collection guards.

## [7.2.3] - 2026-02-20

### Added
- npm package scoped to `@joshuaswarren/openclaw-engram`; trusted OIDC publishing configured.

## [7.2.2] - 2026-02-20

### Fixed
- Release pipeline workflow parser failure; version split uses shell parameter expansion.

## [7.2.1] - 2026-02-19

### Added
- Third-party OpenAI-compatible extraction endpoint support settings:
  - `localLlmApiKey`, `localLlmHeaders`, `localLlmAuthHeader`
  - `qmdPath` override for explicit QMD binary pathing
- Plugin schema + UI hints for the settings above in `openclaw.plugin.json`.
- Regression tests for local LLM abort handling/retry behavior.

### Changed
- Local LLM requests now include operation-aware diagnostics (`op=...`) in timeout/error logs for faster incident triage.
- Extraction/profile/identity/consolidation/hourly-summary/entity-summary local calls now pass explicit operation names for attributed logs.

### Fixed
- Local LLM abort timeouts are now treated as transient: retry with backoff and do not mark local endpoint unavailable immediately.
- Added gateway fallback paths for consolidation/profile/identity JSON parsing when local LLM fails, reducing dropped maintenance passes.

## [2.3.0] - 2026-02-13

### Added
- Optional file hygiene (off by default):
  - Lint selected workspace markdown files (e.g. `IDENTITY.md`, `MEMORY.md`) and warn before truncation risk.
  - Rotate oversized markdown files into `archiveDir`, replacing the original with a lean index plus a small tail excerpt.
  - Config: `fileHygiene.*`

## [2.2.5] - 2026-02-13

### Fixed
- Reduced background extraction crashes by defensively skipping malformed entity payloads.
- Improved structured JSON extraction from LLM outputs when responses contain multiple JSON blocks.
- Reduced QMD update/embed flakiness by serializing QMD CLI calls within the process and retrying on transient SQLite lock errors.

## [2.2.4] - 2026-02-11

### Fixed
- Prevented background extraction crashes when local LLM entity output omits or malforms `entities[].facts`.

### Changed
- Hourly summary cron auto-registration now targets `sessionTarget: "isolated"` with `payload.kind: "agentTurn"`.

## [2.2.3] - 2026-02-10

### Added
- Disagreement heuristic (suggestion-only): when the user pushes back, Engram injects a short helper section encouraging use of `memory_last_recall` and (optionally) `memory_feedback_last_recall`. Never records negative examples automatically.

## [2.2.2] - 2026-02-10

### Added
- Negative examples (retrieved-but-not-useful) feedback loop (opt-in):
  - Config: `negativeExamplesEnabled`, `negativeExamplesPenaltyPerHit`, `negativeExamplesPenaltyCap`
  - Storage: `memoryDir/state/negative_examples.json`
- Last recall snapshot + impression log for debugging/feedback workflows:
  - Storage: `memoryDir/state/last_recall.json`, `memoryDir/state/recall_impressions.jsonl`
  - Tools: `memory_last_recall`, `memory_feedback_last_recall`

### Changed
- Signal scan now treats phrases like "that's not right" / "why did you say that" as high-signal.

## [2.2.1] - 2026-02-10

### Changed
- Documentation clarified: `rerankProvider: "cloud"` is reserved/experimental and currently treated as a no-op.

## [2.2.0] - 2026-02-10

### Added
- Advanced retrieval controls (disabled by default):
  - Heuristic query expansion (`queryExpansionEnabled`, `queryExpansionMaxQueries`, `queryExpansionMinTokenLen`)
  - Optional LLM re-ranking (`rerankEnabled`, `rerankProvider`, `rerankMaxCandidates`, `rerankTimeoutMs`, caching)
  - Optional feedback capture tool (`feedbackEnabled`, `memory_feedback`) stored locally and applied as a soft ranking bias
- Documentation: `docs/advanced-retrieval.md`

## [2.1.0] - 2026-02-10

### Added
- Configurable local LLM hard timeout (`localLlmTimeoutMs`, default 180000ms).
- Optional slow query logging (`slowLogEnabled`, `slowLogThresholdMs`) for local LLM + QMD operations.

### Changed
- Reduced default log verbosity for local LLM model listings.
- QMD failures now include a concise error string and are backoff-suppressed.

### Fixed
- Model context budgeting now clamps output/input to avoid negative input budgets.
- TypeScript typecheck/build issues across CLI, extraction salvage, and plugin SDK typings.

## [1.2.0] - 2026-02-07

### Added
- **Access Tracking (Phase 1A)**: Track memory access counts and recency
  - New frontmatter fields: `accessCount`, `lastAccessed`
  - Batched updates flushed during consolidation (zero retrieval latency)
  - Configurable via `accessTrackingEnabled`, `accessTrackingBufferMaxSize`
- **Local Importance Scoring (Phase 1B)**: Zero-LLM heuristic importance
  - New `importance` field with score (0-1), level, reasons, keywords
  - Pattern-based scoring for critical/high/normal/low/trivial content
  - Category-based boosts (corrections +0.15, principles +0.12, etc.)
  - Keyword extraction for improved search relevance
  - Importance used for ranking boost, not exclusion (quality safeguard)
- **Recency Boosting**: Recent memories ranked higher in search results
  - Configurable `recencyWeight` (0-1, default 0.2)
  - Exponential decay with 7-day half-life
- **Access Count Boosting**: Frequently accessed memories surface higher
  - Log-scale boost capped at 0.1 to prevent runaway effects
  - Configurable via `boostAccessCount`
- **Status Field**: New `status` field for lifecycle management
  - Values: `active` (default), `superseded`, `archived`
  - Non-active memories filtered from default retrieval
- CLI: `engram access`, `engram flush-access`, `engram importance`
- **Automatic Chunking (Phase 2A)**: Sentence-boundary chunking for long memories
  - New frontmatter fields: `parentId`, `chunkIndex`, `chunkTotal`
  - Configurable target tokens (default 200) and overlap (default 2 sentences)
  - Disabled by default, enable with `chunkingEnabled: true`
- CLI: `engram chunks`
- **Contradiction Detection (Phase 2B)**: LLM-verified contradiction resolution
  - Auto-resolve when confidence > 0.9 (configurable)
  - Full audit trail via `status: superseded` and correction entries
  - Disabled by default, enable with `contradictionDetectionEnabled: true`
- **Memory Linking (Phase 3A)**: Build knowledge graph between memories
  - Link types: follows, references, contradicts, supports, related
  - Disabled by default, enable with `memoryLinkingEnabled: true`
- **Conversation Threading (Phase 3B)**: Group memories into threads
  - Auto-detect thread boundaries (session change or 30min gap)
  - Threads stored in `threads/` directory
  - Disabled by default, enable with `threadingEnabled: true`
- CLI: `engram threads`
- **Memory Summarization (Phase 4A)**: Compress old memories into summaries
  - Triggered when memory count exceeds threshold (default 1000)
  - Archives source memories (`status: archived`)
  - Summaries stored in `summaries/` directory
  - Disabled by default, enable with `summarizationEnabled: true`
- **Topic Extraction (Phase 4B)**: TF-IDF topic analysis
  - Topics stored in `state/topics.json`
  - Enabled by default
- CLI: `engram topics`, `engram summaries`

### Changed
- Retrieval now filters out non-active memories by default
- Plan updated to v1.2 with quality safeguards

## [1.1.0] - 2026-02-07

### Added
- LLM trace callback system (`LlmTraceEvent`) for external observability plugins
- Expose orchestrator via `globalThis.__openclawEngramOrchestrator` for inter-plugin discovery
- Token usage reporting on all LLM calls
- CHANGELOG.md

### Changed
- Entity extraction now injects known entity names to reduce fragmentation
- Fuzzy entity matching prevents duplicate entity files
- Profile dedup uses normalized string comparison instead of exact match
- Entity aliases moved from hardcoded source to configurable `config/aliases.json`
- All code examples use generic placeholders (no personal data)

## [1.0.0] - 2026-02-05

### Added
- Initial release: GPT-5.2 extraction, QMD hybrid search, markdown storage
- 10 memory categories: fact, preference, correction, entity, decision, relationship, principle, commitment, moment, skill
- Question generation and identity reflections
- Profile and identity auto-consolidation
- CLI tools for search, store, profile, entities, questions, identity
# 2026-03-07

- add PR28 resume-bundle builder: deterministic bundle assembly from transcript recovery, recent objective-state snapshots, work products, and open commitments, plus the `resume-bundle-build` CLI and docs/tests
- add PR27 resume-bundle format foundation: typed bundle schema/store, config flags, operator-facing status/write CLI, and docs/tests
- add PR5 objective-state memory foundation: typed snapshot schema/store, status CLI, feature flags, and docs/tests
- add PR7 objective-state recall: bounded snapshot search, recall injection flag, objective-state recall section, and docs/tests
- Added the PR9 foundation for action-conditioned causal graph construction, including deterministic causal-stage graph edges derived from typed trajectory records behind `actionGraphRecallEnabled`.

<!-- touchpoint: 2026-08-06 14:22:07 round-4 review-cleanup -->

<!-- post-actions-recovery trigger: 2026-08-06 19:15:58 -->

<!-- retrigger after Actions recovery: 2026-08-06 19:27:56 -->
