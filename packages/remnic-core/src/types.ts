export type ReasoningEffort = "none" | "low" | "medium" | "high";
export type TriggerMode = "smart" | "every_n" | "time_based";
export type SignalLevel = "none" | "low" | "medium" | "high";
export type MemoryCategory = "fact" | "preference" | "correction" | "entity" | "decision" | "relationship" | "principle" | "commitment" | "moment" | "skill" | "rule" | "procedure" | "reasoning_trace";
export type ConsolidationAction = "ADD" | "MERGE" | "UPDATE" | "INVALIDATE" | "SKIP";
export type ConfidenceTier = "explicit" | "implied" | "inferred" | "speculative";
export type PrincipalFromSessionKeyMode = "map" | "prefix" | "regex";
export type RecallPlanMode = "no_recall" | "minimal" | "full" | "graph_mode";
export type CronRecallMode = "all" | "none" | "allowlist";
export type CronConversationRecallMode = "auto" | "always" | "never";
export type IdentityInjectionMode = "recovery_only" | "minimal" | "full";
export type CaptureMode = "implicit" | "explicit" | "hybrid";
export type MemoryOsPresetName = "conservative" | "balanced" | "research-max" | "local-llm-heavy";
export type ExtractionPassSource = "base" | "proactive";
/**
 * Scope classification for extracted facts (issue #XXX).
 *
 * - `"project"` — knowledge specific to one codebase: file paths, environment
 *   configs, deployment details, project-specific workarounds, team/stakeholder
 *   info tied to one project.
 * - `"global"` — knowledge that applies across projects: core framework bugs,
 *   library behavior, API patterns, user preferences, tool configurations,
 *   general coding patterns, infrastructure knowledge.
 *
 * Default is `"project"` when a coding context is active, `"global"` when no
 * coding context is present.
 */
export type MemoryScope = "project" | "global";
export type SlotMismatchMode = "error" | "warn" | "silent";
export type CodexCompactionFlushMode = "signal" | "heuristic" | "auto";
export type DreamingNarrativePromptStyle = "reflective" | "diary" | "analytical";
export type HeartbeatDetectionMode = "runtime-signal" | "heuristic" | "auto";
export type ActiveRecallQueryMode = "message" | "recent" | "full";
export type ActiveRecallPromptStyle =
  | "balanced"
  | "strict"
  | "contextual"
  | "recall-heavy"
  | "precision-heavy"
  | "preference-only";
export type ActiveRecallThinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive";
export type ActiveRecallChatType = "direct" | "group" | "channel";
export type ActiveRecallModelFallbackPolicy = "default-remote" | "resolved-only";

/**
 * Retrieval tier ladder (issue #518).  Identifies which tier served a recall
 * result.  Ordered top-to-bottom by cost, but routing is not strictly
 * sequential — callers may jump straight to a lower tier when eligibility
 * does not hold.
 */
export type RetrievalTier =
  | "exact-cache"
  | "fuzzy-cache"
  | "direct-answer"
  | "hybrid"
  | "rerank-graph"
  | "agentic";

/**
 * Per-recall annotation describing which retrieval tier served a result,
 * why that tier was chosen, and what was filtered along the way.  Added as
 * part of issue #518 (direct-answer tier + `query --explain`).
 *
 * Not to be confused with the existing `recallExplain` operation
 * (graph-path explanation) — that is a user-invoked RPC; this is a
 * per-result annotation that can be attached to any recall response.
 */
export interface RecallTierExplain {
  tier: RetrievalTier;
  tierReason: string;
  filteredBy: string[];
  candidatesConsidered: number;
  latencyMs: number;
  sourceAnchors?: Array<{ path: string; lineRange?: [number, number] }>;
}

/**
 * Recall disclosure depth (issue #677).  Selects how much content each
 * recall result returns:
 *
 * - `"chunk"`   — semantic chunk excerpt (cheapest; default).
 * - `"section"` — full markdown section / memory body (current pre-#677 behavior).
 * - `"raw"`     — raw transcript / archive excerpts from `lcm/` when present.
 *
 * Disclosure is **orthogonal** to the retrieval-tier ladder
 * (`RetrievalTier` / `RETRIEVAL_TIERS`).  The tier ladder controls *which
 * pipeline stage served a result*; disclosure controls *how deep into the
 * underlying memory the result reaches*.  A request can mix any retrieval
 * tier with any disclosure depth.
 *
 * Default is `"chunk"` when the caller omits the field; this preserves the
 * existing recall behavior because callers that did not request a disclosure
 * level continue to receive the same chunk-shaped previews they always had.
 * Surfaces (CLI / HTTP / MCP) and downstream telemetry are wired in later
 * PRs of #677.
 */
export type RecallDisclosure = "chunk" | "section" | "raw";

/**
 * Ordered list of disclosure levels, cheapest to most expensive.  Used for
 * validation, escalation policy comparisons, and future telemetry rollups.
 * Treat this as the single source of truth — do not hard-code disclosure
 * strings elsewhere.
 */
export const RECALL_DISCLOSURE_LEVELS: readonly RecallDisclosure[] = [
  "chunk",
  "section",
  "raw",
] as const;

/**
 * Default disclosure level when a caller omits `disclosure`.  Set to `chunk`
 * so callers that did not opt in to deeper disclosure see the same
 * preview-shaped behavior as before #677.
 */
export const DEFAULT_RECALL_DISCLOSURE: RecallDisclosure = "chunk";

export function isRecallDisclosure(value: unknown): value is RecallDisclosure {
  return typeof value === "string"
    && (RECALL_DISCLOSURE_LEVELS as readonly string[]).includes(value);
}

export interface RecallSectionConfig {
  id: string;
  enabled?: boolean;
  maxChars?: number | null;
  maxHints?: number;
  maxSupportingFacts?: number;
  maxRelatedEntities?: number;
  consolidateTriggerLines?: number;
  consolidateTargetLines?: number;
  maxEntities?: number;
  maxResults?: number;
  recentTurns?: number;
  maxTurns?: number;
  maxTokens?: number;
  lookbackHours?: number;
  maxCount?: number;
  topK?: number;
  timeoutMs?: number;
  maxPatterns?: number;
  maxRubrics?: number;
  forceGeneric?: boolean;
}

export interface RecallPipelineConfig {
  recallBudgetChars: number;
  pipeline: RecallSectionConfig[];
}

export interface SessionObserverBandConfig {
  maxBytes: number;
  triggerDeltaBytes: number;
  triggerDeltaTokens: number;
}

export interface FileHygieneConfig {
  enabled: boolean;
  // Lint (warn before truncation risk)
  lintEnabled: boolean;
  lintBudgetBytes: number;
  lintWarnRatio: number;
  lintPaths: string[];
  // Rotation/splitting
  rotateEnabled: boolean;
  rotateMaxBytes: number;
  rotateKeepTailChars: number;
  rotatePaths: string[];
  archiveDir: string;
  // Cadence
  runMinIntervalMs: number;
  // Optional warnings log (future-proofed)
  warningsLogEnabled: boolean;
  warningsLogPath: string;
  // Optional index file (future-proofed)
  indexEnabled: boolean;
  indexPath: string;
}

export interface NativeKnowledgeConfig {
  enabled: boolean;
  includeFiles: string[];
  maxChunkChars: number;
  maxResults: number;
  maxChars: number;
  stateDir: string;
  obsidianVaults: NativeKnowledgeObsidianVaultConfig[];
  openclawWorkspace?: NativeKnowledgeOpenClawWorkspaceConfig;
}

export interface NativeKnowledgeFolderRuleConfig {
  pathPrefix: string;
  namespace?: string;
  privacyClass?: string;
}

export interface NativeKnowledgeObsidianVaultConfig {
  id: string;
  rootDir: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  namespace?: string;
  privacyClass?: string;
  folderRules: NativeKnowledgeFolderRuleConfig[];
  dailyNotePatterns: string[];
  materializeBacklinks: boolean;
}

export interface NativeKnowledgeOpenClawWorkspaceConfig {
  enabled: boolean;
  bootstrapFiles: string[];
  handoffGlobs: string[];
  dailySummaryGlobs: string[];
  automationNoteGlobs: string[];
  workspaceDocGlobs: string[];
  excludeGlobs: string[];
  sharedSafeGlobs: string[];
}

/**
 * OpenClaw SecretRef shape (issue #757).
 *
 * OpenClaw resolves these at runtime via its built-in secret resolver
 * (e.g. exec providers like `kc_*` for macOS Keychain). Plugins receive
 * the raw object in `pluginConfig` and must call the gateway's resolver
 * before using the value. Standalone Remnic does NOT resolve SecretRefs;
 * operators must use plain strings or `${ENV_VAR}` expansion instead.
 */
export interface SecretRef {
  source: string;
  provider?: string;
  id?: string;
  command?: unknown;
  [key: string]: unknown;
}

export type AgentAccessAuthToken = string | SecretRef;

export interface AgentAccessHttpConfig {
  enabled: boolean;
  host: string;
  port: number;
  /**
   * Bearer token. Either a literal string (env-expanded) or an unresolved
   * SecretRef object preserved verbatim from openclaw.json — resolved at
   * service-start time via {@link resolveAgentAccessAuthToken}.
   */
  authToken?: AgentAccessAuthToken;
  principal?: string;
  maxBodyBytes: number;
}

export interface DreamingConfig {
  enabled: boolean;
  journalPath: string;
  maxEntries: number;
  injectRecentCount: number;
  minIntervalMinutes: number;
  narrativeModel: string | null;
  narrativePromptStyle: DreamingNarrativePromptStyle;
  watchFile: boolean;
}

/**
 * Light-sleep phase config (issue #678 PR 2/4).
 *
 * Groups existing top-level lifecycle-policy gates under a unified namespace.
 * When `dreams.phases.lightSleep.*` keys are set they WIN over the legacy
 * top-level keys; the legacy keys remain readable for backward compatibility.
 *
 * Light sleep: recent activity scoring + clustering (tier-routing value score,
 * observation ledger, buffer state — `runLifecyclePolicyPass` in orchestrator).
 */
export interface DreamsLightSleepConfig {
  /** Phase master switch. Mirrors `lifecyclePolicyEnabled` when not set explicitly. */
  enabled: boolean;
  /** Minimum interval between light-sleep passes in milliseconds. */
  cadenceMs: number;
  /** Value score above which a memory is treated as hot. Mirrors `lifecyclePromoteHeatThreshold`. */
  promoteHeatThreshold: number;
  /** Value score below which a memory starts to decay. Mirrors `lifecycleStaleDecayThreshold`. */
  staleDecayThreshold: number;
  /** Value score below which a memory is eligible for archive. Mirrors `lifecycleArchiveDecayThreshold`. */
  archiveDecayThreshold: number;
  /** Whether stale memories are filtered from recall. Mirrors `lifecycleFilterStaleEnabled`. */
  filterStaleEnabled: boolean;
}

/**
 * REM phase config (issue #678 PR 2/4).
 *
 * Groups existing top-level semantic-consolidation and supersession gates.
 * When `dreams.phases.rem.*` keys are set they WIN over the legacy top-level
 * keys.
 *
 * REM: cross-session synthesis, supersession resolution, semantic consolidation
 * (`runSemanticConsolidation` in orchestrator).
 */
export interface DreamsRemConfig {
  /** Phase master switch. Mirrors `semanticConsolidationEnabled` when not set explicitly. */
  enabled: boolean;
  /**
   * How often the REM pass runs, in milliseconds.
   * Derived from `semanticConsolidationIntervalHours` (×3 600 000) when not set explicitly.
   */
  cadenceMs: number;
  /** Cosine-similarity threshold for cluster membership. Mirrors `semanticConsolidationThreshold`. */
  similarityThreshold: number;
  /** Minimum cluster size before consolidation runs. Mirrors `semanticConsolidationMinClusterSize`. */
  minClusterSize: number;
  /** Max cluster operations per run. Mirrors `semanticConsolidationMaxPerRun`. */
  maxPerRun: number;
  /** Minimum gap between consolidation passes (ms). Mirrors `consolidationMinIntervalMs`. */
  minIntervalMs: number;
}

/**
 * Deep-sleep phase config (issue #678 PR 2/4).
 *
 * Groups existing versioning and tier-migration gates.
 * When `dreams.phases.deepSleep.*` keys are set they WIN over the legacy
 * top-level keys.
 *
 * Deep sleep: promotion to durable memory, hot→cold tier migration,
 * page-version snapshots, archive (`engram-nightly-governance` cron,
 * `tier-migration.ts`, `page-versioning.ts`, `hygiene.ts`).
 */
export interface DreamsDeepSleepConfig {
  /**
   * Phase master switch. No single direct legacy mirror; defaults false unless
   * an existing deep-sleep surface such as nightly governance auto-registration,
   * tier migration, or page versioning is explicitly enabled. Set to `false`
   * to disable those surfaces without removing legacy config keys.
   */
  enabled: boolean;
  /** True only when dreams.phases.deepSleep.enabled was explicitly configured. */
  enabledExplicitlySet?: boolean;
  /**
   * Minimum interval between deep-sleep passes in milliseconds.
   * Informational only in PR 2; PR 4 will wire this into the cron scheduler.
   */
  cadenceMs: number;
  /** Enable page-version snapshots on every overwrite. Mirrors `versioningEnabled`. */
  versioningEnabled: boolean;
  /** Max snapshots per page. Mirrors `versioningMaxPerPage`. */
  versioningMaxPerPage: number;
}

/**
 * Unified dreams phases config block (issue #678 PR 2/4).
 *
 * Operators set `dreams.phases.{lightSleep,rem,deepSleep}.*` in their plugin
 * config. Values under this block WIN over the equivalent legacy top-level keys
 * when both are set. Legacy keys continue to be parsed so existing configs do
 * not need to change.
 *
 * This block is intentionally separate from `DreamingConfig` which controls the
 * diary surface (`surfaces/dreams.ts`) — a different feature. See docs/dreams.md.
 */
export interface DreamsPhasesConfig {
  lightSleep: DreamsLightSleepConfig;
  rem: DreamsRemConfig;
  deepSleep: DreamsDeepSleepConfig;
}

/** Procedural memory (issue #519): mining + recall gates. All sub-features default off. */
export interface ProceduralConfig {
  enabled: boolean;
  /** Minimum cluster size before emitting a candidate; `0` disables mining (`minOccurrences_zero`). */
  minOccurrences: number;
  /** Minimum success rate from trajectory outcomes in [0, 1]. */
  successFloor: number;
  /** When auto-promotion is enabled, promote pending_review → active after this many occurrences. */
  autoPromoteOccurrences: number;
  autoPromoteEnabled: boolean;
  lookbackDays: number;
  /** When true, installer may register the nightly procedural mining cron (default off). */
  proceduralMiningCronAutoRegister: boolean;
  /** Max procedure memories to inject on task-initiation recall (1–10). */
  recallMaxProcedures: number;
}

