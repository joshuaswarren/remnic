/**
 * @remnic/core
 *
 * Framework-agnostic Remnic memory engine.
 *
 * Exports the orchestrator, config parsing, storage, search,
 * extraction, graph, trust zones, and access layer.
 *
 * This package has ZERO OpenClaw imports — it can be consumed by
 * any host adapter (CLI, HTTP server, MCP server, etc.).
 *
 * Usage:
 *   import { Orchestrator, parseConfig } from "@remnic/core";
 *   const config = parseConfig({ memoryDir: "/tmp/mem" });
 *   const orch = new Orchestrator(config);
 *   await orch.initialize();
 */

// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

export { PLUGIN_ID, LEGACY_PLUGIN_ID, resolveRemnicPluginEntry } from "./plugin-id.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export { parseConfig } from "./config.js";
export {
  parseFlexibleIsoTimestamp,
  parseIsoOffsetTimestamp,
  parseIsoUtcTimestamp,
} from "./utils/iso-timestamp.js";
export {
  migrateFromEngram,
  rollbackFromEngramMigration,
  type MigrationResult,
  type MigrationOptions,
  type RollbackResult,
} from "./migrate/from-engram.js";

// ---------------------------------------------------------------------------
// Orchestrator — primary entry point
// ---------------------------------------------------------------------------

export {
  Orchestrator,
  sanitizeSessionKeyForFilename,
  defaultWorkspaceDir,
} from "./orchestrator.js";
export * from "./memory-projection-format.js";
export * from "./model-registry.js";
export * from "./contradiction/index.js";

export {
  buildEvidencePack,
  type EvidencePackItem,
  type EvidencePackOptions,
} from "./evidence-pack.js";
export {
  buildExplicitCueRecallSection,
  buildTrajectoryAnalysisRecallSection,
  collectExplicitTurnReferences,
  collectBenchmarkAnchorCues,
  collectContentLexicalCues,
  collectLexicalCues,
  collectQuestionSlotCues,
  collectStructuredPlanCues,
  collectTemporalLexicalCues,
  normalizeTurnExpansionEnd,
  type ExplicitCueRecallEngine,
  type ExplicitCueRecallOptions,
  type ExplicitTurnReference,
  type TrajectoryAnalysisRecallOptions,
} from "./explicit-cue-recall.js";
export {
  buildTargetedFactRecallSection,
  shouldRecallTargetedFactEvidence,
  type TargetedFactRecallOptions,
} from "./targeted-fact-recall.js";
export {
  buildFocusedListRecallSection,
  shouldRecallFocusedListEvidence,
  type FocusedListRecallOptions,
} from "./focused-list-recall.js";
export {
  buildResponseGuidanceRecallSection,
  shouldRecallResponseGuidance,
  type ResponseGuidanceRecallOptions,
} from "./response-guidance-recall.js";
export {
  buildEventOrderRecallSection,
  shouldRecallEventOrderEvidence,
  type EventOrderRecallOptions,
} from "./event-order-recall.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export {
  StorageManager,
  parseEntityFile,
  serializeEntityFile,
} from "./storage.js";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export { ExtractionEngine } from "./extraction.js";
export {
  setCodexCliFallbackRunnerForProcess,
  type CodexCliFallbackConfig,
  type CodexCliFallbackMessage,
  type CodexCliFallbackOptions,
  type CodexCliFallbackRequest,
  type CodexCliFallbackResult,
  type CodexCliFallbackRunner,
} from "./codex-cli-fallback.js";

// ---------------------------------------------------------------------------
// Smart buffer (issue #563)
// ---------------------------------------------------------------------------

export {
  SmartBuffer,
  type TriggerDecision,
  type BufferSurpriseProbe,
} from "./buffer.js";

export {
  computeSurprise,
  DEFAULT_SURPRISE_K,
  type RecentMemoryLike,
  type ComputeSurpriseOptions,
} from "./buffer-surprise.js";

export {
  reportBufferSurpriseDistribution,
  type BufferSurpriseDistribution,
  type BufferSurpriseReader,
  type BufferSurpriseReportOptions,
} from "./buffer-surprise-report.js";

