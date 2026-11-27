# Architecture Decision Records

Decision records that replaced rationale comments in the source tree.

The COS-743 no-comments sweep moved decision-rationale comments out of the code and into
these records. Each record cites the comments it came from, with the file and line at base
SHA `ce22909cc219e36d0e31b1158a4ab74f175008a0`.

| ADR | Title |
| --- | --- |
| [0001](0001-access-service-surface-contracts.md) | Access-service surfaces delegate through chokepoints and keep their contracts uniform |
| [0002](0002-activity-storage-journal-and-config-validation.md) | Activity storage, journal extraction, and config parsing fail closed at their boundaries |
| [0003](0003-activity-sync-lifecycle-resilience.md) | Activity sync degrades gracefully: durable data first, failures reported, aborts honored, teardown latched |
| [0004](0004-activity-time-and-timezone-semantics.md) | All activity day windows resolve in the configured timezone with exact, canonical instants |
| [0005](0005-alias-and-helper-resolution.md) | Alias and helper resolution prefers the calling module and binds key literals to parameters |
| [0006](0006-architecture-card-deterministic-build-and-surface.md) | Architecture cards are built deterministically with strict surface guarantees |
| [0007](0007-atomic-extension-install.md) | Extension and skills materialization is atomic: stale tmp is swept first, replaces are rename-based with backup, and staged renames are per-file |
| [0008](0008-bearer-token-and-principal-trust.md) | Transport identity resolves once per request from one authoritative token snapshot, capabilities bind to a request-private async context, and principal identities are validated — never stored verbatim |
| [0009](0009-bench-adapter-contracts.md) | Bench adapter corrections are scoped to the owning session and the adapter fails loudly on contract violations |
| [0010](0010-bench-cli-contract.md) | The bench CLI validates at entry, mirrors dry-run to the real run, and publishes exactly the artifacts it produced |
| [0011](0011-benchmark-harness-and-regression-gate.md) | Benchmark performance claims come from the coding-graph harness, and the regression gate validates every load-bearing field before it skips or compares |
| [0012](0012-bitemporal-backfill-no-clobber.md) | Temporal backfill patches only missing or stale batch-anchored bounds, gated on extracted start bounds and the fact category |
| [0013](0013-boundary-dispatch-and-capability-enforcement.md) | Every HTTP/MCP operation dispatches through the boundary with capability and namespace enforcement |
| [0014](0014-boundary-parsing-and-cli-guardrails.md) | Text, diff, and subprocess boundaries parse defensively and fail loudly or fail open — never silently |
| [0015](0015-boundary-registry-and-strict-validation.md) | All surfaces dispatch through one access-boundary registry that owns schema validation, and invalid input is rejected loudly with non-leaking errors — never silently defaulted, coerced, or echoed |
| [0016](0016-boundary-validation-and-dispatch.md) | Every operation is validated and dispatched at one boundary through canonical schemas |
| [0017](0017-bridge-auto-mode-daemon-selection.md) | Auto mode delegates only to a verified same-corpus daemon, discovered the way the server discovers itself, under one shared probe budget |
| [0018](0018-bridge-auto-mode-preflight.md) | Bridge `auto` mode is decided by one validated preflight walk under a single shared deadline |
| [0019](0019-browse-projection-and-cache-invalidation.md) | The SQLite projection accelerates browse but every cache layer is invalidated through one chokepoint, keyed by secure-store key identity, and a broken projection falls back to the full corpus loudly |
| [0020](0020-buffer-admission-and-backpressure.md) | Admission refuses at capacity and never evicts accepted work; caps bound entries and sessions, buffered turn data is never the release valve |
| [0021](0021-buffer-ingress-observation-counters.md) | Buffer-ingress counters are observation-only, identity-memoized, and capped — they change nothing the buffer does |
| [0022](0022-buffer-session-persistence.md) | One atomic file per buffer session with strict symlink and limit guards |
| [0023](0023-callback-and-chain-following.md) | The key extractor follows callbacks through array methods, transform chains, and expression-bodied arrows |
| [0024](0024-capabilities-resolve-once-gating.md) | Feature gates resolve once per operation into frozen CapabilitySets that project 1:1 from config flags |
| [0025](0025-capsule-export-contract.md) | Capsule export is deterministic, rejects ambiguous inputs, and treats transcripts and output locations explicitly |
| [0026](0026-capsule-fork-lineage.md) | Fork lineage is fail-closed on occupied paths, symlink-contained, and written only after successful import |
| [0027](0027-capsule-path-safety.md) | Capsule import, merge, fork, and export validate every path fail-closed before any filesystem mutation |
| [0028](0028-capture-audio-daemon-and-transcription-contracts.md) | The audio capture daemon is identity-verified and loopback-only, honors caller cancellation, and derives stable idempotency keys from content so replays never double-commit |
| [0029](0029-capture-screen-privacy-pipeline-and-daemon.md) | Screen capture checks deny-lists and redacts BEFORE any text is extracted, hashed, or written, and the daemon stays loopback-only with owner-only storage |
| [0030](0030-cas-receipt-crash-safety.md) | Memory writes go through two-phase CAS receipts and crash-evidencing markers |
| [0031](0031-catalog-log-integrity.md) | Namespace catalog log integrity |
| [0032](0032-catalog-test-seams.md) | Deterministic concurrency tests use explicit, never-in-production hook seams |
| [0033](0033-chat-engine-and-session-security.md) | The chat engine is a bounded, confirmation-gated agent whose sessions are principal-bound, path-safe, and race-hardened |
| [0034](0034-chunked-write-parity.md) | Chunked Write Parity and Envelope Inheritance |
| [0035](0035-claim-drain-and-backlog-invariants.md) | Backlog claims are the durable authority for buffered work: no drop, no duplicate extraction, no plan-flattening, no early lease release |
| [0036](0036-cli-boundary-validation-and-secret-hygiene.md) | The CLI validates all input at the boundary and never lets config-derived values reach output |
| [0037](0037-cli-runtime-and-optional-packages.md) | The CLI loads optional packages lazily through computed-specifier dynamic imports with install-hint-only swallowing, and runCli swaps process globals once per invocation behind a re-entry guard |
| [0038](0038-cli-string-coercion-contract.md) | CLI- and env-supplied config values are coerced once at the config boundary |
| [0039](0039-codegraph-optional-runtime-bridge.md) | The optional codegraph engine is loaded dynamically, gated per tool, and degrades with clean tagged codes — never stub success |
| [0040](0040-codex-subscription-provider.md) | The Codex subscription provider authenticates only via the operator's CLI login, runs the child fully sandboxed with an allowlisted environment, redacts all child output, and treats timeouts as timeouts - never as auth failures. |
| [0041](0041-coding-graph-store-cypher-and-engine.md) | The coding-graph store fails loud at its boundaries with tagged failures, and the Cypher layer is a strictly validated read-only subset that never silently drops results |
| [0042](0042-coding-namespace-and-branch-scope.md) | Coding namespaces are sanitized deterministically with disambiguating hashes, combined with the principal base, and read/write paths must agree |
| [0043](0043-compounding-weekly-synthesis.md) | Weekly synthesis is single-flight, atomic, idempotent, and never reports blocked writes as successes |
| [0044](0044-config-precedence-and-discovery.md) | Config resolution: operator-authored values outrank the environment, which outranks host-materialized schema defaults; all surfaces share one discovery order |
| [0045](0045-connector-removal-provenance-fail-closed.md) | Connector removal fails closed on lost or malformed install-time provenance |
| [0046](0046-connector-token-and-install-rollback.md) | Connector bearer tokens live only in tokens.json; installs roll back atomically and removal fails closed |
| [0047](0047-console-trace-recorder-shutdown.md) | The trace recorder never poisons its write chain, drains before close, and every replay/shutdown wait is abortable and time-bounded |
| [0048](0048-consolidation-and-dependency-propagation.md) | Consolidation mutates durably and dependency propagation replays before ready |
| [0049](0049-consolidation-pipeline-provenance.md) | Consolidation snapshots provenance per cluster, writes sealed envelopes, and fans out over the catalog-union namespace set |
| [0050](0050-content-hash-index-publish-safety.md) | Content-hash index deltas are snapshotted per publish with durable retries |
| [0051](0051-contradiction-resolution-and-catalog-integrity.md) | Contradiction resolutions record catalog touches only after durable commit, gate verbs per review-item kind, and treat unresolved judges as needs-user |
| [0052](0052-converge-planning-reliability.md) | Converge planning is resumable and cache-fail-open, and it acts only on classified failures with abort-safe mutation |
| [0053](0053-conversation-to-memory-granularity.md) | Chat exports import durable content one-to-one by default and conversations only as opt-in, size-capped summaries |
| [0054](0054-core-read-path-concurrency-and-contracts.md) | Recall coalescing shares flights with per-caller abort semantics; read-path contracts stay uniform |
| [0055](0055-corpus-identity-and-local-read-isolation.md) | Local file-backed reads exist only while the daemon provably serves this corpus on this host |
| [0056](0056-corpus-sentinel-cache-coherence.md) | A disk-backed corpus version sentinel plus identity-validated caches keep every read coherent across processes, encryption-key changes, and concurrent scans |
| [0057](0057-corpus-store-integrity.md) | Corpus store integrity: scans fail closed on layout corruption, tolerate poisoned entries, run heavy work off-thread, and undo is all-or-nothing with hardened paths |
| [0058](0058-correction-application-safety.md) | Corrections are applied only through storage chokepoints, blocked by tombstones, atomically rescoped, and never leak the secrets they redact |
| [0059](0059-correction-executor-apply-tx-invariants.md) | Correction applies are serialized, non-destructive transactions ordered write-before-retire |
| [0060](0060-correction-planning-classify-policy.md) | Correction planning and classify calls fail closed, time out on ref'd timers, and degrade to a deterministic plan |
| [0061](0061-correction-redaction-policy.md) | Redaction patterns are /.../-wrapped regexes, shape-inspected without execution, and plans keep their raw pattern on disk |
| [0062](0062-crash-safe-storage-protocols.md) | Every multi-file or multi-step storage mutation is crash-safe by ordering: destinations first, sources last, ids and receipts for idempotence, and out-of-band writes bump the sentinel |
| [0063](0063-cross-namespace-search-resilience.md) | Cross-namespace search degrades per leg and reports skips explicitly |
| [0064](0064-cross-process-locks-and-version-pruning.md) | Destructive writes revalidate lock ownership immediately before landing, and version-history pruning only counts committed snapshots |
| [0065](0065-daemon-credential-discovery.md) | Daemon credentials are discovered from the daemon's own unit and config files and re-read fresh per request |
| [0066](0066-daemon-request-resolution.md) | Hook requests resolve endpoint, credential, and namespace through one defined precedence, and ambiguous configuration disables rather than guesses |
| [0067](0067-decision-record-storage-and-supersede.md) | Decision records use a strict sealed-envelope write, a permissive parser, and a collision-guarded supersede flow that mirrors lifecycle status into frontmatter |
| [0068](0068-dedup-fail-open-suppression.md) | Dedup Never Suppresses on Failure or Disablement |
| [0069](0069-dedup-hash-discipline-and-scoping.md) | Dedup Hash Discipline and Match Scoping |
| [0070](0070-dedup-identity-and-scoping.md) | Dedup, temporal backfill, and identity lookups are namespace-scoped, tier-complete, and authoritative-index-first |
| [0071](0071-deep-recall-governance.md) | Deep recall runs one budgeted loop where every dependency races the shared deadline and only active, authorized memories enter the working set |
| [0072](0072-deferred-save-durability.md) | A buffered turn is durable before extraction runs; failed or deferred saves stay pending and retry — memory and disk never silently diverge |
| [0073](0073-delegate-boundary-validation.md) | Caller input and daemon payloads are validated at the boundary; a failure stays a failure instead of becoming data |
| [0074](0074-delegate-call-budget-and-search-discipline.md) | One shared deadline and one fixed result budget govern each delegate call end to end |
| [0075](0075-delegate-host-registration-and-tool-ownership.md) | Both bridge runtimes register through shared per-api ownership records, and an api's bridge mode latches at first binding |
| [0076](0076-deterministic-node-identity-and-edge-resolution.md) | Resolve graph edges against deterministic, content-derived node ids with conservative ambiguity handling |
| [0077](0077-deterministic-offline-standins.md) | Benchmarks run offline and deterministically: model components get labeled stand-ins, production logic is exercised as-is |
| [0078](0078-deterministic-test-fixtures.md) | Test fixtures stay deterministic and honest: partial doubles declare their unused surface, safety idioms fail fast, and background actors are excluded |
| [0079](0079-disclosure-levels-contract.md) | Recall disclosure forms a single ordered ladder with one validation guard shared by CLI, HTTP, and MCP |
| [0080](0080-docs-code-parity-gate.md) | The docs-parity gate merges both CLI registration surfaces and scans only fenced shell blocks |
| [0081](0081-drain-claim-handin-protocol.md) | Drain claims use fenced owner leases with append-only hand-in inboxes |
| [0082](0082-drain-window-safety.md) | Extraction Drain Window Safety and Clearing |
| [0083](0083-dreams-phases-precedence.md) | dreams.phases.* overrides win over legacy top-level lifecycle keys |
| [0084](0084-drift-and-procedural-scan-conventions.md) | Preference-drift and procedure/skill maintenance scans are deterministic, status-inclusion-set driven, zero-respecting, and non-destructive: stamps and salvaged writes never destroy live state, and any write bypassing the extraction pipeline bumps the corpus version. |
| [0085](0085-effective-diff-strict-manifest.md) | The effective-diff gate parses its ignore manifest strictly and fails loud |
| [0086](0086-embedding-generation-atomicity.md) | Embedding-index generations travel and apply as one atomic unit |
| [0087](0087-embedding-index-generation-integrity.md) | The embedding index publishes one atomic generation under a cross-process lock, with symlink containment and recovery at the rename gap |
| [0088](0088-entity-canonical-id-migration-correctness.md) | Entity canonical-id migration parks unresolvable collisions and resumes crash-exactly |
| [0089](0089-entity-ref-canonicalization.md) | Entity references are canonicalized at the write, with post-write repair and a single post-import reconcile marker |
| [0090](0090-entity-reference-write-boundary.md) | Entity references canonicalize at the write boundary under strict symlink discipline |
| [0091](0091-entity-store-read-behavior.md) | Entity store reads isolate errors, abort cheaply, and present canonical identities |
| [0092](0092-episodic-context-recall-section.md) | Episodic context recall is opt-in, namespace-isolated, and fail-open per candidate |
| [0093](0093-event-time-resolution-semantics.md) | Relative event-time expressions resolve against the fact's source turn, with explicit years authoritative and backwards-looking bounds preferring the most recent past period |
| [0094](0094-exporter-okf-and-test-conventions.md) | Exporter lifecycle, OKF bundle, and test-fixture conventions |
| [0095](0095-extraction-content-policy-and-shared-hardening.md) | Extraction content policy, redaction safety, and assorted shared hardening decisions (merged small themes) |
| [0096](0096-extraction-drain-claim-leases.md) | Extraction drains run through durable claims with lease and breaker discipline |
| [0097](0097-extraction-faithfulness-gate-resilience.md) | The extraction faithfulness gate fails open and is hard-bounded by a timeout race |
| [0098](0098-extraction-judge-verdict-pipeline.md) | The extraction judge shares model routing, fails open, and bounds deferral with a compact verdict protocol |
| [0099](0099-extraction-liveness-failure-classification.md) | Extraction pipeline health is measured, degraded states are visible, and failure classification preserves the primary cause |
| [0100](0100-fact-hash-index-concurrency.md) | The content-hash dedup index is deferred, lock-reconciled, fact-partitioned, and treated as a cache whose authority is always re-derived from disk |
| [0101](0101-faithfulness-evidence-locator-context.md) | Evidence quotes are located by the densest matched-term window, and the verifier always sees the full source evidence |
| [0102](0102-faithfulness-local-endpoint-routing.md) | A configured local faithfulness endpoint is an opt-in fast path fully decoupled from the fallback chain |
| [0103](0103-fallback-llm-chain-routing.md) | Model chains route by explicit precedence, degrade to prompt-only once, and propagate terminal failures |
| [0104](0104-feature-gate-rollout-defaults.md) | New capability gates default off until evidence justifies flipping them on |
| [0105](0105-flush-durability-and-extraction-lifecycle.md) | Flush makes session state durable before draining, and extraction lifecycle effects run exactly once per branch |
| [0106](0106-flush-plan-ingest-safety.md) | Flush-plan ingestion is claim-based and at-least-once, hardened against symlink swaps, and adapts chunk size to the daemon's body limit |
| [0107](0107-frontmatter-and-citation-parsing.md) | Memory frontmatter is round-trip safe (emit only when present, preserve explicit zeros, validate on write) and all text parsing is ReDoS-safe and deterministic |
| [0108](0108-gateway-model-routing.md) | Gateway-routed models use provider-qualified routes; the base model stays direct-compatible |
| [0109](0109-gating-and-subject-classification.md) | Destructive memory operations pass a gated controller that records its choice before dispatch, and subject classification is deterministic at write time |
| [0110](0110-git-context-resolution.md) | Git origin URLs normalize to stable project ids; git-context resolution never throws and its cache never serves a stale branch |
| [0111](0111-graph-read-path-contracts.md) | Graph read APIs return tagged results with fixed traversal, dead-code, and snippet semantics |
| [0112](0112-graph-retrieval-scoring-invariants.md) | Graph edge extraction and scoring are order-independent, deterministic, and conservatively bounded |
| [0113](0113-graph-write-atomicity-and-edge-reconciliation.md) | Apply each ingest batch to the coding graph in one transaction with provenance-scoped stale-edge reconciliation |
| [0114](0114-graph-write-path-atomicity.md) | Graph JSONL writes are atomic and lock-revalidated, and tombstones enforce non-resurrection at a single chokepoint |
| [0115](0115-guard-scope-and-exit-semantics.md) | Guards against the disable value are recognized only within the use's own function and only when they exit |
| [0116](0116-harmonic-graph-cache-consistency.md) | The harmonic graph cache is singleflight, validity-deadline-bounded, and defensive at every boundary |
| [0117](0117-hermes-install-atomicity.md) | Hermes installs are atomic: connector.json is written only after YAML and token commit succeed |
| [0118](0118-hermes-shim-install-safety.md) | Hermes shim install only ever writes marker-identified files and rejects unsafe roots |
| [0119](0119-hermes-yaml-block-management.md) | The Hermes `remnic:` config block is written under the resolved Hermes home with guarded YAML and 0o600 token files |
| [0120](0120-hook-fail-open-and-input-hardening.md) | Host hooks fail open, never block the host, and harden every host-supplied input |
| [0121](0121-hot-cold-supersession-scan.md) | Supersession scans hot then cold as one deduplicated snapshot with CAS re-read before each write |
| [0122](0122-http-routes-lifecycle-and-disclosure.md) | HTTP routes stay thin and cacheable with body-over-query precedence, the server releases every timer and connection on shutdown, and operator-facing outputs redact user content |
| [0123](0123-import-bundle-pipeline-safety.md) | Import pipelines refuse unsafe bundle inputs and fail loudly with real exit codes |
| [0124](0124-importer-input-validation-contract.md) | Import adapters reject payloads that cannot be an export with a user-facing error instead of a silent zero-memory success |
| [0125](0125-incremental-reindex-candidates-and-retry.md) | Incremental reindex advances the index head only on authoritative candidate evidence and retries transient failures |
| [0126](0126-injection-screening-and-audit.md) | Prompt-injection screening is deterministic, normalization-hardened, and the audit sweep screens with the deployment's live profile |
| [0127](0127-judge-cache-wiring.md) | Judge wrapping is applied inside the benchmark run and always undone, never left on a reused adapter |
| [0128](0128-judge-cache-write-read-and-accounting.md) | Judge-cache writes never fail a task, reads never consume the judge's phase budget, and every accounting field reflects what actually happened |
| [0129](0129-judge-calibration-and-scoring-determinism.md) | Judge calibration and bench scoring are deterministic and content-free, persisted atomically, with judge identities verifiable on load |
| [0130](0130-judge-calibration-policy.md) | Judge calibration is pinned to one stored full run and only ever seeded from a sufficiently large, complete run |
| [0131](0131-lcm-compaction-write-scope-parity.md) | LCM compaction derives and authorizes its namespace through the same write-scoped plan as observe |
| [0132](0132-lcm-read-authorization-gating.md) | Implicit LCM reads are gated by readable recall namespaces, or suppressed |
| [0133](0133-leaf-key-scan-invariants.md) | Leaf-key guard scans are unambiguous per manifest and keyed by documented path |
| [0134](0134-ledger-claim-write-guards.md) | Claim writes check the tombstone block before readback and salvage oversized sealed-envelope attributes |
| [0135](0135-legacy-artifact-ingest-and-reference-resolution.md) | Stored artifacts are validated completely, upgraded from legacy shapes by documented rules, and references resolve store-first |
| [0136](0136-legacy-migration-cross-platform-compat.md) | Migration-era names and cross-platform realities stay working: legacy CLIs, cursors, config shapes, and payload spellings are honored |
| [0137](0137-lifecycle-ledger-compaction-bounding.md) | The lifecycle ledger is bounded by size-cap-aware compaction that never arms the throttle on incomplete work |
| [0138](0138-lifecycle-ledger-compaction-safety.md) | Lifecycle ledger compaction preserves every historical row, holds the cross-process lock in write mode, and never downgrades encryption at rest |
| [0139](0139-llm-availability-and-rate-limiting.md) | Local LLM client degrades gracefully: probing never caches timeouts, rate limits get a bounded retry budget, and config refusals stay terminal |
| [0140](0140-llm-thinking-and-schema-capability.md) | Provider-specific thinking and schema capabilities are learned, TTL-bounded, and fail open - never sent to a backend that has not proven support |
| [0141](0141-location-subsystem.md) | Location context is opt-in, provider-agnostic through a core registry, and journaled in durable half-open day buckets |
| [0142](0142-lossless-claw-import-semantics.md) | Lossless-claw imports key rows on natural and source identity and keep every write transactionally consistent |
| [0143](0143-lsp-call-edge-resolution.md) | LSP-derived call edges are reconciled only from exhaustive, atomic per-file batches |
| [0144](0144-lsp-call-edge-upgrade.md) | LSP call-edge upgrades are budgeted, provenance-aware, and reconcile conservatively |
| [0145](0145-maintenance-determinism-and-filesystem-safety.md) | Maintenance jobs are deterministic, idempotent, and fail-safe: locks cover snapshot plus rewrite, telemetry persistence is best-effort, and filesystem traversal never escapes its containment root |
| [0146](0146-malformed-catalog-repair.md) | Malformed catalog rows are repaired by a single-flight, bounded, quarantining rewrite |
| [0147](0147-mcp-tool-surface-conventions.md) | MCP tools keep legacy and canonical names alive through automatic aliasing, and the tool surface applies annotations, schemas, token filtering, and protocol checks as uniform final passes |
| [0148](0148-meetings-pipeline.md) | Meeting records and memories are built idempotently behind a generator seam, gated by trust, and excluded from generic recall |
| [0149](0149-mem0-client-contract.md) | The mem0 adapter speaks HTTP through a minimal fetch client whose pagination never leaves the configured origin |
| [0150](0150-memcorrect-corpus-integrity.md) | The MemCorrect corpus is generated by a seeded, schema-validated generator and pinned by content hash |
| [0151](0151-memcorrect-protocol-and-adapters.md) | MemCorrect scores the correction protocol with pure, turn-isolated metrics and integrates third-party adapters faithfully |
| [0152](0152-memory-containment-and-artifact-isolation.md) | Read containment is enforced by canonical-path checks with symlink defense, and artifacts are isolated from generic memory reads |
| [0153](0153-memory-worth-fail-safes.md) | Memory Worth scoring treats corrupt counters as a collapse to the prior, never as evidence |
| [0154](0154-memory-worth-rerank-scoring.md) | Memory Worth rebias preserves upstream ordering and never contaminates the original scores |
| [0155](0155-merge-judge-decision-contract.md) | Merge decisions fail closed to create, treat the judge verdict as untrusted, and compare canonicalized provenance |
| [0156](0156-model-context-budget-guardrails.md) | Output budget is clamped so input always keeps positive headroom against the model context window |
| [0157](0157-namespace-allow-list-enforcement.md) | Every namespace-scoped operation is gated by one fail-closed per-token allow-list chokepoint, and coding contexts bind sessions to project namespaces only at defined points |
| [0158](0158-namespace-isolation-and-token-scope.md) | Namespace authorization follows the authenticated principal and enforced allow-lists on every read and mutation |
| [0159](0159-namespace-posture-fail-closed.md) | Namespace posture is an authorization fact: probed once, cached with health, and failed closed when unproven |
| [0160](0160-namespace-scope-resolution-parity.md) | One scope plan decides read, write, and objective-state namespaces across every surface |
| [0161](0161-namespace-storage-resolution.md) | Namespace storage resolution, path containment, and identity normalization |
| [0162](0162-namespace-storage-resolution-2.md) | Namespace storage is resolved through one routing authority with containment, token decoding, and a safe legacy-raw fallback |
| [0163](0163-normalized-namespace-identity.md) | All namespace identity comparisons use the normalized (trimmed) form |
| [0164](0164-notion-connector-limits-and-watermarks.md) | Notion sync enforces hard resource limits and only advances a database watermark after a fully drained pass |
| [0165](0165-observation-cursor-and-compaction-handoff.md) | Transcript observation is cursor-checkpointed per session, and compaction drains the unobserved tail before flushing |
| [0166](0166-observe-idempotency-and-durable-acceptance.md) | Observe deduplicates by fingerprinted idempotency keys and accepts only after durable capture |
| [0167](0167-observe-lcm-key-parity.md) | All LCM session keys flow through one shared namespaced encoding so writes, reads, and compaction agree |
| [0168](0168-observe-outbox-durability-and-replay.md) | Observe captures survive daemon outages through a durable outbox that replays under one identity per logical observe |
| [0169](0169-observe-scope-plan-authorization.md) | Observe authorizes once, through a read-only scope plan, before any session mutation |
| [0170](0170-offline-persistence-durability.md) | Offline persistence is additive and folds pending queues before snapshots report success |
| [0171](0171-offline-secure-staging-and-drain-ordering.md) | Offline plaintext stages only inside the protected memory root with inherited encryption, config values never leak through diagnostics, and the sync snapshot is built only after the impression drain commits |
| [0172](0172-offline-sync-atomic-generation.md) | Offline sync applies memory changes only through atomic generation transactions |
| [0173](0173-offline-sync-node-local-state-and-excludes.md) | Node-local runtime state is excluded from offline sync on both sides |
| [0174](0174-one-shot-command-honesty.md) | One-shot commands report what they actually did: no silent skips, no swallowed failures, no cross-scope leakage |
| [0175](0175-openclaw-write-path-integrity.md) | OpenClaw shared-context writes pass a single server-derived origin gate and re-read rotated files before overwrite |
| [0176](0176-operator-doctor-and-toolkit.md) | Operator doctor checks share gates, resolve config once, and stay informational |
| [0177](0177-optional-integration-install-lifecycle.md) | Optional integrations install à la carte, load lazily with actionable hints, and their installers are safe to rerun |
| [0178](0178-orchestrator-durability-and-failure-contracts.md) | Orchestrator persistence paths are durable-first and fail in defined directions: buffered turns land before any wait that could abandon them, committed batch facts survive sibling-branch failures, dedup reads from one corpus-authoritative index, and metadata/ancillary failures never reject the primary result. |
| [0179](0179-orchestrator-seams-and-test-harness-safety.md) | Coordinator seams use thin delegation and live accessors, and tests reach private internals only through safety-guarded surfaces |
| [0180](0180-orchestrator-startup-lifecycle-and-seams.md) | Orchestrator startup is hang-guarded and epoch-fenced with deferred, union-covered QMD sync; coordinators hang off stable instance seams that Object.create test doubles can stub; operator config gates (per-dir TTLs, secure store, feature flags) are scoped per instance or per directory and fail closed where unsafe. |
| [0181](0181-orchestrator-supporting-contracts.md) | Shared orchestrator contracts: one abort classification, capability resolution once, routing agreement, and per-call state views |
| [0182](0182-page-versioning-manifest-consistency.md) | Page-version manifest mutations are cross-process locked, published atomically (rename) before any snapshot file is removed, and reconcile stranded commits - a crash or lost race can strand storage but never corrupt or delete a published rollback point. |
| [0183](0183-passive-corrections-and-notifications.md) | Passive correction detection is guarded and polarity-agnostic; notification drains preserve the queue on cancellation |
| [0184](0184-peer-file-format-contracts.md) | Peer identity, interaction-log, and profile files use strict, deterministic on-disk formats that reject malformed input instead of silently coercing it. |
| [0185](0185-peer-profile-reasoner-gates.md) | The peer profile reasoner treats its budgets, thresholds, and LLM-supplied data as fail-closed: state is committed only after writes succeed, and hostile model output cannot shape storage keys or bypass gates. |
| [0186](0186-peer-storage-path-safety.md) | Peer files must never become a path-traversal or symlink-redirection vector. |
| [0187](0187-pending-spill-durability.md) | Pending spill files are drained crash-safely and never cross the plaintext/encrypted boundary |
| [0188](0188-persist-path-gate-ordering.md) | Persist-Path Gate Ordering: Routing, Judge, Redaction, Faithfulness, Tombstone |
| [0189](0189-pi-observe-resilience.md) | Observe delivery is durable, idempotent, and budgeted so an unreachable daemon never breaks or delays a turn |
| [0190](0190-pi-plugin-daemon-client-lifecycle.md) | Pi plugin daemon access is probed once per startup, bounded by explicit budgets, and guarded against staleness |
| [0191](0191-prebuild-recursion-and-freshness.md) | Prebuild dependency scripts are guarded against recursion and seed a freshness fingerprint |
| [0192](0192-procedural-recall-defaults.md) | Procedural recall ships enabled by default with safer floors; the conservative preset stays opt-out |
| [0193](0193-project-scoped-write-overlay-authorization.md) | Project scoping comes from working context, never from caller-named overlay namespaces |
| [0194](0194-promoted-copy-reconciliation.md) | Promoted-Copy Probes, Reconciliation, and Windowed Promotion Writes |
| [0195](0195-provenance-source-and-timestamp-contracts.md) | Every persisted provenance source must be grounded, timestamp-valid, validated on both write and read paths, byte-stable, and never crash extraction - an unverifiable span or fabricated date is a tagged state, not a silent failure. |
| [0196](0196-provider-breaker-probe-ownership.md) | A half-open circuit-breaker probe is owned single-flight and settleable only by its owner |
| [0197](0197-provider-retry-and-local-lab-contracts.md) | Provider integrations keep billing, retry, timeout, and error surfaces explicit: salvage only what provably succeeded, budget each retry class separately, and never leak secrets or paths |
| [0198](0198-published-harness-contracts.md) | The published harness validates datasets at the parse boundary and keeps trial output shape stable |
| [0199](0199-qmd-daemon-execution-and-degradation.md) | QMD results are served by the daemon, never the subprocess, and degraded results are reported, redacted, and never cached |
| [0200](0200-qmd-daemon-operations.md) | QMD operations degrade gracefully under congestion, serialize safely, and cache only trustworthy results - a slow or saturated backend reduces recall quality (lex-only) but never hangs or returns cross-contaminated results. |
| [0201](0201-qmd-maintenance-served-semantics.md) | A QMD maintenance pass serves a completion request only when it fully covered the selection, and plain update() is fail-open |
| [0202](0202-queue-snapshot-and-maintenance.md) | Extraction Queue Coordination, Snapshot Sharing, and Ledger Maintenance |
| [0203](0203-raw-excerpt-read-gating.md) | Raw transcript excerpts are read-authorized, session-scoped, and capped |
| [0204](0204-rebuild-cross-process-locking.md) | Rebuilds and catalog mutations share one held cross-process mutex |
| [0205](0205-rebuild-scan-authority-and-purge.md) | The on-disk directory scan is authoritative for which namespaces exist, and catalog roots must match the runtime router |
| [0206](0206-recall-assembly-pipeline.md) | Recall assembly is fail-open, deadline-bounded, safety-filtered before scoring, and merges LCM evidence across every authorized key |
| [0207](0207-recall-concurrency-single-flight.md) | Identical concurrent recalls coalesce onto one shared pipeline with atomic cross-namespace budget admission |
| [0208](0208-recall-filter-gate-ordering.md) | Recall filters and caps run exclusion-before-cap, with temporal validity evaluated at the pinned instant |
| [0209](0209-recall-handles.md) | Recall handles are short hex tokens derived from memory ids, widened group-wise on collision, and only resolvable within a session |
| [0210](0210-recall-measurement-validity.md) | Recall measurements are computed against bounded, realistic, reproducible ground truth |
| [0211](0211-recall-output-formatting-contracts.md) | Recall output rendering is byte-identical by default and changes only behind explicit feature flags |
| [0212](0212-recall-pipeline-composition.md) | Recall composition runs four pipelines through one staged spine with byte-parity, MMR diversifies after rerank, and navigation/deep-recall are pure, seam-validated extensions |
| [0213](0213-recall-planner-llm-routing.md) | LLM recall planning routes through provider-qualified models, gates once on the resolved capability, and falls back silently-but-warned to the heuristic |
| [0214](0214-recall-qos-deadlines.md) | Every recall section runs under a real deadline that degrades to a neutral value and never hangs or fails the recall |
| [0215](0215-recall-response-assembly-integrity.md) | Recall responses carry only admitted content with honest depth, cost, and audit accounting |
| [0216](0216-recall-scanning-and-ledger-io.md) | Recall scans cover every category and cold tier, with bounded, crash-safe ledger I/O |
| [0217](0217-recall-why-xray-diagnosis.md) | Diagnosis surfaces (why/xray/explain) report outages as outages, validate inputs exactly, and render one shared, sanitized shape |
| [0218](0218-reconcile-planner-durable-state.md) | Peer reconciliation plans deterministically with retraction precedence and untrusted-input validation, and durable state writes are lock-guarded and crash-safe |
| [0219](0219-regression-gate-and-evidence-receipts.md) | The regression gate fails on structural violations before considering hardware skips, and evidence receipts are pinned and create-only |
| [0220](0220-repeated-failure-suite-resume-protocol.md) | A repeated-failure suite treats retry exhaustion as a durable pause with committed history, and synthetic drift corpora record their realized lifecycle |
| [0221](0221-replica-divergence-telemetry.md) | Replica divergence telemetry is validated at the trust boundary, certified only on complete censuses, and monitored with stale-while-rerefresh bounds |
| [0222](0222-repo-tooling-invariants.md) | Cross-cutting tooling and platform invariants: token snapshot coherence, envelope belt, opt-in gates, transcript windows, script gates, and test-support contracts |
| [0223](0223-retrieval-agent-scoring-and-merge.md) | Specialized retrieval agents must keep globally unique absolute paths and complementary scoring signals |
| [0224](0224-retry-breaker-no-drop.md) | Extraction Retry, Circuit Breaker, and the No-Drop Retention Contract |
| [0225](0225-salvage-envelope-error-isolation.md) | Salvage Envelope and Per-Fact Error Isolation |
| [0226](0226-scenario-benchmark-contracts.md) | Scenario benchmarks isolate every case, go through the adapter contract only, and score exactly what the scenario defines |
| [0227](0227-schema-default-materialization-raw-vs-effective.md) | Config resolvers distinguish operator-authored values from schema-default materialization |
| [0228](0228-search-namespace-confinement.md) | Search surfaces stay inside read-authorized namespaces: LCM reads follow the recall-authorized namespace set, unscoped LCM scans are suppressed, and fan-out search authorizes before it budgets |
| [0229](0229-secure-store-crypto-and-encrypted-scope.md) | Secure-store encryption binds authenticated metadata into the AEAD, derives keys with memory-hard KDFs, and migrates exactly the memory-bearing directory set |
| [0230](0230-security-suite-tamper-evident-analysis.md) | Security-suite analyses trust only the hashed, tamper-evident record of what actually ran, and every planned cell is accounted for |
| [0231](0231-semantic-dedup-scoping-and-write-gates.md) | Write-time dedup and skip gates are scoped to connector and namespace, run before chunking, and never suppress corrections |
| [0232](0232-semantic-merge-atomic-commit-pipeline.md) | Judge-mediated semantic merges commit through a snapshot-rollback, CAS-receipted pipeline with metadata parity |
| [0233](0233-semantic-query-retrieval.md) | Semantic query degrades through tagged, distinct failure codes and hydrates hits by node id |
| [0234](0234-semantic-vector-indexing.md) | Semantic indexing embeds one canonical body-bounded text and treats similarity as compute-first, replace-on-success |
| [0235](0235-session-delta-baseline.md) | Session delta state advances only on trustworthy git results, and only for write-capable principals |
| [0236](0236-shared-backend-accounting-and-degradation.md) | Shared backends are counted before decisions, fail with explicit backend_unavailable signals, and short-circuit per batch |
| [0237](0237-shared-context-authority-governance.md) | Shared-context items carry a server-derived authority envelope; binding requires exact, validated opt-in and stale or disputed items are marked, never deleted or averaged |
| [0238](0238-snapshot-stable-identity-atomic-write.md) | Extracted config keys are snapshotted with line-independent identities and written atomically |
| [0239](0239-source-ingest-failure-semantics.md) | Source ingestion fails loud at schema boundaries and records every degradation explicitly |
| [0240](0240-startup-bringup-and-deferred-init.md) | Startup finalizes QMD state before the init gate opens, shares one backend bring-up per epoch, and keeps heavy work deferred |
| [0241](0241-state-view-admission.md) | State-view recall surfaces superseded records only as complete, namespace-qualified evidence packets judged against the original prompt |
| [0242](0242-storage-dir-containment-and-symlink-safety.md) | No cataloged namespace name or storage root may escape memoryDir — containment is enforced on write, on read, and in the scan |
| [0243](0243-store-boundary-contract-validation.md) | Validate file and query contracts at the coding-graph store boundary, rejecting violations instead of normalizing them |
| [0244](0244-strict-config-input-rejection.md) | Present-but-invalid configuration values are rejected loudly instead of silently defaulting |
| [0245](0245-summarizer-reporting-and-snapshot-locks.md) | Summarizer reports staleness honestly and snapshot upserts share one lock implementation |
| [0246](0246-supersession-hash-dedup.md) | Hash dedup guards duplicate shared-memory promotion |
| [0247](0247-supersession-temporal-ordering.md) | Supersession ordering is driven by persisted validity timestamps with a monotonic clamp |
| [0248](0248-surprise-probe-additive-telemetry.md) | The surprise probe is additive-only, soft-failing, and fully observed: it can promote flushing, never suppress or stall it |
| [0249](0249-temporal-indexing-and-supersession.md) | Temporal indexes commit as atomic pairs and supersession preserves monotonic time |
| [0250](0250-temporal-supersession-and-backfill.md) | Temporal Supersession and Bi-Temporal Bounds Backfill |
| [0251](0251-temporal-validity-intervals.md) | Effective validity intervals terminate for legacy data and degrade conservatively on corrupt timestamps |
| [0252](0252-tombstone-blocked-write-reporting.md) | Tombstone-blocked writes are reported as queued/rejected, never as successful active writes |
| [0253](0253-tombstone-nonresurrection.md) | Retired facts are protected by namespace-scoped, keyed tombstones that must never resurrect |
| [0254](0254-touch-coalescing-and-log-compaction.md) | Repeat timestamp touches are coalesced per window and the log is auto-compacted with hysteresis |
| [0255](0255-touch-serialization-and-provenance.md) | Touches merge field-by-field under serialization; provenance is creation-only with a single config-to-write upgrade |
| [0256](0256-trust-boundary-and-scan-safety.md) | Trust boundaries validate or refuse before I/O; long scans yield and cache invalidates; smallest themes merged here per the ten-file limit |
| [0257](0257-trust-boundary-errors-and-schemas.md) | Anything crossing a trust boundary is sanitized or strictly parsed: raw errors stay internal, user-facing error detail carries only stable identifiers, and gateway payloads get tolerant aliases |
| [0258](0258-trust-score-stage.md) | One unified TrustScore stage replaces separate filters, with parity-derived signals, cached per namespace, and quarantine that never alters scores |
| [0259](0259-tui-refresh-loop-lifecycle.md) | The TUI refresh loop is unkillable by design: latches release in finally, trace writes are fire-and-forget with backpressure, and stop awaits the in-flight tick |
| [0260](0260-turn-ingestion-shared-execution-and-pinned-namespaces.md) | Accepted captures run under a shared execution boundary with pinned namespaces resolved once and revalidated at execution |
| [0261](0261-vault-publisher-write-safety.md) | Vault publisher writes are refusal-first: any ambiguity in note structure, markers, or paths refuses instead of guessing |
| [0262](0262-vault-publishing-and-timeline-generation.md) | Vault writes touch only managed regions outside code blocks; timeline and analysis surfaces validate before side effects |
| [0263](0263-verification-gates-and-test-isolation.md) | Install-time gates and tests replicate the runtime's exact resolution rules so a green result never lies |
| [0264](0264-weclone-install-compose.md) | WeClone install composes config from defaults then user overrides, and install/run/remove share one path-resolution rule |
| [0265](0265-weclone-proxy-and-training-export.md) | The WeClone proxy routes by normalized pathname and forwards payload bytes faithfully; training export stays deterministic and privacy-first |
| [0266](0266-workspace-services-day-summary.md) | Shared workspace services are lazily constructed singletons, and day summaries read UTC facts into local-day targets with containment checks |
| [0267](0267-write-durability-and-quota-accounting.md) | Observe captures are durable before they are accepted and never silently evicted, and write quota is accounted exactly once per real mutation inside the idempotency lock |
| [0268](0268-xray-capture-and-observability.md) | X-ray capture is a best-effort, opt-in side channel whose snapshot must explain every admitted and excluded result |
| [0269](0269-zero-disable-check-fail-closed.md) | Zero-disable config checks are interpreted with schema combinator semantics and fail closed |