/**
 * Coding-agent mode config (issue #569).
 *
 * When the connector provides a `CodingContext` (see below), Remnic overlays
 * a project- and/or branch-scoped namespace on top of the principal's default
 * namespace so that memories written while working on project A do not surface
 * while working on project B.
 *
 * Both flags default off-for-branch / on-for-project. Per CLAUDE.md #30 every
 * filter or transform needs an escape hatch: set `projectScope: false` to
 * exactly restore pre-#569 behaviour.
 */
export interface CodingModeConfig {
  /**
   * When true (default), a session with a resolved `CodingContext` uses a
   * project-scoped namespace. When false, the principal's default namespace
   * is used unchanged (pre-#569 behaviour).
   */
  projectScope: boolean;
  /**
   * When true, recall/write also overlay the current branch on top of the
   * project namespace. Default false — branch-scope is opt-in because active
   * development typically wants recall across branches. (Wired by PR 3 of
   * issue #569; declared here so the schema ships in one slice.)
   */
  branchScope: boolean;
  /**
   * When true (default), project-scoped and branch-scoped sessions include
   * the root/default namespace in their read fallbacks so globally useful
   * memories remain visible from any project. When false, project-scoped
   * sessions only see their own namespace (strict isolation).
   *
   * CLAUDE.md #30: configuration gate for the recall fan-out to the root
   * namespace. Does not affect writes — those always go to the project
   * namespace only.
   */
  globalFallback: boolean;
}

/**
 * Session-scoped coding context. Produced by `resolveGitContext()` in the
 * connector layer and attached to a session so that recall + write paths can
 * compute an overlay namespace.
 *
 * All fields mirror `GitContext` from `./coding/git-context.ts`; kept as a
 * separate interface because `types.ts` must stay dependency-free (it is
 * imported by every other module).
 */
export interface CodingContext {
  projectId: string;
  branch: string | null;
  rootPath: string;
  defaultBranch: string | null;
}

/** Configuration for the nightly contradiction-scan cron (issue #520). */
export interface ContradictionScanConfig {
  /** Master switch for the contradiction scan cron. Default true. */
  enabled: boolean;
  /** Embedding cosine similarity floor for candidate pair generation. Default 0.82. */
  similarityFloor: number;
  /** Minimum topic-token Jaccard overlap for unstructured pairs. Default 0.4. */
  topicOverlapFloor: number;
  /** Cap on candidate pairs evaluated per cron run. Default 500. */
  maxPairsPerRun: number;
  /** Cooldown in days before re-evaluating a pair judged independent/both-valid. Default 14. */
  cooldownDays: number;
  /** When true, pairs judged "duplicates" are auto-flagged for dedup (still need user approval). Default false. */
  autoMergeDuplicates: boolean;
}

export interface HeartbeatConfig {
  enabled: boolean;
  journalPath: string;
  maxPreviousRuns: number;
  watchFile: boolean;
  detectionMode: HeartbeatDetectionMode;
  gateExtractionDuringHeartbeat: boolean;
}

export interface SlotBehaviorConfig {
  requireExclusiveMemorySlot: boolean;
  onSlotMismatch: SlotMismatchMode;
}

export interface CodexCompatConfig {
  enabled: boolean;
  threadIdBufferKeying: boolean;
  compactionFlushMode: CodexCompactionFlushMode;
  fingerprintDedup: boolean;
}

export function confidenceTier(score: number): ConfidenceTier {
  if (score >= 0.95) return "explicit";
  if (score >= 0.70) return "implied";
  if (score >= 0.40) return "inferred";
  return "speculative";
}

/** Default TTL in days for speculative memories (auto-expire if unconfirmed) */
export const SPECULATIVE_TTL_DAYS = 30;

/**
 * Shape for semantic chunking config overrides stored in PluginConfig.
 * Mirrors SemanticChunkingConfig from semantic-chunking.ts without creating
 * a circular import (types.ts is imported by everything).
 */
export interface SemanticChunkingConfigShape {
  targetTokens: number;
  minTokens: number;
  maxTokens: number;
  smoothingWindowSize: number;
  boundaryThresholdStdDevs: number;
  embeddingBatchSize: number;
  fallbackToRecursive: boolean;
}