export type { BufferSurpriseEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Extraction Judge (issue #376)
// ---------------------------------------------------------------------------

export {
  judgeFactDurability,
  clearVerdictCache,
  verdictCacheSize,
  createVerdictCache,
  getVerdictKind,
  isDurableVerdict,
  isValidCachedVerdict,
  normalizeCachedVerdict,
  type JudgeCandidate,
  type JudgeVerdict,
  type JudgeVerdictKind,
  type JudgeBatchResult,
} from "./extraction-judge.js";

// ---------------------------------------------------------------------------
// Intent + procedural recall (issue #519)
// ---------------------------------------------------------------------------

export {
  inferIntentFromText,
  isTaskInitiationIntent,
  intentCompatibilityScore,
  planRecallMode,
  hasBroadGraphIntent,
} from "./intent.js";

export { buildProcedureRecallSection } from "./procedural/procedure-recall.js";
export {
  buildProcedureMarkdownBody,
  parseProcedureStepsFromBody,
} from "./procedural/procedure-types.js";

// Procedural stats surface (issue #567 PR 5/5).
export {
  computeProcedureStats,
  formatProcedureStatsText,
} from "./procedural/procedure-stats.js";
export type {
  ProcedureStatsReport,
  ProcedureStatusCounts,
  ProcedureStatsConfigSnapshot,
  ProcedureStatsRecent,
} from "./procedural/procedure-stats.js";

// ---------------------------------------------------------------------------
// Direct-answer retrieval tier (issue #518)
// ---------------------------------------------------------------------------

export {
  isDirectAnswerEligible,
  FILTER_LABELS as DIRECT_ANSWER_FILTER_LABELS,
  type DirectAnswerCandidate,
  type DirectAnswerConfig,
  type DirectAnswerInput,
  type DirectAnswerReason,
  type DirectAnswerResult,
} from "./direct-answer.js";

// ---------------------------------------------------------------------------
// Hot/cold tier routing (issue #686)
// ---------------------------------------------------------------------------

export {
  computeTierValueScore,
  decideTierTransition,
  type MemoryTier,
  type TierRoutingPolicy,
  type TierTransitionDecision,
} from "./tier-routing.js";

// ---------------------------------------------------------------------------
// Reasoning-trace retrieval boost (issue #564)
// ---------------------------------------------------------------------------

export {
  applyReasoningTraceBoost,
  isReasoningTracePath,
  looksLikeProblemSolvingQuery,
  DEFAULT_REASONING_TRACE_BOOST,
  type ApplyReasoningTraceBoostOptions,
  type BoostableResult,
} from "./reasoning-trace-recall.js";

export {
  parseMessageParts,
  parseOpenAiMessageParts,
  parseAnthropicMessageParts,
  parseOpenClawMessageParts,
  parsePiMessageParts,
  normalizeExplicitParts,
  partsFromRenderedText,
  isLcmMessagePartKind,
  type LcmMessagePartInput,
  type LcmMessagePartKind,
  type LcmMessagePartRow,
  type MessagePartSourceFormat,
  type ParseMessagePartsOptions,
} from "./message-parts/index.js";

// ---------------------------------------------------------------------------
// User-aware memory provenance
// ---------------------------------------------------------------------------

export {
  USER_MODEL_CORE_QUESTION,
  USER_MODEL_DIMENSIONS,
  USER_CONTEXT_SCOPES,
  USER_BOUNDARY_SCOPES,
  isUserModelDimension,
  normalizeUserModelDimension,
  isUserContextScope,
  normalizeUserContextScope,
  isUserBoundaryScope,
  facetHasBoundary,
  summarizeUserModelCoverage,
  type UserModelDimension,
  type UserContextScope,
  type UserBoundaryScope,
  type UserModelFacet,
  type UserModelCoverage,
} from "./user-model.js";

export {
  buildRetrievedMemoryProvenance,
  normalizeRetrievedMemoryProvenance,
  summarizeRetrievedMemoryProvenance,
  type RetrievedMemoryProvenance,
  type BuildRetrievedMemoryProvenanceOptions,
  type RetrievedMemoryCorrectionState,
  type RetrievedMemorySafety,
} from "./memory-provenance.js";

// ---------------------------------------------------------------------------
// Inline source attribution (issue #369)
// ---------------------------------------------------------------------------

export {
  DEFAULT_CITATION_FORMAT,
  CITATION_UNKNOWN,
  attachCitation,
  deriveSessionId,
  formatCitation,
  hasCitation,
  parseAllCitations,
  parseCitation,
  stripCitation,
  type CitationContext,
  type ParsedCitation,
} from "./source-attribution.js";

// ---------------------------------------------------------------------------
// Search backends
// ---------------------------------------------------------------------------

export { QmdClient } from "./qmd.js";
export { LanceDbBackend } from "./search/lancedb-backend.js";
export { OramaBackend } from "./search/orama-backend.js";
export { MeilisearchBackend } from "./search/meilisearch-backend.js";

// ---------------------------------------------------------------------------
// Entity / Graph
// ---------------------------------------------------------------------------

export { buildEntityRecallSection } from "./entity-retrieval.js";
export { resolvePrincipal } from "./namespaces/principal.js";

// ---------------------------------------------------------------------------
// Trust zones
// ---------------------------------------------------------------------------

export {
  isTrustZoneName,
  type TrustZoneName,
  type TrustZoneRecord,
  type TrustZoneRecordKind,
  type TrustZoneSourceClass,
} from "./trust-zones.js";

// ---------------------------------------------------------------------------
// Access layer (HTTP + MCP + schema validation)
// ---------------------------------------------------------------------------

export { EngramAccessService, EngramAccessInputError } from "./access-service.js";
export { EngramAccessHttpServer } from "./access-http.js";
export { EngramMcpServer } from "./access-mcp.js";

// agentAccessHttp.authToken SecretRef resolution (issue #757). Exposed so
// host-specific bootstrap code (the OpenClaw plugin in `src/index.ts`, the
// standalone server, the CLI) can resolve a SecretRef to a literal bearer
// token before constructing the HTTP server.
export {
  resolveAgentAccessAuthToken,
  isAgentAccessSecretRef,
  clearAuthTokenSecretCache,
} from "./resolve-auth-token.js";
export type { ResolveSecretRefFn } from "./resolve-auth-token.js";
export type { SecretRef, AgentAccessAuthToken } from "./types.js";

// Recall X-ray CLI helpers (issue #570).  Exported so the standalone
// `@remnic/cli` binary can wire the `remnic xray` command without
// reimporting core-internal modules by relative path (CLAUDE.md rule 26).
export {
  parseXrayCliOptions,
  parseXrayBudgetFlag,
  type ParsedXrayCliOptions,
} from "./recall-xray-cli.js";
export {
  renderXray,
  renderXrayJson,
  renderXrayText,
  renderXrayMarkdown,
  parseXrayFormat,
  RECALL_XRAY_FORMATS,
  type RecallXrayFormat,
} from "./recall-xray-renderer.js";
export type {
  RecallXraySnapshot,
  RecallXrayResult,
  RecallXrayScoreDecomposition,
  RecallXrayServedBy,
  RecallFilterTrace,
} from "./recall-xray.js";

// ChatGPT Apps-compatible memory inspector demo.
export {
  REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_CANONICAL_TOOL,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_HTML,
  buildChatGptMemoryInspectorActionRequest,
  buildChatGptMemoryInspectorResult,
  type RemnicChatGptMemoryInspectorInput,
  type RemnicChatGptMemoryCard,
  type RemnicChatGptMemoryInspectorResult,
} from "./mcp-memory-inspector-app.js";

// Coding-agent subsystem (issue #569)
export {
  resolveGitContext,
  normalizeOriginUrl,
  stableHash,
  expandTildePath,
  type GitContext,
  type GitInvoker,
} from "./coding/git-context.js";
export {
  resolveCodingNamespaceOverlay,
  projectNamespaceName,
  branchNamespaceName,
  describeCodingScope,
  type CodingNamespaceOverlay,
  type CodingScopeDescription,
} from "./coding/coding-namespace.js";
export {
  isReviewPrompt,
  parseTouchedFiles,
  rankReviewCandidates,
  packReviewContext,
  type ReviewContext,
  type ReviewCandidate,
} from "./coding/review-context.js";

export {
  validateRequest,
  formatZodError,
  recallRequestSchema,
  observeRequestSchema,
  memoryStoreRequestSchema,
  suggestionSubmitRequestSchema,
  type SchemaValidationError,
  type SchemaName,
  type RecallRequest,
  type ObserveRequest,
  type MemoryStoreRequest,
  type SuggestionSubmitRequest,
} from "./access-schema.js";

// ---------------------------------------------------------------------------
// Day summary / LCM
// ---------------------------------------------------------------------------

export { loadDaySummaryPrompt, buildExtensionsFooterForSummary } from "./day-summary.js";

// LCM (Lossless Context Management) database helpers — exposed so optional
// host packages (e.g. @remnic/import-lossless-claw) can open the same
// SQLite store the runtime uses without re-implementing schema bootstrap.
// `applyLcmSchema` lets importers bootstrap an in-memory destination for
// true read-only `--dry-run` execution.
export {
  openLcmDatabase,
  ensureLcmStateDir,
  applyLcmSchema,
} from "./lcm/schema.js";

// ---------------------------------------------------------------------------
// Active memory bridge
// ---------------------------------------------------------------------------

export {
  getMemoryForActiveMemory,
  recallForActiveMemory,
  type ActiveMemoryGetOutput,
  type ActiveMemoryMetadata,
  type ActiveMemoryRecallParams,
  type ActiveMemorySearchOutput,
  type ActiveMemorySearchResult,
} from "./active-memory-bridge.js";

// ---------------------------------------------------------------------------
// Action confidence
// ---------------------------------------------------------------------------

export {
  ACTION_CONFIDENCE_CONTEXT_READINESS,
  ACTION_CONFIDENCE_DECISIONS,
  ACTION_CONFIDENCE_RISK_CATEGORIES,
  ACTION_CONFIDENCE_RULE_KINDS,
  buildActionConfidenceInputFromOptions,
  evaluateActionConfidence,
  renderActionConfidenceText,
  type ActionConfidenceContextReadiness,
  type ActionConfidenceDecision,
  type ActionConfidenceFactor,
  type ActionConfidenceInput,
  type ActionConfidenceMemoryInput,
  type ActionConfidenceOptionInput,
  type ActionConfidenceResult,
  type ActionConfidenceRiskCategory,
  type ActionConfidenceRule,
  type ActionConfidenceRuleKind,
} from "./action-confidence.js";

// ---------------------------------------------------------------------------
// Daily Context Briefing (#370)
// ---------------------------------------------------------------------------

export {
  buildBriefing,
  parseBriefingWindow,
  parseBriefingFocus,
  validateBriefingFormat,
  focusMatchesMemory,
  focusMatchesEntity,
  renderBriefingMarkdown,
  resolveBriefingSaveDir,
  briefingFilename,
  FileCalendarSource,
  BRIEFING_FORMAT_ALLOWED,
  type BuildBriefingOptions,
  type BriefingFollowupGenerator,
  type ParsedBriefingWindow,
  type BriefingFormatValue,
} from "./briefing.js";

// ---------------------------------------------------------------------------
// Binary lifecycle management (#367)
// ---------------------------------------------------------------------------

export {
  type BinaryLifecycleConfig,
  type BinaryStorageBackendConfig,
  type BinaryAssetRecord,
  type BinaryAssetStatus,
  type BinaryLifecycleManifest,
  type PipelineResult,
  type BinaryStorageBackend,
  DEFAULT_SCAN_PATTERNS,
  DEFAULT_MAX_BINARY_SIZE_BYTES,
  DEFAULT_GRACE_PERIOD_DAYS,
  FilesystemBackend,
  NoneBackend,
  createBackend,
  scanForBinaries,
  matchesPatterns,
  readManifest,
  writeManifest,
  manifestPath,
  manifestDir,
  emptyManifest,
  runBinaryLifecyclePipeline,
} from "./binary-lifecycle/index.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export { BootstrapEngine } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// Codex compatibility helpers
// ---------------------------------------------------------------------------

export { CODEX_THREAD_KEY_PREFIX } from "./codex-thread-key.js";
export type { CodexCompatConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Page-level versioning (issue #371)
// ---------------------------------------------------------------------------

export {
  createVersion,
  listVersions,
  getVersion,
  revertToVersion,
  diffVersions,
  type PageVersion,
  type VersionTrigger,
  type VersionHistory,
  type VersioningConfig,
  type VersioningLogger,
} from "./page-versioning.js";

// ---------------------------------------------------------------------------
// OAI-mem-citation blocks (issue #379)
// ---------------------------------------------------------------------------

export {
  parseOaiMemCitation,
  formatOaiMemCitation,
  buildCitationGuidance,
  sanitizeNoteForCitation,
  type CitationEntry,
  type CitationBlock,
  type CitationMetadata,
} from "./citations.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export { initLogger, log } from "./logger.js";

// ---------------------------------------------------------------------------
// Projection (workspace tree)
// ---------------------------------------------------------------------------

export {
  generateContextTree,
  type TreeNode,
  type ProvenanceEntry,
  type GenerateOptions,
  type GenerateResult,
} from "./projection/index.js";

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export {
  onboard,
  type OnboardOptions,
  type OnboardResult,
  type LanguageInfo,
  type DocFile,
  type ProjectShape,
  type IngestionPlan,
} from "./onboarding/index.js";

// ---------------------------------------------------------------------------
// Curation
// ---------------------------------------------------------------------------

export {
  curate,
  type CurateOptions,
  type CuratedStatement,
  type StatementProvenance,
  type CurateResult,
  type DuplicateResult as CurateDuplicateResult,
  type ContradictionResult as CurateContradictionResult,
} from "./curation/index.js";

// ---------------------------------------------------------------------------
// Dedup & Contradiction Detection
// ---------------------------------------------------------------------------

export {
  findDuplicates,
  findContradictions,
  type MemoryEntry,
  type DedupOptions,
  type DedupResult,
  type DuplicatePair,
  type ContradictionOptions,
  type ContradictionPair,
} from "./dedup/index.js";

export {
  decideSemanticDedup,
  type SemanticDedupHit,
  type SemanticDedupLookup,
  type SemanticDedupOptions,
  type SemanticDedupDecision,
} from "./dedup/semantic.js";

// ---------------------------------------------------------------------------
// Review Inbox
// ---------------------------------------------------------------------------

export {
  listReviewItems,
  performReview,
  type ReviewItem,
  type ReviewAction,
  type ReviewResult,
  type ReviewListResult,
  type ReviewOptions,
} from "./review/index.js";

// ---------------------------------------------------------------------------
// Diff-Aware Sync
// ---------------------------------------------------------------------------

export {
  syncChanges,
  watchForChanges,
  type SyncOptions,
  type SyncResult,
  type FileChange,
  type SyncState,
} from "./sync/index.js";

// ---------------------------------------------------------------------------
// Memory Extension Host (#382)
// ---------------------------------------------------------------------------

export {
  discoverMemoryExtensions,
  renderExtensionsBlock,
  renderExtensionsFooter,
  resolveExtensionsRoot,
  REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT,
  type DiscoveredExtension,
  type ExtensionSchema,
} from "./memory-extension-host/index.js";

export {
  buildExtensionsBlockForConsolidation,
} from "./semantic-consolidation.js";

// ---------------------------------------------------------------------------
// Connector Manager
// ---------------------------------------------------------------------------

export {
  listConnectors,
  installConnector,
  removeConnector,
  doctorConnector,
  getConnectorToken,
  loadRegistry,
  saveRegistry,
  generateMarketplaceManifest,
  validateMarketplaceManifest,
  checkMarketplaceManifest,
  writeMarketplaceManifest,
  installFromMarketplace,
  MARKETPLACE_SCHEMA_VERSION,
  MARKETPLACE_MANIFEST_FILENAME,
  type ConnectorManifest,
  type ConnectorCapability,
  type ConnectorInstance,
  type ConnectorRegistry,
  type InstallOptions,
  type InstallResult,
  type RemoveResult,
  type DoctorResult,
  type DoctorCheck,
  type MarketplaceManifest,
  type MarketplaceEntry,
  type MarketplaceConfig,
  type MarketplaceInstallType,
  type MarketplaceInstallResult,
  type MarketplaceValidation,
  type MarketplaceLogger,
} from "./connectors/index.js";

export { coerceInstallExtension } from "./connectors/coerce.js";

// ---------------------------------------------------------------------------
// Live Connectors framework (#683 PR 1/N)
// ---------------------------------------------------------------------------
//
// Pure framework — interface, registry, and cursor state store. Concrete
// connectors (Drive, Notion, Gmail, GitHub) ship in PRs 2–5; the maintenance
// scheduler hookup and CLI surface land in later PRs.
//
// NOTE: lives under `connectors/live/` to avoid colliding with the existing
// Codex marketplace integration above. Do not flatten.

export {
  CONNECTOR_ID_PATTERN,
  isValidConnectorId,
  LiveConnectorRegistry,
  LiveConnectorRegistryError,
  listConnectorStates,
  readConnectorState,
  writeConnectorState,
  GOOGLE_DRIVE_CONNECTOR_ID,
  GOOGLE_DRIVE_CURSOR_KIND,
  GOOGLE_DRIVE_DEFAULT_POLL_INTERVAL_MS,
  createGoogleDriveConnector,
  defaultGoogleDriveClientFactory,
  validateGoogleDriveConfig,
  NOTION_CONNECTOR_ID,
  NOTION_CURSOR_KIND,
  NOTION_DEFAULT_POLL_INTERVAL_MS,
  createNotionConnector,
  validateNotionConfig,
  type ConnectorConfig,
  type ConnectorCursor,
  type ConnectorDocument,
  type ConnectorDocumentSource,
  type ConnectorState,
  type ConnectorSyncStatus,
  type LiveConnector,
  type SyncIncrementalArgs,
  type SyncIncrementalResult,
  type DriveChange,
  type DriveChangesPage,
  type DriveFileMetadata,
  type GoogleDriveClient,
  type GoogleDriveClientFactory,
  type GoogleDriveConnectorConfig,
  type GoogleDriveSyncResult,
  type NotionConnectorConfig,
} from "./connectors/live/index.js";

// ---------------------------------------------------------------------------
// Live-connector CLI helpers (issue #683 PR 6/6)
// ---------------------------------------------------------------------------

export {
  builtInLiveConnectorDefinitions,
  hasEnabledLiveConnector,
  runLiveConnectorsOnce,
  type LiveConnectorDefinition,
  type LiveConnectorRunItem,
  type LiveConnectorSkipReason,
  type LiveConnectorsRunSummary,
} from "./live-connectors-runner.js";

export {
  CONNECTORS_OUTPUT_FORMATS,
  parseConnectorsFormat,
  parseConnectorsListOptions,
  parseConnectorsStatusOptions,
  parseConnectorsRunName,
  renderConnectorsList,
  renderConnectorsRunResult,
  runConnectorPollOnce,
  type ConnectorRow,
  type ConnectorRunResult,
  type ConnectorsOutputFormat,
  type ParsedConnectorsListOptions,
  type ParsedConnectorsStatusOptions,
  type RunConnectorPollOnceArgs,
} from "./connectors-cli.js";

// ---------------------------------------------------------------------------
// Spaces + Collaboration
// ---------------------------------------------------------------------------

export {
  listSpaces,
  getActiveSpace,
  createSpace,
  deleteSpace,
  switchSpace,
  pushToSpace,
  pullFromSpace,
  shareSpace,
  promoteSpace,
  mergeSpaces,
  loadManifest,
  saveManifest,
  getAuditLog,
  getSpacesDir,
  getManifestPath,
  type Space,
  type SpaceKind,
  type SpaceManifest,
  type SpaceSwitchResult,
  type SpacePushResult,
  type SpacePullResult,
  type SpaceShareResult,
  type SpacePromoteResult,
  type ConflictEntry,
  type MergeResult,
  type AuditEntry,
} from "./spaces/index.js";

// ---------------------------------------------------------------------------
// Token Management
// ---------------------------------------------------------------------------

export {
  generateToken,
  listTokens,
  revokeToken,
  getAllValidTokens,
  getAllValidTokensCached,
  resolveConnectorFromToken,
  loadTokenStore,
  saveTokenStore,
  type TokenEntry,
  type TokenStore,
} from "./tokens.js";

// ---------------------------------------------------------------------------
// Codex materializer (#378)
// ---------------------------------------------------------------------------

export {
  runCodexMaterialize,
  runPostConsolidationMaterialize,
  type RunMaterializeOptions,
  type PostConsolidationMaterializeOptions,
} from "./connectors/codex-materialize-runner.js";
export {
  materializeForNamespace,
  ensureSentinel,
  describeMemoriesDir,
  SENTINEL_FILE,
  MATERIALIZE_VERSION,
  type MaterializeOptions,
  type MaterializeResult,
  type RolloutSummaryInput,
} from "./connectors/codex-materialize.js";

// ---------------------------------------------------------------------------
// Memory Extension Publishers (#381)
// ---------------------------------------------------------------------------

export {
  publisherFor,
  publisherForConnector,
  hostIdForConnector,
  registerPublisher,
  PUBLISHERS,
  CodexMemoryExtensionPublisher,
  ClaudeCodeMemoryExtensionPublisher,
  HermesMemoryExtensionPublisher,
  REMNIC_SEMANTIC_OVERVIEW,
  REMNIC_CITATION_FORMAT,
  REMNIC_MCP_TOOL_INVENTORY,
  REMNIC_RECALL_DECISION_RULES,
  type MemoryExtensionPublisher,
  type PublishContext,
  type PublishResult,
  type PublisherCapabilities,
} from "./memory-extension/index.js";

// ---------------------------------------------------------------------------
// MECE Taxonomy (#366)
// ---------------------------------------------------------------------------

export {
  DEFAULT_TAXONOMY,
  resolveCategory,
  generateResolverDocument,
  loadTaxonomy,
  saveTaxonomy,
  validateSlug,
  validateTaxonomy,
  getTaxonomyDir,
  getTaxonomyFilePath,
  type Taxonomy,
  type TaxonomyCategory,
  type ResolverDecision,
} from "./taxonomy/index.js";

// ---------------------------------------------------------------------------
// Enrichment pipeline (issue #365)
// ---------------------------------------------------------------------------

export {
  EnrichmentProviderRegistry,
  WebSearchProvider,
  runEnrichmentPipeline,
  appendAuditEntry,
  readAuditLog,
  defaultEnrichmentPipelineConfig,
  type EnrichmentCandidate,
  type EnrichmentCostTier,
  type EnrichmentPipelineConfig,
  type EnrichmentProvider,
  type EnrichmentProviderConfig,
  type EnrichmentResult,
  type EntityEnrichmentInput,
  type EnrichmentAuditEntry,
  type WebSearchFn,
  type WebSearchProviderOptions,
} from "./enrichment/index.js";

// Bulk-import pipeline (#460)
// ---------------------------------------------------------------------------

export {
  type BulkImportSource,
  type ImportTurn,
  type BulkImportOptions,
  type ImportSourceRole,
  type BulkImportResult,
  type BulkImportError,
  type BulkImportSourceAdapter,
  type ImportTurnValidationIssue,
  isImportRole,
  parseIsoTimestamp,
  validateImportTurn,
  registerBulkImportSource,
  getBulkImportSource,
  listBulkImportSources,
  clearBulkImportSources,
  runBulkImportPipeline,
  formatBatchTranscript,
  type ProcessBatchFn,
  type ProcessBatchResult,
} from "./bulk-import/index.js";

export {
  runBulkImportCliCommand,
  type BulkImportCliCommandOptions,
} from "./cli.js";

// ---------------------------------------------------------------------------
// Shared importer base (issue #568)
// ---------------------------------------------------------------------------

export {
  DEFAULT_IMPORT_BATCH_SIZE,
  validateImportBatchSize,
  validateImportRateLimit,
  importedMemoryToTurn,
  defaultWriteMemoriesToOrchestrator,
  runImporter,
  type ImportedMemory,
  type ImporterAdapter,
  type ImporterParseOptions,
  type ImporterTransformOptions,
  type ImporterWriteResult,
  type ImporterWriteTarget,
  type ImportProgress,
  type RunImporterResult,
  type RunImportOptions,
} from "./importers/index.js";

export {
  FallbackLlmClient,
  type FallbackLlmOptions,
  type FallbackLlmResponse,
  type FallbackLlmRuntimeContext,
} from "./fallback-llm.js";

// ---------------------------------------------------------------------------
// Training-data export (issue #459)
// ---------------------------------------------------------------------------

export * from "./training-export/index.js";

// ---------------------------------------------------------------------------
// Memory Worth scoring helper (issue #560 PR 2 of 5)
// ---------------------------------------------------------------------------

export {
  computeMemoryWorth,
  type ComputeMemoryWorthInput,
  type MemoryWorthResult,
} from "./memory-worth.js";

// ---------------------------------------------------------------------------
// Memory Worth outcome pipeline (issue #560 PR 3 of 5)
// ---------------------------------------------------------------------------

export {
  recordMemoryOutcome,
  memoryWorthOutcomeEligibleCategories,
  type MemoryOutcomeKind,
  type RecordMemoryOutcomeInput,
  type RecordMemoryOutcomeResult,
} from "./memory-worth-outcomes.js";

// ---------------------------------------------------------------------------
// Memory Worth recall filter (issue #560 PR 4 of 5)
// ---------------------------------------------------------------------------

export {
  applyMemoryWorthFilter,
  buildMemoryWorthCounterMap,
  type MemoryWorthCounters,
  type MemoryWorthFilterCandidate,
  type MemoryWorthFilterOptions,
  type MemoryWorthFilterResultItem,
} from "./memory-worth-filter.js";

// Memory Worth recall-precision benchmark (issue #560 PR 5 of 5) is NOT
// re-exported from the public API surface. The bench is for in-package
// test/script use only — see packages/remnic-core/src/memory-worth-bench.ts
// and its companion test. Benchmarks the broader package ecosystem relies
// on live in packages/bench/.

// ---------------------------------------------------------------------------
// Graph retrieval types (issue #559, PR 1 of 5)
// ---------------------------------------------------------------------------

export {
  queryGraph,
  isNodeType,
  isEdgeType,
  extractGraphEdges,
  buildGraphFromMemories,
  DEFAULT_PPR_DAMPING,
  DEFAULT_PPR_ITERATIONS,
  DEFAULT_PPR_TOLERANCE,
  type NodeType,
  type EdgeType,
  type RemnicGraphNode,
  type RemnicGraphEdge,
  type RemnicGraph,
  type QueryGraphOptions,
  type QueryGraphResult,
  type RankedGraphNode,
  type MemoryEdgeSource,
  type ExtractGraphEdgesOptions,
} from "./graph-retrieval.js";

export {
  runGraphRecall,
  type GraphRecallConfig,
  type GraphRecallOptions,
  type GraphRecallResult,
  type GraphRecallRun,
} from "./graph-recall.js";

// ---------------------------------------------------------------------------
// Cross-namespace query-budget limiter (issue #565 PR 4/5)
// ---------------------------------------------------------------------------

export {
  CrossNamespaceBudget,
  DEFAULT_CROSS_NAMESPACE_BUDGET,
} from "./cross-namespace-budget.js";
export type {
  BudgetDecision,
  BudgetDecisionReason,
  CrossNamespaceBudgetConfig,
} from "./cross-namespace-budget.js";


// ---------------------------------------------------------------------------
// Recall-audit anomaly detector (issue #565 PR 5/5)
// ---------------------------------------------------------------------------

export {
  DEFAULT_ANOMALY_DETECTOR_CONFIG,
  detectRecallAnomalies,
  normalizeQueryText,
} from "./recall-audit-anomaly.js";
export type {
  AnomalyDetectorConfig,
  AnomalyDetectorInput,
  AnomalyDetectorResult,
  AnomalyFlag,
  AnomalyKind,
  AnomalySeverity,
} from "./recall-audit-anomaly.js";

export { AccessAuditAdapter } from "./access-audit.js";
export type {
  AccessAuditConfig,
  AccessAuditResult,
} from "./access-audit.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type {
  PluginConfig,
  GatewayConfig,
  EntityFile,
  EntityStructuredSection,
  ConsolidationObservation,
  MemoryFile,
  MemoryFrontmatter,
  MemoryObservation,
  ExtractedFact,
  MemoryCategory,
  MemoryScope,
  MemoryActionType,
  MemoryActionEligibilityContext,
  MemoryActionEligibilitySource,
  ContinuityImprovementLoop,
  BriefingConfig,
  BriefingWindow,
  BriefingFocus,
  BriefingActiveThread,
  BriefingRecentEntity,
  BriefingOpenCommitment,
  BriefingFollowup,
  BriefingSections,
  BriefingResult,
  CalendarEvent,
  CalendarSource,
  RecallDisclosure,
} from "./types.js";

// Recall disclosure depth (issue #677).
export {
  DEFAULT_RECALL_DISCLOSURE,
  RECALL_DISCLOSURE_LEVELS,
  isRecallDisclosure,
} from "./types.js";

// ---------------------------------------------------------------------------
// Peer registry (issue #679 PR 1/5)
// ---------------------------------------------------------------------------

export type {
  Peer,
  PeerKind,
  PeerProfile,
  PeerProfileFieldProvenance,
  PeerInteractionLogEntry,
} from "./peers/index.js";
export {
  PEER_ID_PATTERN,
  PEER_ID_MAX_LENGTH,
  PEERS_DIR_NAME,
  assertValidPeerId,
  readPeer,
  writePeer,
  listPeers,
  appendInteractionLog,
  readInteractionLogRaw,
  readPeerProfile,
  writePeerProfile,
} from "./peers/index.js";

// ---------------------------------------------------------------------------
// Capsule fork (issue #676 PR 4/6)
// ---------------------------------------------------------------------------

export {
  forkCapsule,
  readForkLineage,
  type ForkCapsuleOptions,
  type ForkCapsuleResult,
  type ForkLineage,
} from "./transfer/capsule-fork.js";