export interface PluginConfig {
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  model: string;
  reasoningEffort: ReasoningEffort;
  triggerMode: TriggerMode;
  bufferMaxTurns: number;
  bufferMaxMinutes: number;
  /**
   * Surprise-gated buffer flush (issue #563, D-MEM).
   *
   * When enabled, every turn added to the smart buffer is scored against a
   * configurable window of recent memories using an embedding-distance proxy
   * for novelty (see `buffer-surprise.ts`). A turn whose surprise score
   * exceeds `bufferSurpriseThreshold` triggers an immediate extract flush,
   * even if the existing signal/turn-count/time triggers would otherwise keep
   * buffering. Disabled by default — when `false`, buffer behavior is
   * identical to pre-#563 code. Additive only: existing triggers are never
   * suppressed by this flag.
   */
  bufferSurpriseTriggerEnabled: boolean;
  /**
   * Threshold in `[0, 1]` above which a surprise score causes an immediate
   * flush. `0.35` is a conservative default chosen to favor precision over
   * recall during the opt-in phase. Ignored unless
   * `bufferSurpriseTriggerEnabled` is `true`.
   */
  bufferSurpriseThreshold: number;
  /**
   * Number of nearest neighbors to average over when computing the surprise
   * score (see `computeSurprise`). Default `5`. Clamped to the recent-memory
   * window size at call time.
   */
  bufferSurpriseK: number;
  /**
   * Maximum number of recent memories to sample when computing the surprise
   * score. Bounds embedding cost per turn. Default `20`. Set to `0` to
   * disable the trigger even when the flag is on (no memories to compare
   * against → treat as not-applicable rather than maximally surprising).
   */
  bufferSurpriseRecentMemoryCount: number;
  /**
   * Hard timeout (ms) for the surprise probe. If the probe does not
   * resolve within this window, the buffer treats the probe as failed,
   * logs at debug, and falls through to the existing triggers. Ensures
   * a slow or hung embedder cannot stall the turn-append path. Default
   * `2000` (2s).
   */
  bufferSurpriseProbeTimeoutMs: number;
  consolidateEveryN: number;
  highSignalPatterns: string[];
  maxMemoryTokens: number;
  memoryOsPreset?: MemoryOsPresetName;
  qmdEnabled: boolean;
  qmdCollection: string;
  qmdMaxResults: number;
  qmdColdTierEnabled?: boolean;
  qmdColdCollection?: string;
  qmdColdMaxResults?: number;
  qmdTierMigrationEnabled: boolean;
  qmdTierDemotionMinAgeDays: number;
  qmdTierDemotionValueThreshold: number;
  qmdTierPromotionValueThreshold: number;
  qmdTierParityGraphEnabled: boolean;
  qmdTierParityHiMemEnabled: boolean;
  qmdTierAutoBackfillEnabled: boolean;
  qmdSupportedVersion: string;
  qmdAutoUpgradeEnabled: boolean;
  qmdAutoUpgradeCheckIntervalMs: number;
  qmdChunkStrategy: "auto" | "regex";
  qmdCandidateLimit?: number;
  qmdQueryRerankEnabled: boolean;
  qmdIndexName?: string;
  qmdForceCpu: boolean;
  qmdGpuBackend?: "auto" | "metal" | "cuda" | "vulkan" | "false";
  qmdEmbedParallelism?: number;
  qmdEmbedModel?: string;
  qmdRerankModel?: string;
  qmdGenerateModel?: string;
  embeddingFallbackEnabled: boolean;
  embeddingFallbackProvider: "auto" | "openai" | "local";
  /**
   * Optional model identifier for local embedding fallback requests.
   *
   * Local chat/completion models and local embedding models are often
   * different LM Studio/Ollama model IDs. When unset, Remnic preserves the
   * legacy behavior and falls back to `localLlmModel`.
   */
  embeddingFallbackModel: string;
  /** Optional absolute path to qmd binary. If unset, PATH/fallback discovery is used. */
  qmdPath?: string;
  memoryDir: string;
  debug: boolean;
  identityEnabled: boolean;
  identityContinuityEnabled: boolean;
  identityInjectionMode: IdentityInjectionMode;
  identityMaxInjectChars: number;
  continuityIncidentLoggingEnabled: boolean;
  continuityAuditEnabled: boolean;
  sessionObserverEnabled?: boolean;
  sessionObserverDebounceMs?: number;
  sessionObserverBands?: SessionObserverBandConfig[];
  injectQuestions: boolean;
  commitmentDecayDays: number;
  workspaceDir: string;
  captureMode: CaptureMode;
  fileHygiene?: FileHygieneConfig;
  nativeKnowledge?: NativeKnowledgeConfig;
  agentAccessHttp: AgentAccessHttpConfig;
  // Access tracking (Phase 1A)
  accessTrackingEnabled: boolean;
  accessTrackingBufferMaxSize: number;
  // Retrieval options
  recencyWeight: number;
  boostAccessCount: boolean;
  /** Record empty recall impressions (memoryIds: []) when no memories are injected. Disabled by default. */
  recordEmptyRecallImpressions: boolean;
  // v2.2 Advanced Retrieval
  queryExpansionEnabled: boolean;
  queryExpansionMaxQueries: number;
  /** Minimum token length to consider for query expansion. */
  queryExpansionMinTokenLen: number;
  rerankEnabled: boolean;
  /** Rerank provider. "local" uses Local LLM only; "cloud" uses gateway fallback chain. */
  rerankProvider: "local" | "cloud";
  rerankMaxCandidates: number;
  rerankTimeoutMs: number;
  rerankCacheEnabled: boolean;
  rerankCacheTtlMs: number;
  feedbackEnabled: boolean;
  // v2.2 Negative Examples (safe defaults: off unless enabled)
  /** If true, allow recording negative examples and apply a soft penalty during ranking. */
  negativeExamplesEnabled: boolean;
  /** Score penalty per "not useful" hit (typical QMD scores ~0-1). Keep small. */
  negativeExamplesPenaltyPerHit: number;
  /** Maximum penalty applied from negative examples. */
  negativeExamplesPenaltyCap: number;
  // Chunking (Phase 2A)
  chunkingEnabled: boolean;
  chunkingTargetTokens: number;
  chunkingMinTokens: number;
  chunkingOverlapSentences: number;
  // Semantic Chunking (Issue #368)
  /** Enable semantic chunking with embedding-based topic boundary detection. Default: false. */
  semanticChunkingEnabled: boolean;
  /** Optional overrides for the semantic chunking algorithm. */
  semanticChunkingConfig: Partial<SemanticChunkingConfigShape>;
  // Contradiction Detection (Phase 2B)
  contradictionDetectionEnabled: boolean;
  contradictionSimilarityThreshold: number;
  contradictionMinConfidence: number;
  contradictionAutoResolve: boolean;
  /** Nightly contradiction-scan cron config (issue #520). */
  contradictionScan: ContradictionScanConfig;
  // Temporal Supersession (issue #375)
  /**
   * When enabled, writes that carry `structuredAttributes` mark any older
   * fact with the same `entityRef + attribute_name` supersession key and a
   * conflicting value as `status: "superseded"`.
   */
  temporalSupersessionEnabled: boolean;
  /**
   * When enabled, superseded memories are still returned by recall (useful
   * for audit/history queries).  Default: false — superseded memories are
   * filtered out.
   */
  temporalSupersessionIncludeInRecall: boolean;
  // Direct-answer retrieval tier (issue #518)
  /**
   * When true, recall checks whether a single validated memory in a
   * high-trust taxonomy bucket can answer the query before invoking QMD.
   * Default false — enable explicitly after bench validation.
   */
  recallDirectAnswerEnabled: boolean;
  /**
   * Disclosure auto-escalation policy (issue #677 PR 4/4).  When set to
   * `"auto"`, recalls without an explicit caller-supplied disclosure
   * escalate from `chunk` to `section` if the top-K confidence falls
   * below {@link recallDisclosureEscalationThreshold}.  `raw` is never
   * auto-selected — it requires an explicit caller request.  Default
   * `"manual"` preserves pre-#677 behavior.
   */
  recallDisclosureEscalation: "manual" | "auto";
  /**
   * Top-K confidence threshold (in `[0, 1]`) below which auto-escalation
   * promotes `chunk` → `section`.  Only consulted when
   * {@link recallDisclosureEscalation} is `"auto"`.  Default `0.5`.
   */
  recallDisclosureEscalationThreshold: number;
  /**
   * Graph-based retrieval tier via Personalized PageRank (issue #559 PR 4).
   * When true, recall builds a retrieval graph from memory frontmatter
   * and runs PPR, merging the result with QMD via MMR.  Default false —
   * ships off pending the retrieval-graph bench in PR 5.
   */
  recallGraphEnabled: boolean;
  /** PPR damping factor used when `recallGraphEnabled` is true. */
  recallGraphDamping: number;
  /** PPR power-iteration cap used when `recallGraphEnabled` is true. */
  recallGraphIterations: number;
  /**
   * Max memories returned by the graph tier before MMR.  Set to 0 to
   * disable the graph tier's contribution without flipping the flag.
   */
  recallGraphTopK: number;
  /**
   * Minimum token-overlap ratio (query tokens ∩ memory tokens / query tokens)
   * required for direct-answer eligibility.  Set to 0 to disable the gate.
   */
  recallDirectAnswerTokenOverlapFloor: number;
  /**
   * Minimum calibrated importance score required for direct-answer
   * eligibility.  Set to 0 to disable the gate.
   */
  recallDirectAnswerImportanceFloor: number;
  /**
   * Ambiguity margin: if the second-best candidate scores within this
   * ratio of the top candidate, direct-answer defers to the hybrid tier.
   */
  recallDirectAnswerAmbiguityMargin: number;
  /**
   * Taxonomy category IDs eligible for direct-answer routing.  Memories
   * whose resolved taxonomy category is not in this list never qualify.
   */
  recallDirectAnswerEligibleTaxonomyBuckets: string[];
  /**
   * Cross-namespace query-budget limiter (issue #565 PR 4/5). When true,
   * a principal that issues a burst of recalls against namespaces other
   * than their own is throttled once its per-window count crosses
   * `recallCrossNamespaceBudgetHardLimit`. Default false — ships disabled.
   */
  recallCrossNamespaceBudgetEnabled: boolean;
  /** Rolling window in milliseconds over which cross-namespace reads are counted. */
  recallCrossNamespaceBudgetWindowMs: number;
  /**
   * Soft threshold — the first point at which the limiter flags a burst.
   * Calls are still allowed; anomaly detection (issue #565 PR 5) will
   * surface the warning.
   */
  recallCrossNamespaceBudgetSoftLimit: number;
  /** Hard threshold — calls past this count are denied in the window. */
  recallCrossNamespaceBudgetHardLimit: number;
  // Memory Worth recall filter (issue #560 PR 4)
  /**
   * When true, recall multiplies candidate scores by the Memory Worth
   * factor computed from `mw_success` / `mw_fail` counters on each
   * memory's frontmatter (see `computeMemoryWorth`). Memories with a
   * history of failed sessions sink; neutral / uninstrumented memories
   * are untouched (multiplier 1.0). Default false — flip to true in PR 5
   * once the benchmark shows precision tie-or-win.
   */
  recallMemoryWorthFilterEnabled: boolean;
  /**
   * Recall-audit anomaly detector (issue #565 PR 5/5). When true,
   * access surfaces run the anomaly detector over a tail of the audit
   * trail after each recall and surface any flags via logs / metrics.
   * Ships disabled.
   */
  recallAuditAnomalyDetectionEnabled: boolean;
  /** Rolling window over which audit entries are analyzed. */
  recallAuditAnomalyWindowMs: number;
  /** Threshold for the `repeat-query` flag. */
  recallAuditAnomalyRepeatQueryLimit: number;
  /** Threshold for the `namespace-walk` flag (distinct namespaces). */
  recallAuditAnomalyNamespaceWalkLimit: number;
  /** Threshold for the `high-cardinality-return` flag. */
  recallAuditAnomalyHighCardinalityLimit: number;
  /** Threshold for the `rapid-fire` flag. */
  recallAuditAnomalyRapidFireLimit: number;
  /**
   * Optional half-life for Memory Worth decay, in milliseconds. When
   * positive, older outcome observations are exponentially decayed toward
   * the uniform prior. Set to 0 (default) to disable decay and use raw
   * counter values.
   */
  recallMemoryWorthHalfLifeMs: number;
  // Memory Linking (Phase 3A)
  memoryLinkingEnabled: boolean;
  // Conversation Threading (Phase 3B)
  threadingEnabled: boolean;
  threadingGapMinutes: number;
  // Memory Summarization (Phase 4A)
  summarizationEnabled: boolean;
  summarizationTriggerCount: number;
  summarizationRecentToKeep: number;
  summarizationImportanceThreshold: number;
  summarizationProtectedTags: string[];
  // Topic Extraction (Phase 4B)
  topicExtractionEnabled: boolean;
  topicExtractionTopN: number;
  // Transcript & Context Preservation (v2.0)
  // Transcript archive
  transcriptEnabled: boolean;
  transcriptRetentionDays: number;
  /** Channel types to skip from transcript logging (e.g., ["cron"]) */
  transcriptSkipChannelTypes: string[];
  // Transcript injection
  transcriptRecallHours: number;
  maxTranscriptTurns: number;
  maxTranscriptTokens: number;
  // Checkpoint
  checkpointEnabled: boolean;
  checkpointTurns: number;
  // Compaction reset: trigger session reset after compaction instead of continuing degraded.
  // Requires OC fork with PR #29985 (api.resetSession).
  compactionResetEnabled: boolean;
  beforeResetTimeoutMs: number;
  initGateTimeoutMs: number;
  flushOnResetEnabled: boolean;
  commandsListEnabled: boolean;
  openclawToolsEnabled: boolean;
  openclawToolSnippetMaxChars: number;
  sessionTogglesEnabled: boolean;
  verboseRecallVisibility: boolean;
  recallTranscriptsEnabled: boolean;
  recallTranscriptRetentionDays: number;
  respectBundledActiveMemoryToggle: boolean;
  activeRecallEnabled: boolean;
  activeRecallAgents: string[] | null;
  activeRecallAllowedChatTypes: ActiveRecallChatType[];
  activeRecallQueryMode: ActiveRecallQueryMode;
  activeRecallPromptStyle: ActiveRecallPromptStyle;
  activeRecallCustomInstruction: string | null;
  activeRecallPromptAppend: string | null;
  activeRecallMaxSummaryChars: number;
  activeRecallRecentUserTurns: number;
  activeRecallRecentAssistantTurns: number;
  activeRecallRecentUserChars: number;
  activeRecallRecentAssistantChars: number;
  activeRecallThinking: ActiveRecallThinking;
  activeRecallTimeoutMs: number;
  activeRecallCacheTtlMs: number;
  activeRecallModel: string | null;
  activeRecallModelFallbackPolicy: ActiveRecallModelFallbackPolicy;
  activeRecallPersistTranscripts: boolean;
  activeRecallTranscriptDir: string;
  activeRecallEntityGraphDepth: number;
  activeRecallIncludeCausalTrajectories: boolean;
  activeRecallIncludeDaySummary: boolean;
  activeRecallAttachRecallExplain: boolean;
  activeRecallAllowChainedActiveMemory: boolean;
  dreaming: DreamingConfig;
  /**
   * Unified dreams-phases config block (issue #678 PR 2/4).
   * Groups existing lifecycle, REM, and deep-sleep gates under one namespace.
   * Values here WIN over equivalent legacy top-level keys when set. See docs/dreams.md.
   */
  dreamsPhases: DreamsPhasesConfig;
  procedural: ProceduralConfig;
  /**
   * At-rest encryption configuration (issue #690 PR 3/4).
   *
   * When `secureStoreEnabled` is true, `StorageManager` reads and
   * writes memory files through the `secure-fs` encryption layer.
   * The store must be unlocked via `remnic secure-store unlock` before
   * any recall or store operations will succeed.
   *
   * When `secureStoreEncryptOnWrite` is true (the default when enabled),
   * every new memory write is encrypted. Set to false to pause new
   * encryptions while still being able to decrypt existing files.
   */
  secureStoreEnabled: boolean;
  /** Encrypt new writes when the secure-store is unlocked. Default true. */
  secureStoreEncryptOnWrite: boolean;
  // Coding-agent project/branch scoping (issue #569)
  codingMode: CodingModeConfig;
  heartbeat: HeartbeatConfig;
  slotBehavior: SlotBehaviorConfig;
  codexCompat: CodexCompatConfig;
  /**
   * When true (default), the extraction prompt instructs the LLM to classify
   * each fact as `"project"` or `"global"` scope. Global-scoped facts are
   * promoted to the shared namespace so they are visible across all projects.
   * When false, all facts go to whatever namespace the session is in (pre-
   * scope-classification behavior). Rule 30: configuration gate.
   */
  extractionScopeClassificationEnabled: boolean;
  // Extraction judge (issue #376)
  /** Enable the LLM-as-judge fact-worthiness gate on extracted facts. Default false (opt-in). */
  extractionJudgeEnabled: boolean;
  /** Model override for the judge LLM. Empty string means use the local model. */
  extractionJudgeModel: string;
  /** Maximum number of candidate facts per judge LLM batch call. */
  extractionJudgeBatchSize: number;
  /** Shadow mode: log judge verdicts but do not filter facts. Default false. */
  extractionJudgeShadow: boolean;
  /**
   * Maximum number of times the same candidate text may be deferred before
   * the judge forcibly converts the verdict to `"reject"`. Prevents
   * pathological LLM responses from looping forever on ambiguous facts.
   * Defaults to 2 (issue #562, PR 2).
   */
  extractionJudgeMaxDeferrals: number;
  /**
   * Emit structured telemetry rows to
   * `state/observation-ledger/extraction-judge-verdicts.jsonl` on every
   * judge verdict. Off by default; enable to collect defer-rate / latency
   * metrics for operator dashboards (issue #562, PR 3).
   */
  extractionJudgeTelemetryEnabled: boolean;
  /**
   * Collect `(candidate_text, verdict_kind, reason)` tuples into
   * `~/.remnic/judge-training/<date>.jsonl` for use by a future GRPO
   * training pipeline (issue #562, PR 4). Off by default. Rows live in
   * the user's home directory rather than the shared memory directory so
   * they are not committed, sync'd, or bundled into memory exports.
   */
  collectJudgeTrainingPairs: boolean;
  /**
   * Override directory for judge training-pair collection. Empty string
   * means use the default (`~/.remnic/judge-training`). Primarily for
   * tests and for operators who want the output to land in a specific
   * location.
   */
  judgeTrainingDir: string;
  // Hourly summaries
  hourlySummariesEnabled: boolean;
  daySummaryEnabled: boolean;
  /** If true, Engram may attempt to auto-register an hourly summary cron job (default off). */
  hourlySummaryCronAutoRegister: boolean;
  /** If true, Engram may attempt to auto-register the nightly governance cron job (default off). */
  nightlyGovernanceCronAutoRegister: boolean;
  summaryRecallHours: number;
  maxSummaryCount: number;
  summaryModel: string;
  // v2.4 Extended hourly summaries
  hourlySummariesExtendedEnabled: boolean;
  hourlySummariesIncludeToolStats: boolean;
  hourlySummariesIncludeSystemMessages: boolean;
  hourlySummariesMaxTurnsPerRun: number;
  // v2.4 Conversation index (optional)
  conversationIndexEnabled: boolean;
  conversationIndexBackend: "qmd" | "faiss";
  conversationIndexQmdCollection: string;
  conversationIndexRetentionDays: number;
  conversationIndexMinUpdateIntervalMs: number;
  conversationIndexEmbedOnUpdate: boolean;
  conversationIndexFaissScriptPath?: string;
  conversationIndexFaissPythonBin?: string;
  conversationIndexFaissModelId: string;
  conversationIndexFaissIndexDir: string;
  conversationIndexFaissUpsertTimeoutMs: number;
  conversationIndexFaissSearchTimeoutMs: number;
  conversationIndexFaissHealthTimeoutMs: number;
  conversationIndexFaissMaxBatchSize: number;
  conversationIndexFaissMaxSearchK: number;
  conversationRecallTopK: number;
  conversationRecallMaxChars: number;
  conversationRecallTimeoutMs: number;
  // Evaluation harness foundation
  evalHarnessEnabled: boolean;
  evalShadowModeEnabled: boolean;
  benchmarkBaselineSnapshotsEnabled: boolean;
  benchmarkDeltaReporterEnabled: boolean;
  benchmarkStoredBaselineEnabled: boolean;
  evalStoreDir: string;
  // Objective-state memory foundation
  objectiveStateMemoryEnabled: boolean;
  objectiveStateSnapshotWritesEnabled: boolean;
  objectiveStateRecallEnabled: boolean;
  objectiveStateStoreDir: string;
  // Causal trajectory memory foundation
  causalTrajectoryMemoryEnabled: boolean;
  causalTrajectoryStoreDir: string;
  causalTrajectoryRecallEnabled: boolean;
  actionGraphRecallEnabled: boolean;
  // Trust-zone memory foundation
  trustZonesEnabled: boolean;
  quarantinePromotionEnabled: boolean;
  trustZoneStoreDir: string;
  trustZoneRecallEnabled: boolean;
  memoryPoisoningDefenseEnabled: boolean;
  memoryRedTeamBenchEnabled: boolean;
  // Harmonic retrieval foundation
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
  abstractionNodeStoreDir: string;
  // Episodic/semantic split foundation
  verifiedRecallEnabled: boolean;
  semanticRulePromotionEnabled: boolean;
  semanticRuleVerificationEnabled: boolean;
  semanticConsolidationEnabled: boolean;
  semanticConsolidationModel: string;
  semanticConsolidationThreshold: number;
  semanticConsolidationMinClusterSize: number;
  semanticConsolidationExcludeCategories: string[];
  semanticConsolidationIntervalHours: number;
  semanticConsolidationMaxPerRun: number;
  /**
   * When true (default), semantic-consolidation prompts the LLM with an
   * operator-aware format asking for JSON `{operator, output}` and records
   * the resulting SPLIT/MERGE/UPDATE operator on `derived_via`.  When
   * false, falls back to the legacy plain-text prompt — `derived_via` is
   * still populated via the cluster-shape heuristic in
   * `chooseConsolidationOperator`.  Issue #561 PR 3.
   */
  operatorAwareConsolidationEnabled: boolean;
  // Pattern reinforcement (issue #687 PR 2/4)
  /**
   * When true, the pattern-reinforcement maintenance job runs on its
   * configured cadence and clusters duplicate non-procedural memories
   * by normalized content.  Clusters with `>= patternReinforcementMinCount`
   * members produce a canonical (most-recent) memory tagged with
   * `reinforcement_count` + `last_reinforced_at`; the older duplicates
   * are marked `superseded` and pointed at the canonical.  Default
   * `false` — opt-in until bench validation lands.
   */
  patternReinforcementEnabled: boolean;
  /**
   * Minimum interval (ms) between pattern-reinforcement runs.  Default
   * `7 * 24 * 60 * 60 * 1000` (7 days).  Set to `0` to disable cadence
   * gating (useful for tests / manual invocation).
   */
  patternReinforcementCadenceMs: number;
  /**
   * Minimum cluster size before pattern reinforcement promotes a
   * canonical and supersedes duplicates.  Default `3`.  Clamped to
   * `>= 2` at config-parse time — a "cluster of 1" is just a single
   * memory and a "cluster of 0" is meaningless.
   */
  patternReinforcementMinCount: number;
  /**
   * Memory categories the pattern-reinforcement job considers.
   * Default `["preference", "fact", "decision"]`.  The job
   * intentionally skips procedural memories so it stays disjoint from
   * the procedural mining pipeline.
   */
  patternReinforcementCategories: string[];
  /** issue #687 PR 3/4: opt-in recall score boost for reinforced memories. Default false. */
  reinforcementRecallBoostEnabled: boolean;
  /** Score bonus per unit of reinforcement_count. Range [0, 1]. Default 0.05. */
  reinforcementRecallBoostWeight: number;
  /** Maximum additive reinforcement boost per result. Range [0, 1]. Default 0.3. */
  reinforcementRecallBoostMax: number;
  /**
   * Async peer profile reasoner — issue #679 PR 2/5.
   *
   * Default `false` (opt-in). When enabled, the reasoner runs after
   * `runSemanticConsolidation` (the REM phase of the dreams pipeline)
   * and updates per-peer profile.md files with provenance-tagged
   * field updates derived from the peer's interaction log.
   */
  peerProfileReasonerEnabled: boolean;
  /**
   * Model identifier used by the peer profile reasoner. Logged for
   * telemetry only — actual dispatch is via the same FallbackLlmClient
   * the orchestrator uses for semantic consolidation. Default `gpt-5.5`.
   */
  peerProfileReasonerModel: string;
  /**
   * Minimum new interaction-log entries a peer must accumulate since
   * the previous reasoner run before being processed again. Default 5.
   * Setting to 0 forces every run to consider every peer.
   */
  peerProfileReasonerMinInteractions: number;
  /**
   * Hard cap on the total number of profile fields the reasoner will
   * apply across all peers in a single run. Default 8.
   */
  peerProfileReasonerMaxFieldsPerRun: number;
  /**
   * When true, inject the active peer's profile fields into the recall
   * context as a "## Peer Profile" section. Default false (opt-in,
   * Gotcha #30/#48 — least-privileged default). Requires the session's
   * peer ID to be registered via `setPeerIdForSession` before recall.
   */
  peerProfileRecallEnabled: boolean;
  /**
   * Maximum number of peer profile fields to inject per recall. Only
   * the most-recently-updated N fields are included to keep the context
   * budget predictable. Default 5. Setting to 0 disables field
   * injection even when `peerProfileRecallEnabled` is true.
   */
  peerProfileRecallMaxFields: number;
  // Creation-memory foundation
  creationMemoryEnabled: boolean;
  memoryUtilityLearningEnabled: boolean;
  promotionByOutcomeEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled: boolean;
  commitmentStaleDays: number;
  commitmentLedgerDir: string;
  resumeBundlesEnabled: boolean;
  resumeBundleDir: string;
  workProductRecallEnabled: boolean;
  workProductLedgerDir: string;
  workTasksEnabled: boolean;
  workProjectsEnabled: boolean;
  workTasksDir: string;
  workProjectsDir: string;
  workIndexEnabled: boolean;
  workIndexDir: string;
  workTaskIndexEnabled: boolean;
  workProjectIndexEnabled: boolean;
  workIndexAutoRebuildEnabled: boolean;
  workIndexAutoRebuildDebounceMs: number;
  // Local LLM Provider (v2.1)
  localLlmEnabled: boolean;
  localLlmUrl: string;
  localLlmModel: string;
  /** Optional API key for authenticated OpenAI-compatible endpoints. */
  localLlmApiKey?: string;
  /** Additional headers for local/compatible endpoint requests. */
  localLlmHeaders?: Record<string, string>;
  /** If false, do not send Authorization header even when localLlmApiKey is set. */
  localLlmAuthHeader: boolean;
  localLlmFallback: boolean;
  /** Optional home directory override for local LLM helpers (LM Studio settings, CLI PATH). */
  localLlmHomeDir?: string;
  /** Optional absolute path to LMS CLI binary (preferred over auto-detection). */
  localLmsCliPath?: string;
  /** Optional bin directory prepended to PATH for LMS CLI execution. */
  localLmsBinDir?: string;
  /** Hard timeout for local LLM and gateway fallback requests (ms). */
  localLlmTimeoutMs: number;
  /** Max context window for local LLM (override auto-detection). Set lower if your LLM server defaults to smaller contexts. */
  localLlmMaxContext?: number;
  // Observability
  /** If true, log slow operations (local LLM + related I/O) with durations and metadata (no content). */
  slowLogEnabled: boolean;
  /**
   * If true, include the full recalled memory text in `RecallTraceEvent.recalledContent`.
   * Disabled by default — enable only when you want external trace subscribers (e.g. Langfuse)
   * to see the exact memory context injected into each conversation turn.
   * This adds payload to trace events but does not log to files or the gateway log.
   */
  traceRecallContent: boolean;
  /** Threshold for slow operation logging (ms). */
  slowLogThresholdMs: number;
  // Performance profiling (opt-in)
  /** If true, collect and persist timing traces for recall and extraction pipelines. */
  profilingEnabled: boolean;
  /** Directory for profiling trace JSONL files. Defaults to <memoryDir>/profiling. */
  profilingStorageDir: string;
  /** Maximum number of trace files to keep (rolling window). */
  profilingMaxTraces: number;
  // Extraction stability guards (P0/P1)
  extractionDedupeEnabled: boolean;
  extractionDedupeWindowMs: number;
  extractionMinChars: number;
  extractionMinUserTurns: number;
  /**
   * When true, skip semantic memory extraction for mechanical action/state
   * telemetry transcripts that have no durable-memory cue. Raw transcript
   * storage/recall still runs; this only prevents expensive low-value fact
   * extraction over state logs. Default true.
   */
  extractionTelemetryPrefilterEnabled: boolean;
  /**
   * When true, LCM uses deterministic compression instead of semantic LLM
   * summarization for mechanical action/state telemetry transcripts with no
   * durable-memory cue. Raw transcript storage/recall still runs. Default true.
   */
  lcmTelemetryPrefilterEnabled: boolean;
  extractionMaxTurnChars: number;
  extractionMaxFactsPerRun: number;
  extractionMaxEntitiesPerRun: number;
  extractionMaxQuestionsPerRun: number;
  extractionMaxProfileUpdatesPerRun: number;
  /**
   * Minimum importance level required to persist an extracted fact. Facts
   * whose locally-scored level falls below this threshold are dropped before
   * write and counted toward the `importance_gated` metric. Defaults to
   * "low" so trivial content (greetings, single-word replies, filler) is
   * silently dropped while everything else still passes.
   */
  extractionMinImportanceLevel: ImportanceLevel;
  /**
   * Inline source attribution (issue #369).
   * When enabled, extracted facts carry a compact provenance tag (agent,
   * session, timestamp) inlined into the fact text — not just in YAML
   * frontmatter — so the citation survives hostile memory text, copy/paste,
   * and LLM quoting. Off by default to preserve backwards compatibility
   * with existing downstream consumers that expect raw fact text.
   */
  inlineSourceAttributionEnabled: boolean;
  /**
   * Template used when injecting inline citations. Supported placeholders:
   * `{agent}`, `{session}`, `{sessionId}`, `{ts}`, `{date}`. Defaults to
   * `[Source: agent={agent}, session={sessionId}, ts={ts}]`.
   */
  inlineSourceAttributionFormat: string;
  consolidationRequireNonZeroExtraction: boolean;
  consolidationMinIntervalMs: number;
  // QMD maintenance (debounced singleflight)
  qmdMaintenanceEnabled: boolean;
  qmdMaintenanceDebounceMs: number;
  qmdAutoEmbedEnabled: boolean;
  qmdEmbedMinIntervalMs: number;
  qmdUpdateTimeoutMs: number;
  qmdUpdateMinIntervalMs: number;
  // Local LLM resilience
  localLlmRetry5xxCount: number;
  localLlmRetryBackoffMs: number;
  localLlm400TripThreshold: number;
  localLlm400CooldownMs: number;
  // Local LLM fast tier (v9.1) — smaller model for quick ops
  localLlmFastEnabled: boolean;
  localLlmFastModel: string;
  localLlmFastUrl: string;
  localLlmFastTimeoutMs: number;
  /**
   * Suppress chain-of-thought / thinking mode on the main local LLM
   * (issue #548).  When true, Remnic injects
   * `chat_template_kwargs: { enable_thinking: false }` on every
   * request so thinking-capable models (Qwen 3.5, Gemma 4, DeepSeek,
   * etc.) skip reasoning tokens that structured-output tasks like
   * extraction and consolidation cannot benefit from.  Default: true
   * — the dominant localLlm use case is JSON-shaped extraction where
   * thinking is pure latency tax and a common cause of 60s timeouts.
   * Set to false to restore thinking for narrative tasks.
   *
   * The fast-tier client (`fastLlm`) always disables thinking; that
   * contract is baked into "fast tier" and is unaffected by this flag.
   */
  localLlmDisableThinking: boolean;
  // Gateway config for fallback AI
  gatewayConfig?: GatewayConfig;
  /**
   * Optional host-supplied resolver for provider API keys. Core never discovers
   * host runtimes directly; adapters inject their native secret resolver here.
   */
  providerApiKeyResolver?: (params: {
    provider: string;
    cfg?: unknown;
    agentDir?: string;
  }) => Promise<{ apiKey?: string; source?: string; mode?: string } | null>;
  /**
   * Optional host-supplied resolver for request-ready model auth, including
   * provider transforms such as OAuth token exchange or base URL overrides.
   */
  runtimeAuthForModelResolver?: (params: {
    model: { provider: string; id: string; api?: string; baseUrl?: string };
    cfg?: unknown;
    workspaceDir?: string;
  }) => Promise<{
    apiKey?: string;
    baseUrl?: string;
    source?: string;
    mode?: string;
    profileId?: string;
  } | null>;
  // Gateway model source (v9.2) — route LLM calls through gateway agent model chain
  modelSource: "plugin" | "gateway";
  gatewayAgentId: string;
  fastGatewayAgentId: string;

  // v3.0 Multi-agent memory (namespaces)
  namespacesEnabled: boolean;
  defaultNamespace: string;
  sharedNamespace: string;
  principalFromSessionKeyMode: PrincipalFromSessionKeyMode;
  principalFromSessionKeyRules: PrincipalRule[];
  namespacePolicies: NamespacePolicy[];
  defaultRecallNamespaces: Array<"self" | "shared">;
  cronRecallMode: CronRecallMode;
  cronRecallAllowlist: string[];
  cronRecallPolicyEnabled: boolean;
  cronRecallNormalizedQueryMaxChars: number;
  cronRecallInstructionHeavyTokenCap: number;
  cronConversationRecallMode: CronConversationRecallMode;
  autoPromoteToSharedEnabled: boolean;
  autoPromoteToSharedCategories: Array<"fact" | "correction" | "decision" | "preference">;
  autoPromoteMinConfidenceTier: ConfidenceTier;
  routingRulesEnabled: boolean;
  routingRulesStateFile: string;

  // v4.0 Shared-context (cross-agent shared intelligence)
  sharedContextEnabled: boolean;
  sharedContextDir?: string;
  sharedContextMaxInjectChars: number;
  crossSignalsSemanticEnabled: boolean;
  crossSignalsSemanticTimeoutMs: number;
  sharedCrossSignalSemanticEnabled?: boolean;
  sharedCrossSignalSemanticTimeoutMs?: number;
  sharedCrossSignalSemanticMaxCandidates?: number;

  // v5.0 Compounding engine
  compoundingEnabled: boolean;
  compoundingWeeklyCronEnabled: boolean;
  compoundingSemanticEnabled: boolean;
  compoundingSynthesisTimeoutMs: number;
  compoundingInjectEnabled: boolean;

  // IRC (Inductive Rule Consolidation) — preference synthesis
  ircEnabled: boolean;
  ircMaxPreferences: number;
  ircIncludeCorrections: boolean;
  ircMinConfidence: number;

  // CMC (Causal Memory Consolidation) — cross-session causal reasoning
  cmcEnabled: boolean;
  cmcStitchLookbackDays: number;
  cmcStitchMinScore: number;
  cmcStitchMaxEdgesPerTrajectory: number;
  cmcConsolidationEnabled: boolean;
  cmcConsolidationMinRecurrence: number;
  cmcConsolidationMinSessions: number;
  cmcConsolidationSuccessThreshold: number;
  cmcRetrievalEnabled: boolean;
  cmcRetrievalMaxDepth: number;
  cmcRetrievalMaxChars: number;
  cmcRetrievalCounterfactualBoost: number;
  cmcBehaviorLearningEnabled: boolean;
  cmcBehaviorMinFrequency: number;
  cmcBehaviorMinSessions: number;
  cmcBehaviorConfidenceThreshold: number;
  cmcLifecycleCausalImpactWeight: number;

  // PEDC (Prediction-Error-Driven Calibration) — model-user alignment
  calibrationEnabled: boolean;
  calibrationMaxRulesPerRecall: number;
  calibrationMaxChars: number;

  // Search backend abstraction
  searchBackend?: "qmd" | "remote" | "noop" | "lancedb" | "meilisearch" | "orama";
  remoteSearchBaseUrl?: string;
  remoteSearchApiKey?: string;
  remoteSearchTimeoutMs?: number;

  // LanceDB backend
  lancedbEnabled: boolean;
  lanceDbPath?: string;
  lanceEmbeddingDimension?: number;

  // Meilisearch backend
  meilisearchEnabled: boolean;
  meilisearchHost?: string;
  meilisearchApiKey?: string;
  meilisearchTimeoutMs?: number;
  meilisearchAutoIndex?: boolean;

  // Orama backend
  oramaEnabled: boolean;
  oramaDbPath?: string;
  oramaEmbeddingDimension?: number;

  // QMD daemon mode
  qmdDaemonEnabled: boolean;
  qmdDaemonUrl: string;
  qmdDaemonRecheckIntervalMs: number;
  qmdIntentHintsEnabled: boolean;
  qmdExplainEnabled: boolean;

  // v7.0 Knowledge Graph Enhancement
  knowledgeIndexEnabled: boolean;
  knowledgeIndexMaxEntities: number;
  knowledgeIndexMaxChars: number;
  entityRetrievalEnabled: boolean;
  entityRetrievalMaxChars: number;
  entityRetrievalMaxHints: number;
  entityRetrievalMaxSupportingFacts: number;
  entityRetrievalMaxRelatedEntities: number;
  entityRetrievalRecentTurns: number;
  entitySchemas?: Record<string, EntitySchemaDefinition>;
  // Recall assembly controls
  recallBudgetChars: number;
  recallOuterTimeoutMs: number;
  recallCoreDeadlineMs: number;
  recallEnrichmentDeadlineMs: number;
  recallPipeline: RecallSectionConfig[];
  /** Apply Maximal Marginal Relevance to the final recall selection per-section. */
  recallMmrEnabled: boolean;
  /** MMR λ parameter. 1.0 = pure relevance, 0.0 = pure diversity. Default 0.7. */
  recallMmrLambda: number;
  /** MMR is applied over the top N candidates per section. Default 40. */
  recallMmrTopN: number;
  /**
   * Boost stored `reasoning_trace` memories in recall results when the
   * incoming query reads like a problem-solving ask (e.g. "how do I…",
   * "step by step", "walk me through…"). Default false — opt in after
   * benchmarking (issue #564 PR 3).
   */
  recallReasoningTraceBoostEnabled: boolean;
  qmdRecallCacheTtlMs: number;
  qmdRecallCacheStaleTtlMs: number;
  qmdRecallCacheMaxEntries: number;
  entityRelationshipsEnabled: boolean;
  entityActivityLogEnabled: boolean;
  entityActivityLogMaxEntries: number;
  entityAliasesEnabled: boolean;
  entitySummaryEnabled: boolean;
  entitySynthesisMaxTokens: number;

  // v6.0 Fact deduplication & archival
  /** Enable content-hash deduplication to prevent storing semantically identical facts. */
  factDeduplicationEnabled: boolean;
  /**
   * Issue #373 — Write-time semantic similarity guard. When enabled (default),
   * the orchestrator embeds each candidate fact and queries the existing
   * embedding index for its top-K nearest neighbors. If the best cosine
   * similarity is at or above `semanticDedupThreshold`, the fact is dropped
   * as a near-duplicate. Fails open (keeps the fact) if the embedding backend
   * is unavailable.
   */
  semanticDedupEnabled: boolean;
  /** Cosine similarity threshold in [0, 1] above which a candidate fact is skipped. */
  semanticDedupThreshold: number;
  /** Number of nearest-neighbor candidates to consider during semantic dedup. */
  semanticDedupCandidates: number;
  /** Enable automatic archival of old, low-importance, rarely-accessed facts. */
  factArchivalEnabled: boolean;
  /** Minimum age in days before a fact is eligible for archival. */
  factArchivalAgeDays: number;
  /** Maximum importance score for archival eligibility (0-1). Only facts below this are archived. */
  factArchivalMaxImportance: number;
  /** Maximum access count for archival eligibility. Only rarely-accessed facts are archived. */
  factArchivalMaxAccessCount: number;
  /** Tags that protect a fact from archival regardless of other criteria. */
  factArchivalProtectedCategories: string[];
  // v8.3 Lifecycle policy engine
  lifecyclePolicyEnabled: boolean;
  lifecycleFilterStaleEnabled: boolean;
  lifecyclePromoteHeatThreshold: number;
  lifecycleStaleDecayThreshold: number;
  lifecycleArchiveDecayThreshold: number;
  lifecycleProtectedCategories: MemoryCategory[];
  lifecycleMetricsEnabled: boolean;
  // v8.3 proactive + policy learning
  proactiveExtractionEnabled: boolean;
  contextCompressionActionsEnabled: boolean;
  compressionGuidelineLearningEnabled: boolean;
  compressionGuidelineSemanticRefinementEnabled: boolean;
  compressionGuidelineSemanticTimeoutMs: number;
  maxProactiveQuestionsPerExtraction: number;
  proactiveExtractionTimeoutMs: number;
  proactiveExtractionMaxTokens: number;
  extractionMaxOutputTokens: number;
  proactiveExtractionCategoryAllowlist?: MemoryCategory[];
  maxCompressionTokensPerHour: number;
  behaviorLoopAutoTuneEnabled: boolean;
  behaviorLoopLearningWindowDays: number;
  behaviorLoopMinSignalCount: number;
  behaviorLoopMaxDeltaPerCycle: number;
  behaviorLoopProtectedParams: string[];
  // v8.0 Phase 1: recall planner + intent routing + verbatim artifacts
  recallPlannerEnabled: boolean;
  recallPlannerModel: string;
  recallPlannerTimeoutMs: number;
  recallPlannerUseResponsesApi: boolean;
  recallPlannerMaxPromptChars: number;
  recallPlannerMaxMemoryHints: number;
  recallPlannerShadowMode: boolean;
  recallPlannerTelemetryEnabled: boolean;
  recallPlannerMaxQmdResultsMinimal: number;
  recallPlannerMaxQmdResultsFull: number;
  intentRoutingEnabled: boolean;
  intentRoutingBoost: number;
  verbatimArtifactsEnabled: boolean;
  verbatimArtifactsMinConfidence: number;
  verbatimArtifactsMaxRecall: number;
  verbatimArtifactCategories: MemoryCategory[];
  // v8.0 Phase 2A: Memory Boxes + Trace Weaving
  memoryBoxesEnabled: boolean;
  /** Jaccard overlap threshold below which a topic shift triggers box sealing (0-1, default 0.35) */
  boxTopicShiftThreshold: number;
  /** Time gap in ms before an open box is sealed (default 30 min) */
  boxTimeGapMs: number;
  /** Max memories per box before forced seal */
  boxMaxMemories: number;
  traceWeaverEnabled: boolean;
  /** Days back to search for trace links */
  traceWeaverLookbackDays: number;
  /** Minimum Jaccard overlap to assign the same traceId (0-1, default 0.4) */
  traceWeaverOverlapThreshold: number;
  /** Number of recent days of boxes to inject during recall */
  boxRecallDays: number;
  // v8.0 Phase 2B: Episode/Note dual store (HiMem)
  /** Classify extracted memories as episode or note and tag with memoryKind */
  episodeNoteModeEnabled: boolean;
  // v8.1 Temporal + Tag Indexes (SwiftMem-inspired)
  /** Build and maintain temporal (state/index_time.json) and tag (state/index_tags.json) indexes */
  queryAwareIndexingEnabled: boolean;
  /** Max candidate paths returned from index prefilter (0 = no cap) */
  queryAwareIndexingMaxCandidates: number;
  temporalIndexWindowDays: number;
  temporalIndexMaxEntries: number;
  temporalBoostRecentDays: number;
  temporalBoostScore: number;
  temporalDecayEnabled: boolean;
  tagMemoryEnabled: boolean;
  tagMaxPerMemory: number;
  tagIndexMaxEntries: number;
  tagRecallBoost: number;
  tagRecallMaxMatches: number;
  // v8.2 multi-graph memory (PR 18)
  multiGraphMemoryEnabled: boolean;
  // v8.2 PR 19A: graph recall planner gating
  graphRecallEnabled: boolean;
  graphRecallMaxExpansions: number;
  graphRecallMaxPerSeed: number;
  graphRecallMinEdgeWeight: number;
  graphRecallShadowEnabled: boolean;
  graphRecallSnapshotEnabled: boolean;
  graphRecallShadowSampleRate: number;
  graphRecallExplainToolEnabled: boolean;
  graphRecallStoreColdMirror: boolean;
  graphRecallColdMirrorCollection?: string;
  graphRecallColdMirrorMinAgeDays: number;
  graphRecallUseEntityPriors: boolean;
  graphRecallEntityPriorBoost: number;
  graphRecallPreferHubSeeds: boolean;
  graphRecallHubBias: number;
  graphRecallRecencyHalfLifeDays: number;
  graphRecallDampingFactor: number;
  graphRecallMaxSeedNodes: number;
  graphRecallMaxExpandedNodes: number;
  graphRecallMaxTrailPerNode: number;
  graphRecallMinSeedScore: number;
  graphRecallExpansionScoreThreshold: number;
  graphRecallExplainMaxPaths: number;
  graphRecallExplainMaxChars: number;
  graphRecallExplainEdgeLimit: number;
  graphRecallExplainEnabled: boolean;
  graphRecallEntityHintsEnabled: boolean;
  graphRecallEntityHintMax: number;
  graphRecallEntityHintMaxChars: number;
  graphRecallSnapshotDir: string;
  graphRecallEnableTrace: boolean;
  graphRecallEnableDebug: boolean;
  /** Allow graph_mode escalation for broader causal/timeline phrasing beyond strict keywords. */
  graphExpandedIntentEnabled?: boolean;
  /** Run bounded graph expansion in full mode when enough recall seeds exist. */
  graphAssistInFullModeEnabled?: boolean;
  /** In full mode, compute graph assist for telemetry/snapshotting but do not inject merged results. */
  graphAssistShadowEvalEnabled?: boolean;
  /** Minimum seed results required before full-mode graph assist runs. */
  graphAssistMinSeedResults?: number;
  entityGraphEnabled: boolean;
  timeGraphEnabled: boolean;
  /** When true, write fallback temporal adjacency edges for consecutive extracted memories. */
  graphWriteSessionAdjacencyEnabled?: boolean;
  causalGraphEnabled: boolean;
  maxGraphTraversalSteps: number;
  graphActivationDecay: number;
  /** Weight of graph activation score when blending with seed QMD score (0-1). */
  graphExpansionActivationWeight: number;
  /** Lower bound for blended graph-expanded recall scores (0-1). */
  graphExpansionBlendMin: number;
  /** Upper bound for blended graph-expanded recall scores (0-1). */
  graphExpansionBlendMax: number;
  maxEntityGraphEdgesPerMemory: number;
  /** SimpleMem-inspired de-linearization: resolve pronouns and anchor relative dates after extraction. */
  delinearizeEnabled: boolean;
  /** Synapse-inspired confidence gate — skip memory injection when top score is below threshold. */
  recallConfidenceGateEnabled: boolean;
  recallConfidenceGateThreshold: number;
  /** PlugMem-inspired causal rule extraction: mine IF→THEN rules during consolidation. */
  causalRuleExtractionEnabled: boolean;
  /** E-Mem-inspired memory reconstruction: targeted retrieval for missing entity context. */
  memoryReconstructionEnabled: boolean;
  /** Maximum number of entity expansions per recall. */
  memoryReconstructionMaxExpansions: number;
  /** Synapse-inspired lateral inhibition to suppress hub-node dominance. */
  graphLateralInhibitionEnabled: boolean;
  /** Inhibition strength (default 0.15). Higher = more suppression. */
  graphLateralInhibitionBeta: number;
  /** Number of top competing nodes considered for inhibition (default 7). */
  graphLateralInhibitionTopM: number;

  // Issue #681 PR 2/3 — graph-edge confidence decay maintenance.
  /** Enable the periodic graph-edge confidence decay job. Default false (opt-in). */
  graphEdgeDecayEnabled: boolean;
  /** Cadence in milliseconds at which the cron triggers the decay job. Default 7d. */
  graphEdgeDecayCadenceMs: number;
  /** Decay window passed through to `decayEdgeConfidence`. Default 90 days. */
  graphEdgeDecayWindowMs: number;
  /** Per-window confidence drop. Default 0.1. */
  graphEdgeDecayPerWindow: number;
  /** Floor confidence will not decay below. Default 0.1. */
  graphEdgeDecayFloor: number;
  /** Confidence threshold for the "below visibility" telemetry counter. Default 0.2. */
  graphEdgeDecayVisibilityThreshold: number;

  /**
   * Issue #681 PR 3/3 — minimum edge confidence required for an edge to be
   * traversed during spreading activation. Edges with `confidence` below this
   * floor are pruned and contribute neither activation nor downstream
   * neighbors. Legacy edges without `confidence` are treated as 1.0 so they
   * always pass the floor. Range `[0, 1]`; default `0.2`.
   */
  graphTraversalConfidenceFloor: number;
  /**
   * Issue #681 PR 3/3 — number of PageRank-style refinement iterations applied
   * on top of the BFS spreading-activation scores. Each iteration redistributes
   * a node's confidence-weighted activation along its outgoing edges. Set to 0
   * to disable refinement and use raw BFS scores. Default `8`.
   */
  graphTraversalPageRankIterations: number;
  // v8.2: Temporal Memory Tree
  temporalMemoryTreeEnabled: boolean;
  tmtHourlyMinMemories: number;
  tmtSummaryMaxTokens: number;
  // Explicit cue recall
  /** Front-load exact stored evidence for query-visible cues like turns, dates, ids, files, and tools. */
  explicitCueRecallEnabled: boolean;
  /** Character budget for the explicit cue evidence section. */
  explicitCueRecallMaxChars: number;
  /** Maximum query-visible cues expanded per recall. */
  explicitCueRecallMaxReferences: number;
  /** Enable targeted fact evidence recall for direct answer questions. */
  targetedFactRecallEnabled: boolean;
  /** Character budget for the targeted fact evidence section. */
  targetedFactRecallMaxChars: number;
  /** Maximum recalled items for targeted fact evidence. */
  targetedFactRecallMaxResults: number;
  /** Recent-turn scan window for targeted fact evidence. */
  targetedFactRecallScanWindowTurns: number;
  /** Recent-token scan window for targeted fact evidence. */
  targetedFactRecallScanWindowTokens: number;
  /** Enable focused list evidence recall for count, relation, and recommendation questions. */
  focusedListRecallEnabled: boolean;
  /** Character budget for the focused list evidence section. */
  focusedListRecallMaxChars: number;
  /** Maximum recalled items for focused list evidence. */
  focusedListRecallMaxResults: number;
  /** Recent-turn scan window for focused list evidence. */
  focusedListRecallScanWindowTurns: number;
  /** Recent-token scan window for focused list evidence. */
  focusedListRecallScanWindowTokens: number;
  /** Enable response guidance recall for user answer-shape preferences. */
  responseGuidanceRecallEnabled: boolean;
  /** Character budget for the response guidance recall section. */
  responseGuidanceRecallMaxChars: number;
  /** Maximum recalled items for response guidance. */
  responseGuidanceRecallMaxResults: number;
  /** Recent-turn scan window for response guidance. */
  responseGuidanceRecallScanWindowTurns: number;
  /** Recent-token scan window for response guidance. */
  responseGuidanceRecallScanWindowTokens: number;
  /** Enable event-order evidence recall for chronology questions. */
  eventOrderRecallEnabled: boolean;
  /** Character budget for the event-order evidence section. */
  eventOrderRecallMaxChars: number;
  /** Maximum recalled items for event-order evidence. */
  eventOrderRecallMaxResults: number;
  /** Recent-turn scan window for event-order evidence. */
  eventOrderRecallScanWindowTurns: number;
  /** Recent-token scan window for event-order evidence. */
  eventOrderRecallScanWindowTokens: number;
  // Lossless Context Management (LCM)
  lcmEnabled: boolean;
  lcmLeafBatchSize: number;
  lcmRollupFanIn: number;
  lcmFreshTailTurns: number;
  lcmMaxDepth: number;
  lcmRecallBudgetShare: number;
  lcmDeterministicMaxTokens: number;
  lcmArchiveRetentionDays: number;
  /** Max independent LCM observe jobs to process concurrently. Default 1. */
  lcmObserveConcurrency: number;
  /** Opt-in structured message-part capture/recall sidecar for LCM. Default false. */
  messagePartsEnabled: boolean;
  /** Max structured file/tool matches injected into recall. */
  messagePartsRecallMaxResults: number;

  // v9.1 Parallel Specialized Retrieval (ASMR-inspired)
  /** Enable three-agent parallel retrieval (DirectFact + Contextual + Temporal). Default false. */
  parallelRetrievalEnabled: boolean;
  /** Per-agent source weights for score blending during merge. */
  parallelAgentWeights: { direct: number; contextual: number; temporal: number };
  /** Max results fetched per agent before merge. */
  parallelMaxResultsPerAgent: number;

  // Daily Context Briefing (Issue #370)
  /** Briefing configuration knobs — see BriefingConfig for field docs. */
  briefing: BriefingConfig;

  // Codex CLI connector settings (install-time)
  codex: CodexConnectorConfig;

  // Live connectors (issue #683). Concrete implementations live under
  // packages/remnic-core/src/connectors/live/. Each child block maps to one
  // connector. All defaults are off — operators opt in.
  connectors: LiveConnectorsConfig;

  // MECE Taxonomy (#366)
  /** Enable the MECE taxonomy knowledge directory. Default false. */
  taxonomyEnabled: boolean;
  /** Auto-regenerate RESOLVER.md when taxonomy changes. Default true. */
  taxonomyAutoGenResolver: boolean;

  // Codex CLI — native memory materialization (#378)
  /** Materialize Remnic memories into Codex's expected ~/.codex/memories/ layout. Default true. */
  codexMaterializeMemories: boolean;
  /** Namespace to materialize; "auto" derives from the connector context. Default "auto". */
  codexMaterializeNamespace: string;
  /** Max whitespace-tokenized size of memory_summary.md. Default 4500. */
  codexMaterializeMaxSummaryTokens: number;
  /** Max age in days for rollout_summaries/*.md before pruning. Default 30. */
  codexMaterializeRolloutRetentionDays: number;
  /** Run materialization after semantic/causal consolidation completes. Default true. */
  codexMaterializeOnConsolidation: boolean;
  /** Run materialization at Codex session-end hook. Default true. */
  codexMaterializeOnSessionEnd: boolean;
  /** Enable Codex marketplace integration. Default true. */
  codexMarketplaceEnabled: boolean;

  // Page-level versioning (issue #371)
  /** Enable page-level versioning with sidecar snapshots. Default false. */
  versioningEnabled: boolean;
  /** Maximum number of version snapshots to keep per page. Default 50. Set to 0 to disable pruning. */
  versioningMaxPerPage: number;
  /** Name of the sidecar directory inside memoryDir. Default ".versions". */
  versioningSidecarDir: string;

  // Binary file lifecycle management (#367)
  /** Enable binary file lifecycle management (mirror, redirect, clean). Default: false. */
  binaryLifecycleEnabled: boolean;
  /** Grace period in days before a mirrored binary is eligible for local cleanup. Default: 7. */
  binaryLifecycleGracePeriodDays: number;
  /** Storage backend type: "filesystem" copies to a local dir, "none" is no-op. Default: "none". */
  binaryLifecycleBackendType: "filesystem" | "s3" | "none";
  /** Base path for the filesystem backend. Required when backendType is "filesystem". */
  binaryLifecycleBackendPath: string;

  // Codex citation parity (issue #379)
  /** Enable oai-mem-citation blocks in recall responses. Default false. */
  citationsEnabled: boolean;
  /** Auto-enable citations when the Codex adapter is detected. Default true. */
  citationsAutoDetect: boolean;

  // External enrichment pipeline (issue #365)
  /** Enable the external enrichment pipeline. Default false. */
  enrichmentEnabled: boolean;
  /** Automatically enrich new entities on creation. Default false. */
  enrichmentAutoOnCreate: boolean;
  /** Max candidates accepted per entity per enrichment run. Default 20. */
  enrichmentMaxCandidatesPerEntity: number;

  // Memory extensions discovery (#382)
  /** Whether third-party memory extensions are discovered and injected into consolidation. Default true. */
  memoryExtensionsEnabled: boolean;
  /**
   * Root directory for memory extensions. Empty string means derive from
   * memoryDir: go up to the Remnic home dir and append memory_extensions.
   */
  memoryExtensionsRoot: string;
}

/** Runtime configuration for the daily context briefing feature. */
export interface BriefingConfig {
  /** Whether `remnic briefing` CLI and MCP tool are enabled. */
  enabled: boolean;
  /** Default lookback window token (e.g. "yesterday", "3d", "1w", "24h"). */
  defaultWindow: string;
  /** Default output format for the CLI. */
  defaultFormat: "markdown" | "json";
  /** Maximum number of LLM-generated suggested follow-ups. */
  maxFollowups: number;
  /** Optional path to an ICS or JSON calendar file. null disables the section. */
  calendarSource: string | null;
  /** If true, CLI writes a dated briefing file by default. */
  saveByDefault: boolean;
  /** Override directory for saved briefings. null → $REMNIC_HOME/briefings/. */
  saveDir: string | null;
  /** Whether to call the Responses API for follow-up suggestions. */
  llmFollowups: boolean;
}

/** Parsed representation of a briefing lookback window. */
export type BriefingWindow = "yesterday" | "today" | string;

/** Filter the briefing to a single entity / project / topic. */
export interface BriefingFocus {
  type: "person" | "project" | "topic";
  value: string;
}

/** Calendar event surfaced by a CalendarSource implementation. */
export interface CalendarEvent {
  /** Stable identifier for dedupe / linking. */
  id: string;
  /** Event title (short). */
  title: string;
  /** ISO 8601 start timestamp. */
  start: string;
  /** Optional ISO 8601 end timestamp. */
  end?: string;
  /** Optional freeform location. */
  location?: string;
  /** Optional short notes. */
  notes?: string;
}

/** Abstraction over any calendar backend. Concrete implementations: `FileCalendarSource`. */
export interface CalendarSource {
  /** Return events that fall on the given UTC date (YYYY-MM-DD). */
  eventsForDate(dateIso: string): Promise<CalendarEvent[]>;
}

/** A single "active thread" surfaced in a briefing. */
export interface BriefingActiveThread {
  id: string;
  title: string;
  updatedAt: string;
  reason: string;
}

/** A single "recent entity" entry. */
export interface BriefingRecentEntity {
  name: string;
  type: string;
  updatedAt: string;
  score: number;
  summary?: string;
}

/** A single unresolved commitment or open question. */
export interface BriefingOpenCommitment {
  id: string;
  kind: "question" | "commitment" | "pending_memory";
  text: string;
  source?: string;
  createdAt?: string;
}

/** An LLM-generated short follow-up suggestion. */
export interface BriefingFollowup {
  text: string;
  rationale?: string;
}

/** Structured sections of a briefing result. */
export interface BriefingSections {
  activeThreads: BriefingActiveThread[];
  recentEntities: BriefingRecentEntity[];
  openCommitments: BriefingOpenCommitment[];
  suggestedFollowups: BriefingFollowup[];
  /** Only populated when a calendar source is configured and returns events. */
  todayCalendar?: CalendarEvent[];
}

/** A calendar source failure recorded when a CalendarSource throws during briefing generation. */
export interface BriefingCalendarSourceError {
  /** Human-readable description of the source (e.g. file path or source name). */
  source: string;
  /** Stringified error message from the failed source. */
  error: string;
}

/** Result returned by `buildBriefing`. */
export interface BriefingResult {
  markdown: string;
  json: Record<string, unknown>;
  sections: BriefingSections;
  /** Reason why suggested follow-ups were omitted (e.g. missing API key, LLM error). */
  followupsUnavailableReason?: string;
  /** Effective lookback window (ISO date range) used for this briefing. */
  window: { from: string; to: string };
  /**
   * Calendar sources that failed during this briefing run.
   * Only present (non-empty) when at least one source threw.
   * Allows callers to distinguish "no events today" from "source unavailable".
   */
  calendarSourceErrors?: BriefingCalendarSourceError[];
}

/**
 * Settings for the Codex CLI connector. These are consumed by
 * `remnic connectors install codex-cli` to decide where the phase-2 memory
 * extension is dropped and whether to install it at all.
 */
export interface CodexConnectorConfig {
  /**
   * Whether to install the Remnic memory extension into
   * `<codex_home>/memories_extensions/remnic/` when the `codex-cli`
   * connector is installed. Default `true`. Set to `false` for users who
   * self-manage the Codex memory extensions folder.
   */
  installExtension: boolean;
  /**
   * Optional override for the Codex home directory. When `null`, the
   * connector reads `$CODEX_HOME` and falls back to `~/.codex`. Setting
   * this is useful for integration tests and non-default installs.
   */
  codexHome: string | null;
}

/**
 * Container for live-connector config blocks (issue #683 PR 2/N).
 *
 * Lives at `connectors.*` rather than the top level so future connectors
 * (Notion, Gmail, GitHub) can slot in without bloating `PluginConfig`.
 *
 * Every child block must default to `enabled: false` per CLAUDE.md gotcha
 * #30 (escape hatch by default) and gotcha #48 (least-privileged enum
 * defaults). Concrete connectors are also expected to short-circuit at
 * registration time when their credentials are not populated.
 */
export interface LiveConnectorsConfig {
  /** Google Drive live connector (issue #683 PR 2/N). */
  googleDrive: GoogleDriveLiveConnectorConfig;
  /** Notion live connector (issue #683 PR 3/N). */
  notion: NotionLiveConnectorConfig;
  /** Gmail live connector (issue #683 PR 4/6). */
  gmail: GmailLiveConnectorConfig;
  /** GitHub live connector (issue #683 PR 5/6). */
  github: GitHubLiveConnectorConfig;
}

/**
 * Operator-facing config for the Google Drive live connector. The connector
 * module itself defines a separate, *validated* `GoogleDriveConnectorConfig`
 * shape (frozen, post-validation). This interface is the pre-validation
 * shape that `parseConfig` round-trips through.
 *
 * `clientId` / `clientSecret` / `refreshToken` are stored as strings here so
 * the schema can ship in `openclaw.plugin.json` and operators can populate
 * them from a secret store (e.g. an env-substituted plist or systemd
 * EnvironmentFile). They MUST NEVER be committed to source. The repo-wide
 * privacy policy in CLAUDE.md applies.
 */
export interface GoogleDriveLiveConnectorConfig {
  /** Master gate. Default false — operators must opt in explicitly. */
  enabled: boolean;
  /** OAuth2 client id. Populate from a secret store; never commit. */
  clientId: string;
  /** OAuth2 client secret. Populate from a secret store; never commit. */
  clientSecret: string;
  /** OAuth2 refresh token. Populate from a secret store; never commit. */
  refreshToken: string;
  /** Poll interval in ms. Default 300000 (5 min); min 1000; max 86400000 (24h). */
  pollIntervalMs: number;
  /** Optional folder-id scope. Empty array = all accessible files. */
  folderIds: string[];
}

/**
 * Operator-facing config for the Notion live connector (issue #683 PR 3/N).
 * The connector module defines a separate validated `NotionConnectorConfig`
 * shape (frozen, post-validation). This interface is the pre-validation shape
 * that `parseConfig` round-trips through.
 *
 * `token` is stored as a string here so operators can populate it from a
 * secret store (e.g. an env-substituted plist or systemd EnvironmentFile).
 * It MUST NEVER be committed to source. The repo-wide privacy policy in
 * CLAUDE.md applies.
 */
export interface NotionLiveConnectorConfig {
  /** Master gate. Default false — operators must opt in explicitly. */
  enabled: boolean;
  /** Notion integration token. Starts with `secret_`. Populate from a secret store; never commit. */
  token: string;
  /** Array of Notion database ids to import pages from. Empty = connector is a no-op. */
  databaseIds: string[];
  /** Poll interval in ms. Default 300000 (5 min); min 1000; max 86400000 (24h). */
  pollIntervalMs: number;
}

/**
 * Operator-facing config for the Gmail live connector (issue #683 PR 4/6).
 * The connector module defines a separate validated `GmailConnectorConfig`
 * shape (frozen, post-validation). This interface is the pre-validation shape
 * that `parseConfig` round-trips through.
 *
 * OAuth2 credentials are stored as strings here so operators can populate
 * them from a secret store (e.g. env-substituted plist or systemd
 * EnvironmentFile). They MUST NEVER be committed to source. The repo-wide
 * privacy policy in CLAUDE.md applies.
 */
export interface GmailLiveConnectorConfig {
  /** Master gate. Default false — operators must opt in explicitly. */
  enabled: boolean;
  /** OAuth2 client id. Populate from a secret store; never commit. */
  clientId: string;
  /** OAuth2 client secret. Populate from a secret store; never commit. */
  clientSecret: string;
  /** OAuth2 refresh token issued for the Gmail scope. Populate from a secret store; never commit. */
  refreshToken: string;
  /** Gmail userId. Defaults to "me" (the authenticated user). */
  userId: string;
  /** Gmail search query applied in addition to the watermark filter. Default "in:inbox". */
  query: string;
  /** Poll interval in ms. Default 300000 (5 min); min 1000; max 86400000 (24h). */
  pollIntervalMs: number;
}

/**
 * Operator-facing config for the GitHub live connector (issue #683 PR 5/6).
 * The connector module defines a separate validated `GitHubConnectorConfig`
 * shape (frozen, post-validation). This interface is the pre-validation shape
 * that `parseConfig` round-trips through.
 *
 * `token` is stored as a string here so operators can populate it from a
 * secret store (e.g. an env-substituted plist or systemd EnvironmentFile).
 * It MUST NEVER be committed to source. The repo-wide privacy policy in
 * CLAUDE.md applies.
 */
export interface GitHubLiveConnectorConfig {
  /** Master gate. Default false — operators must opt in explicitly. */
  enabled: boolean;
  /** GitHub personal access token. Populate from a secret store; never commit. */
  token: string;
  /** GitHub login of the user whose comments will be imported. Required. */
  userLogin: string;
  /** Repos to poll in "owner/repo" format. Empty = connector is a no-op. */
  repos: string[];
  /** Poll interval in ms. Default 300000 (5 min); min 1000; max 86400000 (24h). */
  pollIntervalMs: number;
  /** Whether to fetch Discussion comments in addition to issue/PR comments. Default false. */
  includeDiscussions: boolean;
}

export interface BootstrapOptions {
  dryRun?: boolean;
  sessionsDir?: string;
  limit?: number;
  since?: Date;
}

export interface BootstrapResult {
  sessionsScanned: number;
  turnsProcessed: number;
  highSignalTurns: number;
  memoriesCreated: number;
  skipped: number;
}

export interface PrincipalRule {
  match: string;
  principal: string;
}

export interface NamespacePolicy {
  name: string;
  readPrincipals: string[];
  writePrincipals: string[];
  includeInRecallByDefault?: boolean;
}

export interface RelevanceFeedback {
  up: number;
  down: number;
  lastUpdatedAt: string;
  notes?: string[];
}

export interface BufferTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sourceValidAt?: string;
  sessionKey?: string;
  logicalSessionKey?: string;
  providerThreadId?: string | null;
  turnFingerprint?: string;
  persistProcessedFingerprint?: boolean;
  extractionContextOnly?: boolean;
  parts?: import("./message-parts/index.js").LcmMessagePartInput[];
  rawContent?: unknown;
  sourceFormat?: import("./message-parts/index.js").MessagePartSourceFormat;
  importProvenance?: import("./bulk-import/types.js").ImportTurnProvenance;
}

export interface BufferEntryState {
  turns: BufferTurn[];
  lastExtractionAt: string | null;
  extractionCount: number;
  /**
   * Turns retained across `clearAfterExtraction` so a later extraction pass
   * sees the context that caused a defer verdict (issue #562, PR 2). Bounded
   * to the configured retention cap by `retainDeferredTurns`. Empty / absent
   * means no retention in effect.
   */
  retainedTurns?: BufferTurn[];
}

export interface BufferState {
  turns: BufferTurn[];
  lastExtractionAt: string | null;
  extractionCount: number;
  entries?: Record<string, BufferEntryState>;
}

export interface BehaviorLoopAdjustment {
  parameter: string;
  previousValue: number;
  nextValue: number;
  delta: number;
  evidenceCount: number;
  confidence: number;
  reason: string;
  appliedAt: string;
}

export interface BehaviorLoopPolicyState {
  version: number;
  windowDays: number;
  minSignalCount: number;
  maxDeltaPerCycle: number;
  protectedParams: string[];
  adjustments: BehaviorLoopAdjustment[];
  updatedAt: string;
}

export type BehaviorSignalType = "correction_override" | "preference_affinity" | "topic_revisitation" | "action_pattern" | "outcome_preference" | "phrasing_style";
export type BehaviorSignalDirection = "positive" | "negative";

export interface BehaviorSignalEvent {
  timestamp: string;
  namespace: string;
  memoryId: string;
  category: Extract<MemoryCategory, "correction" | "preference">;
  signalType: BehaviorSignalType;
  direction: BehaviorSignalDirection;
  confidence: number;
  signalHash: string;
  source: "extraction" | "correction";
}

/**
 * One row of the buffer-surprise telemetry ledger (issue #563 PR 3).
 *
 * Emitted by `SmartBuffer` each time the surprise probe produces a score
 * for an incoming turn (i.e. the feature flag is on and the existing
 * trigger-logic path called through to the probe). Not written when the
 * probe is skipped — the absence of a row is meaningful and matches the
 * "probe was not consulted" state.
 *
 * The ledger is intentionally lean: we record the score, the threshold in
 * force, whether the turn caused a flush, and the turn count so operators
 * can re-derive precision/recall without replaying traffic. Turn content
 * is never persisted — this ledger is safe to commit to shared storage.
 */
export interface BufferSurpriseEvent {
  /** Literal tag to simplify multiplexed log consumers. */
  event: "BUFFER_SURPRISE";
  /** ISO timestamp when the decision was made. Server-side, not turn ts. */
  timestamp: string;
  /** Buffer identifier (session / thread). Opaque string. */
  bufferKey: string;
  /** Session key if available; null when the turn has no session binding. */
  sessionKey: string | null;
  /** Role of the scored turn. */
  turnRole: "user" | "assistant";
  /** Surprise score in `[0, 1]`, already clamped. */
  surpriseScore: number;
  /** Threshold in force when the decision was made. */
  threshold: number;
  /** Whether this turn upgraded `keep_buffering` → `extract_now`. */
  triggeredFlush: boolean;
  /** Number of turns in the buffer (including the current turn). */
  turnCountInWindow: number;
}

/** Memory status for lifecycle management */
export type MemoryStatus =
  | "active"
  | "pending_review"
  | "rejected"
  | "quarantined"
  | "superseded"
  | "archived"
  /**
   * Operator explicitly forgot the memory (issue #686 PR 4/6).  Soft
   * delete: the file stays on disk and a page-version snapshot is kept
   * so the act is reversible during a configurable retention window
   * (default 90 days), but the memory is excluded from recall, browse,
   * and entity attribution.  After the retention window passes, a
   * future maintenance cron will hard-delete forgotten memories.
   */
  | "forgotten";
export type LifecycleState = "candidate" | "validated" | "active" | "stale" | "archived";
export type VerificationState = "unverified" | "user_confirmed" | "system_inferred" | "disputed";
export type PolicyClass = "ephemeral" | "durable" | "protected";

/** Importance level tiers */
export type ImportanceLevel = "critical" | "high" | "normal" | "low" | "trivial";

/** Importance scoring result */
export interface ImportanceScore {
  /** Numeric score 0-1 */
  score: number;
  /** Tier level */
  level: ImportanceLevel;
  /** Reasons for this score */
  reasons: string[];
  /** Salient keywords extracted */
  keywords: string[];
}

export interface MemoryFrontmatter {
  id: string;
  category: MemoryCategory;
  created: string;
  updated: string;
  source: string;
  confidence: number;
  confidenceTier: ConfidenceTier;
  tags: string[];
  entityRef?: string;
  supersedes?: string;
  /** ISO 8601 date — memory expires and gets cleaned up after this date */
  expiresAt?: string;
  /** IDs of parent memories this was derived from (lineage tracking) */
  lineage?: string[];
  /** Memory status: active (default), pending_review, rejected, quarantined, superseded, archived, or forgotten */
  status?: MemoryStatus;
  /** ID of memory that superseded this one */
  supersededBy?: string;
  /** Timestamp when superseded */
  supersededAt?: string;
  /** Timestamp when archived */
  archivedAt?: string;
  /**
   * Explicit fact validity start (issue #680). ISO 8601 timestamp.
   *
   * When present, marks the moment at which the fact begins being
   * "true" / authoritative.  When absent at read time, callers fall
   * back to `created` so legacy memories written before #680 still
   * participate in `as_of` recall filtering without a migration.
   */
  valid_at?: string;
  /**
   * Explicit fact validity end (issue #680). ISO 8601 timestamp.
   *
   * Set automatically by the temporal-supersession pipeline when a
   * newer fact supersedes this one — the value is the superseder's
   * `valid_at` (or `created` if no `valid_at` was set).  May also be
   * set manually for facts that are known to expire at a specific
   * point in time.
   */
  invalid_at?: string;
  /**
   * Timestamp when the operator explicitly forgot this memory
   * (issue #686 PR 4/6).  Set by `remnic forget <id>`.  Memories with
   * `status === "forgotten"` are excluded from recall, browse, and
   * entity attribution; the file remains on disk until the retention
   * window passes.
   */
  forgottenAt?: string;
  /** Optional human-readable reason captured by `remnic forget --reason`. */
  forgottenReason?: string;
  /** Policy-driven lifecycle state used for retrieval eligibility/ranking. */
  lifecycleState?: LifecycleState;
  /** Verification provenance used by lifecycle policy. */
  verificationState?: VerificationState;
  /** Policy class used by lifecycle guardrails. */
  policyClass?: PolicyClass;
  /** Last lifecycle validation timestamp (ISO 8601). */
  lastValidatedAt?: string;
  /** Lifecycle decay score in [0,1]. */
  decayScore?: number;
  /** Lifecycle heat score in [0,1]. */
  heatScore?: number;
  // Access tracking (Phase 1A)
  /** Number of times this memory has been retrieved */
  accessCount?: number;
  /** Last time this memory was accessed (ISO 8601) */
  lastAccessed?: string;
  // Memory Worth counters (issue #560)
  //
  // Per-fact outcome counters used to derive a dynamic utility score —
  // `p(success | retrieved)` — as a complement to the static `importance`
  // field. Absent on legacy memories written before #560; readers must treat
  // `undefined` as zero observations (uniform Beta(1,1) prior).
  //
  // Both values must be non-negative integers on write. PR 1 wires only the
  // schema + storage round-trip — no increments, scoring, or filtering yet.
  /** Number of sessions where this memory was retrieved and the outcome was judged a success. */
  mw_success?: number;
  /** Number of sessions where this memory was retrieved and the outcome was judged a failure. */
  mw_fail?: number;
  // Importance scoring (Phase 1B)
  /** Importance score with level, reasons, and keywords */
  importance?: ImportanceScore;
  // Chunking (Phase 2A)
  /** Parent memory ID if this is a chunk */
  parentId?: string;
  /** Chunk index within parent (0-based) */
  chunkIndex?: number;
  /** Total number of chunks for this parent */
  chunkTotal?: number;
  // Memory Linking (Phase 3A)
  /** Links to other memories */
  links?: MemoryLink[];
  // Intent-grounded memory routing (v8.0 phase 1)
  intentGoal?: string;
  intentActionType?: string;
  intentEntityTypes?: string[];
  // Verbatim artifact lineage (v8.0 phase 1)
  artifactType?: "decision" | "constraint" | "todo" | "definition" | "commitment" | "correction" | "fact";
  sourceMemoryId?: string;
  sourceTurnId?: string;
  // v8.0 Phase 2B: HiMem episode/note classification
  /** episode = time-specific event; note = stable belief/preference/decision */
  memoryKind?: "episode" | "note" | "box" | "dream" | "procedural";
  /** Structured key-value attributes extracted from the content (e.g., product attributes, dates, quantities). */
  structuredAttributes?: Record<string, string>;
  /**
   * SHA-256 (via ContentHashIndex.computeHash) of the raw content that was
   * used as the dedup key at write time. Persists through archive and
   * consolidation so the hash can be removed from the index even if the stored
   * content has been transformed (e.g. an inline citation was appended).
   *
   * When present, archive/consolidation paths use this directly instead of
   * calling stripCitation(memory.content), which only handles the default
   * [Source: ...] format and silently fails for custom citation templates.
   */
  contentHash?: string;
  /**
   * Consolidation provenance — pointers to the page-versioning snapshots
   * that this memory was derived from (issue #561).  Each entry is a
   * `"<memory-path>:<version-number>"` string (e.g.
   * `"facts/preferences.md:3"`) referencing a snapshot recorded by
   * `page-versioning.ts`.
   *
   * PR 1 introduces this field as read-through only — storage preserves
   * it verbatim but no code produces it yet.  PR 2 populates it on
   * consolidation writes; PR 4 adds a `remnic doctor` integrity check
   * that validates each referent actually exists.
   */
  derived_from?: string[];
  /**
   * Which consolidation operator produced this memory (issue #561,
   * extended in #687).  See `ConsolidationOperator` in
   * `semantic-consolidation.ts` for the operator algebra.  Absent on
   * memories that were not produced by a consolidation pass.
   *
   * `"pattern-reinforcement"` (issue #687 PR 2/4) tags memories that
   * were promoted to canonical by the pattern-reinforcement
   * maintenance job after observing the same content across
   * multiple sessions.
   */
  derived_via?: "split" | "merge" | "update" | "pattern-reinforcement";
  /**
   * Number of source memories that reinforced this canonical memory
   * (issue #687 PR 2/4).  Set by the pattern-reinforcement
   * maintenance job when it clusters duplicate memories and promotes
   * the most recent member to canonical.  Counts the cluster size at
   * the time of the run; subsequent runs update this monotonically.
   *
   * Always a positive integer when present.  Absent on memories that
   * have not been touched by pattern reinforcement.
   */
  reinforcement_count?: number;
  /**
   * ISO 8601 timestamp recording the most recent pattern-reinforcement
   * run that touched this memory (issue #687 PR 2/4).  Updated each
   * time the cluster size grows.  Absent when `reinforcement_count`
   * is absent.
   */
  last_reinforced_at?: string;
}

/** Memory link relationship types */
export type MemoryLinkType = "follows" | "references" | "contradicts" | "supports" | "related";

/** A link between memories */
export interface MemoryLink {
  targetId: string;
  linkType: MemoryLinkType;
  strength: number;
  reason?: string;
}

// Conversation Threading (Phase 3B)
export interface ConversationThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionKey?: string;
  episodeIds: string[];
  linkedThreadIds: string[];
}

// Memory Summarization (Phase 4A)
export interface MemorySummary {
  id: string;
  createdAt: string;
  timeRangeStart: string;
  timeRangeEnd: string;
  summaryText: string;
  keyFacts: string[];
  keyEntities: string[];
  sourceEpisodeIds: string[];
}

export interface DaySummaryResult {
  summary: string;
  bullets: string[];
  next_actions: string[];
  risks_or_open_loops: string[];
}

// Topic Extraction (Phase 4B)
export interface TopicScore {
  term: string;
  score: number;
  count: number;
}

export interface MemoryFile {
  path: string;
  frontmatter: MemoryFrontmatter;
  content: string;
}

/**
 * Public type representing the **Observation** stage in the
 * Trace → Observation → Primitive pipeline (issue #685).
 *
 * - **Trace**: raw conversation turns captured in `buffer.ts`. Noisy,
 *   verbose, ephemeral.
 * - **Observation** (this type): post-extraction, importance-scored
 *   fact candidate emitted by `extraction.ts` / `extraction-judge.ts`.
 *   Already distilled — but not yet consolidated against the corpus.
 * - **Primitive**: the durable `MemoryFile` written by `storage.ts`,
 *   reinforced over time by `compounding/engine.ts`.
 *
 * `MemoryObservation` is the named handle on the intermediate stage
 * the codebase has always produced but never publicly typed. It lets
 * callers (telemetry, doctor surfaces, tests, downstream tooling)
 * inspect the post-extraction shape without reaching into extraction
 * internals.
 *
 * Naming note: this is intentionally NOT the same as the existing
 * `state/observation-ledger/` directory, which is telemetry storage
 * for the extraction pipeline (turn-count aggregates rebuilt by
 * `maintenance/rebuild-observations.ts` and judge verdict events
 * appended by `extraction-judge-telemetry.ts`). Lifecycle events on
 * primitives — status flips, supersessions, archival, forget — live
 * in `state/memory-lifecycle-ledger.jsonl`, written by
 * `StorageManager`. A `MemoryObservation` describes the in-flight
 * candidate that became (or didn't become) a primitive; the ledger
 * directory is how the pipeline reports on itself. See
 * `docs/trace-to-primitive.md` for the full pipeline walkthrough.
 */
export interface MemoryObservation {
  /** Stable id for this observation, distinct from any primitive id. */
  id: string;
  /** Source session id the trace came from. */
  sessionId?: string;
  /** ISO timestamp the observation was emitted. */
  observedAt: string;
  /** The extracted fact candidate (category, content, confidence, tags, etc.). */
  fact: ExtractedFact;
  /** Importance score in [0,1], from `importance.ts`. */
  importance?: number;
  /**
   * Whether the observation passed the extraction judge
   * (`extraction-judge.ts`). When `false`, the observation was
   * captured for telemetry but not persisted as a primitive.
   */
  judgeAccepted?: boolean;
  /** Optional reason the judge gave when rejecting. */
  judgeRejectionReason?: string;
  /**
   * Id of the resulting `MemoryFile` primitive once consolidation runs.
   * Absent until consolidation decides to ADD/MERGE/UPDATE the
   * observation into the corpus.
   */
  resultingPrimitiveId?: string;
}

/** Ordered step for extracted procedure memories (issue #519). */
export interface ExtractedProcedureStep {
  order: number;
  intent: string;
  toolCall?: { kind: string; signature: string };
  expectedOutcome?: string;
  optional?: boolean;
}

export interface ExtractedFact {
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string[];
  entityRef?: string;
  source?: ExtractionPassSource;
  promptedByQuestion?: string;
  /**
   * Whether this fact is project-scoped or globally applicable.
   * When `extractionScopeClassificationEnabled` is true, the extraction LLM
   * classifies each fact. Default is `"project"` when a coding context is
   * active, `"global"` when no coding context is present.
   */
  scope?: MemoryScope;
  /** Structured key-value attributes extracted from the content (e.g., product attributes, dates, quantities). */
  structuredAttributes?: Record<string, string>;
  /** When category is `procedure`, ordered steps with intents (persisted under procedures/). */
  procedureSteps?: ExtractedProcedureStep[];
  /**
   * When category is `reasoning_trace`, the stored solution chain the user
   * walked through. Persisted under reasoning-traces/.
   */
  reasoningTrace?: ExtractedReasoningTrace;
}

export interface ExtractedReasoningTraceStep {
  order: number;
  description: string;
}

export interface ExtractedReasoningTrace {
  steps: ExtractedReasoningTraceStep[];
  finalAnswer: string;
  observedOutcome?: string;
}

export interface MemoryIntent {
  goal: string;
  actionType: string;
  entityTypes: string[];
  /** True when the prompt reads like starting a concrete task (ship/deploy/tests/PR, etc.). */
  taskInitiation?: boolean;
}

export interface ExtractedQuestion {
  question: string;
  context: string;
  priority: number;
}

export interface QuestionEntry {
  id: string;
  question: string;
  context: string;
  priority: number; // 0-1, higher = more important
  created: string;
  resolved: boolean;
  resolvedAt?: string;
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  profileUpdates: string[];
  entities: EntityMention[];
  questions: ExtractedQuestion[];
  identityReflection?: string;
  relationships?: ExtractedRelationship[];
}

export interface EntityMention {
  name: string;
  type: "person" | "project" | "tool" | "company" | "place" | "other";
  facts: string[];
  structuredSections?: EntityStructuredSection[];
  source?: ExtractionPassSource;
  promptedByQuestion?: string;
}

// ---------------------------------------------------------------------------
// Knowledge Graph Enhancement (Entity Relationships, Activity, Scoring)
// ---------------------------------------------------------------------------

export interface EntityRelationship {
  target: string;
  label: string;
}

export interface EntityActivityEntry {
  date: string;
  note: string;
}

export interface EntityTimelineEntry {
  timestamp: string;
  text: string;
  source?: string;
  sessionKey?: string;
  principal?: string;
}

export interface EntityStructuredSection {
  key: string;
  title: string;
  facts: string[];
}

export interface EntitySchemaSectionDefinition {
  key: string;
  title: string;
  description: string;
  aliases?: string[];
}

export interface EntitySchemaDefinition {
  sections: EntitySchemaSectionDefinition[];
}

export interface EntityFile {
  name: string;
  type: string;
  created?: string;
  updated: string;
  extraFrontmatterLines?: string[];
  preSectionLines?: string[];
  facts: string[];
  summary?: string;
  synthesis?: string;
  synthesisUpdatedAt?: string;
  synthesisTimelineCount?: number;
  synthesisStructuredFactCount?: number;
  synthesisStructuredFactDigest?: string;
  synthesisVersion?: number;
  timeline: EntityTimelineEntry[];
  structuredSections?: EntityStructuredSection[];
  relationships: EntityRelationship[];
  activity: EntityActivityEntry[];
  aliases: string[];
  extraSections?: Array<{
    title: string;
    lines: string[];
  }>;
}

export interface ScoredEntity {
  name: string;
  type: string;
  score: number;
  factCount: number;
  summary?: string;
  topRelationships: string[];
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  label: string;
  extractionSource?: ExtractionPassSource;
  promptedByQuestion?: string;
}

export interface ConsolidationItem {
  existingId: string;
  action: ConsolidationAction;
  mergeWith?: string;
  updatedContent?: string;
  reason: string;
}

export interface ConsolidationResult {
  items: ConsolidationItem[];
  profileUpdates: string[];
  entityUpdates: EntityMention[];
}

export interface ConsolidationObservation {
  runAt: string;
  recentMemories: MemoryFile[];
  existingMemories: MemoryFile[];
  profile: string;
  result: ConsolidationResult;
  merged: number;
  invalidated: number;
}

export interface QmdSearchResult {
  docid: string;
  path: string;
  snippet: string;
  score: number;
  line?: number;
  explain?: QmdSearchExplain;
  transport?: "daemon" | "subprocess" | "hybrid" | "scoped_prefilter";
}

export interface QmdSearchExplain {
  ftsScores?: number[];
  vectorScores?: number[];
  /** QMD 2.5 nested RRF `totalScore`, or legacy numeric RRF score. */
  rrf?: number;
  rrfRank?: number;
  rrfPositionScore?: number;
  rrfBaseScore?: number;
  rrfTopRankBonus?: number;
  rerankScore?: number;
  blendedScore?: number;
  /** Additive boost applied from `reinforcement_count` frontmatter (issue #687 PR 3/4). */
  reinforcementBoost?: number;
}

export interface MetaState {
  extractionCount: number;
  lastExtractionAt: string | null;
  lastConsolidationAt: string | null;
  totalMemories: number;
  totalEntities: number;
  processedExtractionFingerprints?: Array<{
    fingerprint: string;
    observedAt: string;
  }>;
}

export type MemoryActionType =
  | "store_episode"
  | "store_note"
  | "update_note"
  | "create_artifact"
  | "summarize_node"
  | "discard"
  | "link_graph";

export type MemoryActionOutcome = "applied" | "skipped" | "failed";

export type MemoryActionPolicyDecision = "allow" | "defer" | "deny";

export type MemoryActionStatus = "validated" | "applied" | "rejected";

export type MemoryActionEligibilitySource =
  | "extraction"
  | "consolidation"
  | "replay"
  | "manual"
  | "unknown";

export interface MemoryActionEligibilityContext {
  confidence: number;
  lifecycleState: LifecycleState;
  importance: number;
  source: MemoryActionEligibilitySource;
}

export interface MemoryActionPolicyResult {
  action: MemoryActionType;
  decision: MemoryActionPolicyDecision;
  rationale: string;
  eligibility: MemoryActionEligibilityContext;
}

export interface MemoryActionEvent {
  schemaVersion?: number;
  actionId?: string;
  timestamp: string;
  action: MemoryActionType;
  outcome: MemoryActionOutcome;
  status?: MemoryActionStatus;
  actor?: string;
  subsystem?: string;
  reason?: string;
  memoryId?: string;
  namespace?: string;
  sessionKey?: string;
  sourceSessionKey?: string;
  checkpointCapturedAt?: string;
  checkpointTtl?: string;
  checkpointTurnCount?: number;
  inputSummary?: string;
  outputMemoryIds?: string[];
  dryRun?: boolean;
  policyVersion?: string;
  promptHash?: string;
  policyDecision?: MemoryActionPolicyDecision;
  policyRationale?: string;
  policyEligibility?: MemoryActionEligibilityContext;
}

export type MemoryLifecycleEventType =
  | "created"
  | "updated"
  | "superseded"
  | "archived"
  | "rejected"
  | "restored"
  | "merged"
  | "imported"
  | "promoted"
  | "explicit_capture_accepted"
  | "explicit_capture_queued";

export interface MemoryLifecycleStateSummary {
  category?: MemoryCategory;
  path?: string;
  status?: MemoryStatus;
  lifecycleState?: LifecycleState;
}

export interface MemoryLifecycleEvent {
  eventId: string;
  memoryId: string;
  eventType: MemoryLifecycleEventType;
  timestamp: string;
  actor: string;
  reasonCode?: string;
  ruleVersion: string;
  relatedMemoryIds?: string[];
  before?: MemoryLifecycleStateSummary;
  after?: MemoryLifecycleStateSummary;
  correlationId?: string;
}

export interface MemoryProjectionCurrentState {
  memoryId: string;
  category: MemoryCategory;
  status: MemoryStatus;
  lifecycleState?: LifecycleState;
  path: string;
  pathRel: string;
  created: string;
  updated: string;
  archivedAt?: string;
  supersededAt?: string;
  entityRef?: string;
  source: string;
  confidence: number;
  confidenceTier: ConfidenceTier;
  memoryKind?: MemoryFrontmatter["memoryKind"];
  accessCount?: number;
  lastAccessed?: string;
  tags?: string[];
  preview?: string;
}

export interface CompressionGuidelineOptimizerSourceWindow {
  from: string;
  to: string;
}

export interface CompressionGuidelineOptimizerEventCounts {
  total: number;
  applied: number;
  skipped: number;
  failed: number;
}

export type CompressionGuidelineActivationState = "draft" | "active";

export interface CompressionGuidelineOptimizerActionSummary {
  action: MemoryActionType;
  total: number;
  outcomes: Record<MemoryActionOutcome, number>;
  quality: {
    good: number;
    poor: number;
    unknown: number;
  };
}

export interface CompressionGuidelineOptimizerRuleUpdate {
  action: MemoryActionType;
  delta: number;
  direction: "increase" | "decrease" | "hold";
  confidence: "low" | "medium" | "high";
  notes: string[];
}

export interface CompressionGuidelineOptimizerState {
  version: number;
  updatedAt: string;
  sourceWindow: CompressionGuidelineOptimizerSourceWindow;
  eventCounts: CompressionGuidelineOptimizerEventCounts;
  guidelineVersion: number;
  contentHash?: string;
  activationState?: CompressionGuidelineActivationState;
  actionSummaries?: CompressionGuidelineOptimizerActionSummary[];
  ruleUpdates?: CompressionGuidelineOptimizerRuleUpdate[];
}

export type ContinuityIncidentState = "open" | "closed";

export interface ContinuityIncidentRecord {
  id: string;
  state: ContinuityIncidentState;
  openedAt: string;
  updatedAt: string;
  triggerWindow?: string;
  symptom: string;
  suspectedCause?: string;
  fixApplied?: string;
  verificationResult?: string;
  preventiveRule?: string;
  closedAt?: string;
  filePath?: string;
}

export interface ContinuityIncidentOpenInput {
  triggerWindow?: string;
  symptom: string;
  suspectedCause?: string;
}

export interface ContinuityIncidentCloseInput {
  fixApplied: string;
  verificationResult: string;
  preventiveRule?: string;
}

export type ContinuityLoopCadence = "daily" | "weekly" | "monthly" | "quarterly";
export type ContinuityLoopStatus = "active" | "paused" | "retired";

export interface ContinuityImprovementLoop {
  id: string;
  cadence: ContinuityLoopCadence;
  purpose: string;
  status: ContinuityLoopStatus;
  killCondition: string;
  lastReviewed: string;
  notes?: string;
}

export interface ContinuityLoopUpsertInput {
  id: string;
  cadence: ContinuityLoopCadence;
  purpose: string;
  status: ContinuityLoopStatus;
  killCondition: string;
  lastReviewed?: string;
  notes?: string;
}

export interface ContinuityLoopReviewInput {
  status?: ContinuityLoopStatus;
  notes?: string;
  reviewedAt?: string;
}

/** Entry in the access tracking buffer (batched updates) */
export interface AccessTrackingEntry {
  memoryId: string;
  newCount: number;
  lastAccessed: string;
}

export interface SignalScanResult {
  level: SignalLevel;
  patterns: string[];
}

// ============================================================================
// LLM Trace Callback (for external observability plugins)
// ============================================================================

export interface LlmTraceEvent {
  kind: "llm_start" | "llm_end" | "llm_error";
  traceId: string;
  model: string;
  operation: "extraction" | "consolidation" | "profile_consolidation" | "identity_consolidation" | "day_summary";
  input?: string;
  output?: string;
  durationMs?: number;
  error?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
}

export interface RecallTraceEvent {
  kind: "recall_summary";
  traceId: string;
  operation: "recall";
  sessionKey?: string;
  promptHash: string;
  promptLength: number;
  retrievalQueryHash: string;
  retrievalQueryLength: number;
  recallMode: RecallPlanMode;
  recallResultLimit: number;
  qmdEnabled: boolean;
  qmdAvailable: boolean;
  recallNamespaces: string[];
  source: "none" | "hot_qmd" | "hot_embedding" | "cold_fallback" | "recent_scan";
  recalledMemoryCount: number;
  injected: boolean;
  contextChars: number;
  policyVersion?: string;
  identityInjectionMode?: IdentityInjectionMode | "none";
  identityInjectedChars?: number;
  identityInjectionTruncated?: boolean;
  durationMs: number;
  timings?: Record<string, string>;
  /**
   * The full recalled memory context added to the runtime context.
   * Only populated when `traceRecallContent` config option is `true`.
   * Omitted by default to avoid sending potentially sensitive memory content
   * to external trace collectors unless explicitly opted in.
   */
  recalledContent?: string;
}

export type EngramTraceEvent = LlmTraceEvent | RecallTraceEvent;
export type LlmTraceCallback = (event: EngramTraceEvent) => void;

// ============================================================================
// Gateway Configuration Types (for fallback AI)
// ============================================================================

export type ModelApi =
  | "openai-completions"
  | "anthropic-messages"
  | "google-generative"
  | "codex-cli"
  | string;
export type CodexCliReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type ModelProviderAuthMode = "bearer" | "header" | "query";

export interface ModelDefinitionConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  aliases?: string[];
}

export interface ModelProviderConfig {
  baseUrl: string;
  apiKey?: string | Record<string, unknown>;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  disableThinking?: boolean;
  executable?: string;
  reasoningEffort?: CodexCliReasoningEffort;
  codexCliExecutable?: string;
  codexCliReasoningEffort?: CodexCliReasoningEffort;
  retryOptions?: {
    timeoutMs?: number;
  };
  models: ModelDefinitionConfig[];
}

export interface AgentDefaultsConfig {
  model?: {
    primary?: string;
    backup?: string;
    fallbacks?: string[];
  };
  thinking?: {
    mode?: "off" | "on" | "adaptive";
    budget?: number;
  };
}

export interface AgentPersonaModelConfig {
  primary?: string;
  fallbacks?: string[];
}

export interface AgentPersona {
  id: string;
  name?: string;
  model?: AgentPersonaModelConfig;
}

export interface GatewayConfig {
  agents?: {
    defaults?: AgentDefaultsConfig;
    list?: AgentPersona[];
  };
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
}

// ============================================================================
// Transcript & Context Preservation (v2.0)
// ============================================================================

export interface TranscriptEntry {
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  sessionKey: string;
  turnId: string;
  metadata?: {
    compactAfter?: boolean;
    compactionId?: string | null;
  };
}

export interface Checkpoint {
  sessionKey: string;
  capturedAt: string;
  turns: TranscriptEntry[];
  ttl: string; // ISO timestamp when checkpoint expires
}

export interface HourlySummary {
  hour: string; // "2026-02-08T14:00:00Z"
  sessionKey: string;
  bullets: string[];
  turnCount: number;
  generatedAt: string;
}

// ============================================================================
// Dreams Pipeline Telemetry (issue #678 PR 3/4)
// ============================================================================

// Re-export from the authoritative source to avoid duplicate definitions.
// dreams-ledger.ts is the single source of truth; types.ts re-exports so
// callers that import from types.js continue to work unchanged.
export type {
  DreamsPhase,
  DreamsPhaseStatus,
  DreamsStatusResult,
  DreamsRunResult,
} from "./maintenance/dreams-ledger.js";
